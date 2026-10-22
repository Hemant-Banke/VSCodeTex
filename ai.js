'use strict';

// AI writing help: rewrite a passage, generate LaTeX at the cursor, fix a compile error.
//
// Providers: GitHub Copilot (or any extension's model) through VS Code's Language Model API; the
// Claude Code and Codex CLIs, which use the person's own Claude or ChatGPT subscription; and any
// OpenAI-compatible endpoint (Ollama, LM Studio, OpenRouter, Groq, vLLM, OpenAI itself).
// Results land as tracked changes by default, so they can be accepted or rejected like a
// collaborator's suggestion.

const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const project = require('./project');
const review = require('./review');
const { searchPath, which } = require('./tools');

const LATEX = [{ language: 'latex' }, { language: 'tex' }];
const isTex = (doc) => doc && (doc.languageId === 'latex' || doc.languageId === 'tex');
const config = () => vscode.workspace.getConfiguration('texPreview');
let secrets;

// ---------------------------------------------------------------------------
// Providers

/** Runs a CLI with `input` on stdin; resolves with stdout. */
function runCli(bin, args, input, token) {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, { cwd: os.tmpdir(), env: { ...process.env, PATH: searchPath() } });
    let stdout = '';
    let stderr = '';
    const sub = token.onCancellationRequested(() => proc.kill());
    proc.stdout.on('data', (d) => (stdout += d));
    proc.stderr.on('data', (d) => (stderr += d));
    proc.on('error', (e) => reject(e));
    proc.on('close', (code) => {
      sub.dispose();
      if (token.isCancellationRequested) resolve(null);
      else if (code !== 0) reject(new Error(`${path.basename(bin)} exited with ${code}: ${(stderr || stdout).trim().slice(-400)}`));
      else resolve(stdout);
    });
    proc.stdin.end(input);
  });
}

const PROVIDERS = {
  copilot: {
    label: '$(copilot) GitHub Copilot',
    description: 'and other VS Code language models',
    async models() {
      return vscode.lm ? (await vscode.lm.selectChatModels()).map((m) => ({ id: m.id, label: m.name || m.id, description: m.vendor })) : [];
    },
    async run(system, prompt, token) {
      if (!vscode.lm) throw new Error('needs VS Code 1.90 or later');
      const want = config().get('ai.model');
      let models = await vscode.lm.selectChatModels(want ? {} : { vendor: 'copilot' });
      if (want) models = models.filter((m) => m.id === want || m.family === want || m.name === want);
      if (!models.length) throw new Error(want ? `no language model "${want}" is available` : 'no Copilot models are available. Install GitHub Copilot Chat and sign in, or choose another provider');
      const res = await models[0].sendRequest([vscode.LanguageModelChatMessage.User(`${system}\n\n${prompt}`)], { justification: 'TeX Preview sends the passage you picked and nearby text to rewrite or write LaTeX.' }, token);
      let out = '';
      for await (const t of res.text) out += t;
      return out;
    },
  },
  claude: {
    label: '$(terminal) Claude',
    description: 'Claude Code CLI, uses your Claude subscription',
    available: () => !!which('claude'),
    models: async () => [
      { id: 'sonnet', label: 'Sonnet', description: 'fast and capable' },
      { id: 'opus', label: 'Opus', description: 'most capable' },
      { id: 'haiku', label: 'Haiku', description: 'fastest' },
    ],
    async run(system, prompt, token) {
      const bin = which('claude');
      if (!bin) throw new Error('the Claude Code CLI (`claude`) was not found. Install it from https://claude.com/claude-code and run `claude` once to sign in');
      const model = config().get('ai.model');
      // No tools, MCP servers or saved session: a plain completion.
      const args = ['-p', '--output-format', 'text', '--tools', '', '--no-session-persistence', '--strict-mcp-config', '--system-prompt', system, ...(model ? ['--model', model] : [])];
      return runCli(bin, args, prompt, token);
    },
  },
  codex: {
    label: '$(terminal) ChatGPT',
    description: 'Codex CLI, uses your ChatGPT plan',
    available: () => !!which('codex'),
    models: async () => [],
    async run(system, prompt, token) {
      const bin = which('codex');
      if (!bin) throw new Error('the Codex CLI (`codex`) was not found. Install it (npm i -g @openai/codex) and run `codex login`');
      const model = config().get('ai.model');
      const out = path.join(os.tmpdir(), `texpreview-codex-${process.pid}-${Date.now()}.txt`);
      const args = ['exec', '--skip-git-repo-check', '--sandbox', 'read-only', '--color', 'never', '--output-last-message', out, ...(model ? ['-m', model] : []), '-'];
      const stdout = await runCli(bin, args, `${system}\n\n${prompt}`, token);
      try {
        return fs.readFileSync(out, 'utf8');
      } catch {
        return stdout;
      } finally {
        fs.rm(out, { force: true }, () => {});
      }
    },
  },
  openai: {
    label: '$(server) OpenAI-compatible API',
    description: 'Ollama, LM Studio, OpenRouter, Groq, vLLM, OpenAI…',
    base: () => (config().get('ai.baseUrl') || 'http://localhost:11434/v1').replace(/\/+$/, ''),
    async headers() {
      const key = await secrets.get('texPreview.ai.apiKey');
      return { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) };
    },
    async models() {
      const res = await fetch(`${this.base()}/models`, { headers: await this.headers(), signal: AbortSignal.timeout(10000) });
      if (!res.ok) throw new Error(`${this.base()}/models: ${res.status}`);
      return ((await res.json()).data || []).map((m) => ({ id: m.id, label: m.id }));
    },
    async run(system, prompt, token) {
      let model = config().get('ai.model');
      if (!model) model = await pickModel('openai');
      if (!model) return null;
      const ctrl = new AbortController();
      const sub = token.onCancellationRequested(() => ctrl.abort());
      let res;
      try {
        res = await fetch(`${this.base()}/chat/completions`, {
          method: 'POST',
          headers: await this.headers(),
          body: JSON.stringify({ model, temperature: 0.2, messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }] }),
          signal: ctrl.signal,
        });
      } catch (e) {
        if (token.isCancellationRequested) return null;
        throw new Error(`couldn't reach ${this.base()} (${e.cause?.code || e.message}). Is the server running?`);
      } finally {
        sub.dispose();
      }
      if (!res.ok) throw new Error(`${this.base()} answered ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const content = (await res.json()).choices?.[0]?.message?.content || '';
      return content.replace(/<think>[\s\S]*?<\/think>\s*/g, ''); // reasoning models
    },
  },
};

const ENDPOINTS = [
  { label: 'Ollama', detail: 'http://localhost:11434/v1' },
  { label: 'LM Studio', detail: 'http://localhost:1234/v1' },
  { label: 'OpenRouter', detail: 'https://openrouter.ai/api/v1' },
  { label: 'Groq', detail: 'https://api.groq.com/openai/v1' },
  { label: 'OpenAI', detail: 'https://api.openai.com/v1' },
  { label: 'Other…', detail: '' },
];

const MODEL_EXAMPLES = { claude: 'e.g. sonnet, opus or a full model id', codex: 'e.g. gpt-5-codex', openai: 'e.g. llama3.1, qwen2.5:14b or anthropic/claude-sonnet-4', copilot: 'a model id or family' };

/** Picks a model for `provider` from its list, its default, or a name typed in; saves it. */
async function pickModel(provider) {
  let models = [];
  try {
    models = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: 'Listing AI models…' }, () => PROVIDERS[provider].models());
  } catch (e) {
    vscode.window.showWarningMessage(`AI: couldn't list the models (${e.message}). You can type a model name.`);
  }
  const current = config().get('ai.model') || '';
  const items = [
    ...(provider === 'openai' ? [] : [{ id: '', label: 'Default', description: provider === 'copilot' ? 'let Copilot choose' : "the CLI's default" }]),
    ...models,
    { id: null, label: '$(edit) Other…', description: 'type a model name' },
  ].map((i) => (i.id === current && i.id !== null ? { ...i, description: `${i.description || ''} (current)`.trim() } : i));
  const picked = await vscode.window.showQuickPick(items, { title: `AI model: ${PROVIDERS[provider].label.replace(/\$\([^)]*\)\s*/, '')}`, matchOnDescription: true, ignoreFocusOut: true });
  if (!picked) return null;
  let id = picked.id;
  if (id === null) {
    id = await vscode.window.showInputBox({ title: 'AI model', prompt: `Model name (${MODEL_EXAMPLES[provider]})`, value: current, ignoreFocusOut: true });
    if (id === undefined) return null;
  }
  await config().update('ai.model', id || undefined, vscode.ConfigurationTarget.Global);
  return id;
}

/** Changes the model of the current provider (asking for a provider first if none is set). */
async function chooseModel() {
  const id = config().get('ai.provider');
  if (!PROVIDERS[id]) return chooseProvider();
  return pickModel(id);
}

/** The AI actions and settings in one place (the ✨ button in the editor title bar). */
async function showMenu() {
  const id = config().get('ai.provider');
  const p = PROVIDERS[id];
  const model = config().get('ai.model');
  const items = [
    { label: '$(wand) Write with AI…', description: '⌃L G · describe what to write at the cursor', command: 'texPreview.ai.generate' },
    { label: '$(sparkle) Rewrite with AI…', description: '⌃L ⇧G · improve, shorten, formalise the selection or paragraph', command: 'texPreview.ai.rewrite' },
    { label: '$(comment-discussion) Review with AI…', description: '⌃L V · comments with suggested changes, like a co-author', command: 'texPreview.ai.review' },
    { label: '$(debug-alt) Fix Compile Error with AI', description: 'the error nearest the cursor', command: 'texPreview.ai.fixError' },
    { label: '', kind: vscode.QuickPickItemKind.Separator },
    { label: '$(plug) Choose AI Provider…', description: p ? p.label.replace(/\$\([^)]*\)\s*/, '') : 'not set', command: 'texPreview.ai.chooseProvider' },
    { label: '$(symbol-misc) Change AI Model…', description: p ? model || 'default' : '', command: 'texPreview.ai.chooseModel' },
    ...(id === 'openai' ? [{ label: '$(key) Set API Key…', description: config().get('ai.baseUrl'), command: 'texPreview.ai.setApiKey' }] : []),
  ];
  if (process.platform !== 'darwin') items.forEach((i) => i.description && (i.description = i.description.replace('⌃L ⇧G', 'Alt+L Shift+G').replace('⌃L G', 'Alt+L G').replace('⌃L V', 'Alt+L V')));
  const picked = await vscode.window.showQuickPick(items, { title: 'AI', matchOnDescription: true });
  if (picked?.command) vscode.commands.executeCommand(picked.command);
}

async function chooseProvider() {
  const items = Object.entries(PROVIDERS).map(([id, p]) => ({
    id,
    label: p.label,
    description: p.available && !p.available() ? `${p.description} (not installed)` : p.description,
    picked: config().get('ai.provider') === id,
  }));
  const picked = await vscode.window.showQuickPick(items, { title: 'AI provider for TeX Preview', ignoreFocusOut: true });
  if (!picked) return null;
  await config().update('ai.provider', picked.id, vscode.ConfigurationTarget.Global);
  await config().update('ai.model', undefined, vscode.ConfigurationTarget.Global);
  if (picked.id === 'copilot' && vscode.lm) await pickModel('copilot');
  if (picked.id === 'claude' || picked.id === 'codex') {
    if (!PROVIDERS[picked.id].available()) vscode.window.showWarningMessage(picked.id === 'claude' ? 'AI: install Claude Code (https://claude.com/claude-code) and run `claude` once to sign in.' : 'AI: install the Codex CLI (npm i -g @openai/codex) and run `codex login`.');
    else await pickModel(picked.id);
  }
  if (picked.id === 'openai') {
    const ep = await vscode.window.showQuickPick(ENDPOINTS, { title: 'OpenAI-compatible endpoint', ignoreFocusOut: true });
    if (!ep) return null;
    const base = ep.detail || (await vscode.window.showInputBox({ title: 'Base URL', prompt: 'The URL that /chat/completions is under', value: 'http://localhost:8000/v1', ignoreFocusOut: true }));
    if (!base) return null;
    await config().update('ai.baseUrl', base, vscode.ConfigurationTarget.Global);
    if (!/\/\/(localhost|127\.0\.0\.1)[:/]/.test(base)) await setApiKey();
    await pickModel('openai');
  }
  return picked.id;
}

async function setApiKey() {
  const key = await vscode.window.showInputBox({ title: 'API key for the OpenAI-compatible endpoint', prompt: 'Stored in VS Code secret storage. Leave empty to remove.', password: true, ignoreFocusOut: true });
  if (key === undefined) return;
  if (key) await secrets.store('texPreview.ai.apiKey', key);
  else await secrets.delete('texPreview.ai.apiKey');
}

/** The model's reply to `prompt`, with progress and cancel; null if cancelled or failed. */
async function complete(title, system, prompt) {
  let id = config().get('ai.provider');
  if (!PROVIDERS[id]) id = await chooseProvider();
  if (!id) return null;
  return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title, cancellable: true }, async (_, token) => {
    try {
      const out = await PROVIDERS[id].run(system, prompt, token);
      return token.isCancellationRequested ? null : out;
    } catch (e) {
      if (token.isCancellationRequested) return null;
      const choice = await vscode.window.showErrorMessage(`AI (${id}): ${e.message}`, 'Choose Provider…');
      if (choice) chooseProvider();
      return null;
    }
  });
}

// ---------------------------------------------------------------------------
// Prompts

const SYSTEM = `You are a LaTeX writing assistant inside VS Code, editing the source of an academic document.
Rules:
- Return LaTeX source, never rendered text and never Markdown.
- Keep the author's commands, macros, \\label, \\ref and \\cite keys, and math unless asked to change them.
- Never invent citations, data, results or references.
- Keep the document's language and spelling conventions (e.g. British or American English).
- Put your output inside <latex></latex> tags, with nothing else outside the tags unless asked.`;

/** Package, macro and theorem definitions of the project's preamble. */
function preamble(doc) {
  let text = doc.getText();
  if (doc.uri.scheme === 'file') {
    const root = project.findRoot(doc.uri.fsPath);
    if (root !== doc.uri.fsPath) text = project.read(root)?.text || text;
  }
  const b = text.indexOf('\\begin{document}');
  const head = b >= 0 ? text.slice(0, b) : '';
  const lines = head.split('\n').filter((l) => /^\s*\\(documentclass|usepackage|RequirePackage|newcommand|renewcommand|providecommand|DeclareMathOperator|newtheorem|def\b|let\b)/.test(l));
  return lines.join('\n').slice(0, 4000);
}

function surroundings(doc, range, before = 3000, after = 1500) {
  const text = doc.getText();
  const a = doc.offsetAt(range.start);
  const b = doc.offsetAt(range.end);
  return { before: text.slice(Math.max(0, a - before), a), after: text.slice(b, b + after) };
}

function extract(reply, tag = 'latex') {
  const m = new RegExp(`<${tag}>\\n?([\\s\\S]*?)\\n?</${tag}>`).exec(reply);
  if (m) return m[1];
  if (tag !== 'latex') return null;
  // Models sometimes ignore the tags: take the reply without a code fence.
  return reply.trim().replace(/^```(?:latex|tex)?\s*\n/, '').replace(/\n```$/, '');
}

// ---------------------------------------------------------------------------
// Applying results

/**
 * Replaces `range` with `text`, editing only the words that changed, as a tracked change when
 * texPreview.ai.trackChanges is on. Returns the range of the new text.
 */
async function applyResult(doc, range, text) {
  const old = doc.getText(range);
  if (old.endsWith('\n') && !text.endsWith('\n')) text += '\n';
  let p = 0;
  while (p < old.length && p < text.length && old[p] === text[p]) p++;
  let q = 0;
  while (q < old.length - p && q < text.length - p && old[old.length - 1 - q] === text[text.length - 1 - q]) q++;
  // Snap to whole words so the tracked change reads well.
  while (p > 0 && /\S/.test(old[p - 1])) p--;
  while (q > 0 && /\S/.test(old[old.length - q])) q--;
  const a = doc.offsetAt(range.start);
  const r = new vscode.Range(doc.positionAt(a + p), doc.positionAt(a + old.length - q));
  const ins = text.slice(p, text.length - q);
  const tracked = config().get('ai.trackChanges') && doc.uri.scheme === 'file';
  let ok;
  if (tracked) ok = await review.suggest(doc, r, ins);
  else {
    const edit = new vscode.WorkspaceEdit();
    edit.replace(doc.uri, r, ins);
    ok = await vscode.workspace.applyEdit(edit);
  }
  if (!ok) return null;
  const start = doc.positionAt(a + p);
  const end = doc.positionAt(a + text.length - q);
  if (tracked) vscode.window.setStatusBarMessage('AI edit added as a tracked change: accept or reject it from the lightbulb or the Review menu', 6000);
  return new vscode.Range(start, end);
}

/** The paragraph around `pos`: lines up to the nearest blank lines. */
function paragraphAt(doc, pos) {
  const blank = (l) => /^\s*$/.test(doc.lineAt(l).text);
  if (blank(pos.line)) return null;
  let a = pos.line;
  let b = pos.line;
  while (a > 0 && !blank(a - 1)) a--;
  while (b < doc.lineCount - 1 && !blank(b + 1)) b++;
  return new vscode.Range(a, 0, b, doc.lineAt(b).text.length);
}

// ---------------------------------------------------------------------------
// Commands

const REWRITES = [
  { label: '$(sparkle) Improve writing', detail: 'Clearer and more fluent, same meaning and length', instr: 'Improve the clarity, flow and style of the passage. Keep its meaning, technical content and roughly its length.' },
  { label: '$(check) Fix grammar and spelling', detail: 'Change nothing else', instr: 'Fix grammar, spelling and punctuation only. Change nothing else.' },
  { label: '$(fold) Make concise', detail: 'Shorter, same content', instr: 'Make the passage more concise without losing any content.' },
  { label: '$(law) Make more formal', detail: 'Academic register', instr: 'Rewrite the passage in a formal academic register.' },
  { label: '$(lightbulb) Simplify', detail: 'Easier to read', instr: 'Rewrite the passage so it is easier to understand, with simpler sentences.' },
  { label: '$(unfold) Expand', detail: 'More detail and explanation', instr: 'Expand the passage with more explanation, consistent with the surrounding text. Do not invent results, data or citations.' },
  { label: '$(code) Fix LaTeX', detail: 'Markup only, same wording', instr: 'Fix LaTeX mistakes and bad practice (unbalanced braces, wrong environments, missing ~ before \\cite and \\ref, straight quotes) without changing the wording.' },
  { label: '$(edit) Custom instruction…', custom: true },
];

async function rewrite(editor, preset) {
  const doc = editor.document;
  const range = editor.selection.isEmpty ? paragraphAt(doc, editor.selection.active) : editor.selection;
  if (!range) return vscode.window.showInformationMessage('AI: select the text to rewrite, or put the cursor in a paragraph.');
  let instr = typeof preset === 'string' ? preset : null;
  if (!instr) {
    const picked = await vscode.window.showQuickPick(REWRITES, { title: 'Rewrite with AI', matchOnDetail: true });
    if (!picked) return;
    instr = picked.custom ? await vscode.window.showInputBox({ title: 'Rewrite with AI', prompt: 'How should the passage change?', placeHolder: 'e.g. turn into an itemize list, use the active voice, add a sentence on limitations' }) : picked.instr;
    if (!instr) return;
  }
  const passage = doc.getText(range);
  const around = surroundings(doc, range);
  const prompt = `Preamble of the document:\n<preamble>\n${preamble(doc)}\n</preamble>\n\nText before the passage:\n<before>\n${around.before}\n</before>\n\nThe passage:\n<passage>\n${passage}\n</passage>\n\nText after the passage:\n<after>\n${around.after}\n</after>\n\nTask: ${instr}\nReturn only the new version of the passage inside <latex></latex>.`;
  const reply = await complete('AI: rewriting…', SYSTEM, prompt);
  if (reply == null) return;
  const text = extract(reply);
  if (doc.getText(range) !== passage) return vscode.window.showWarningMessage('AI: the passage changed while the model was working; nothing was replaced.');
  if (text.trim() === passage.trim()) return vscode.window.showInformationMessage('AI: no changes suggested.');
  const r = await applyResult(doc, range, text);
  if (r) editor.selection = new vscode.Selection(r.start, r.end);
}

const REQUIRES = /^%\s*requires\s+\\usepackage(\[[^\]]*\])?\{([^}]+)\}\s*\n?/gm;

async function generate(editor, request) {
  const doc = editor.document;
  const what = typeof request === 'string' ? request : await vscode.window.showInputBox({
    title: 'Write with AI',
    prompt: editor.selection.isEmpty ? 'What should be written at the cursor?' : 'What should be written after the selection? (The selection is sent as reference.)',
    placeHolder: 'e.g. a booktabs table comparing the three methods, a TikZ flow chart of the pipeline, a paragraph motivating Section 3',
    ignoreFocusOut: true,
  });
  if (!what) return;
  const at = editor.selection.end;
  const around = surroundings(doc, new vscode.Range(at, at));
  const selected = editor.selection.isEmpty ? '' : `\nSelected text the request may refer to:\n<selection>\n${doc.getText(editor.selection)}\n</selection>\n`;
  const prompt = `Preamble of the document:\n<preamble>\n${preamble(doc)}\n</preamble>\n\nText before the cursor:\n<before>\n${around.before}\n</before>\n\nText after the cursor:\n<after>\n${around.after}\n</after>\n${selected}\nWrite LaTeX to insert at the cursor: ${what}\nUse packages and macros the preamble already loads where you can. If you need another package, start your output with one line per package: % requires \\usepackage{name}\nReturn only the text to insert, inside <latex></latex>.`;
  const reply = await complete('AI: writing…', SYSTEM, prompt);
  if (reply == null) return;
  let text = extract(reply);
  const pkgs = [...text.matchAll(REQUIRES)].map((m) => ({ opts: m[1] || '', name: m[2].trim() }));
  text = text.replace(REQUIRES, '');
  if (!text.trim()) return vscode.window.showInformationMessage('AI: the model returned nothing to insert.');
  const r = await applyResult(doc, new vscode.Range(at, at), text);
  if (r) editor.selection = new vscode.Selection(r.start, r.end);
  await offerPackages(doc, pkgs);
}

/** Offers to add the packages the generated text needs to the root file's preamble. */
async function offerPackages(doc, pkgs) {
  if (!pkgs.length || doc.uri.scheme !== 'file') return;
  const root = project.findRoot(doc.uri.fsPath);
  const rootDoc = await vscode.workspace.openTextDocument(root);
  const text = rootDoc.getText();
  const b = text.indexOf('\\begin{document}');
  if (b < 0) return;
  const loaded = (name) => new RegExp(`\\\\(usepackage|RequirePackage)\\s*(\\[[^\\]]*\\])?\\s*\\{[^}]*\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b[^}]*\\}`).test(text.slice(0, b));
  const missing = pkgs.filter((p) => !loaded(p.name));
  if (!missing.length) return;
  const names = missing.map((p) => p.name).join(', ');
  if ((await vscode.window.showInformationMessage(`The inserted LaTeX uses ${names}, which the preamble doesn't load.`, 'Add to Preamble')) !== 'Add to Preamble') return;
  const edit = new vscode.WorkspaceEdit();
  edit.insert(rootDoc.uri, rootDoc.positionAt(b), missing.map((p) => `\\usepackage${p.opts}{${p.name}}\n`).join(''));
  await vscode.workspace.applyEdit(edit);
}

/** A compile error in `doc`: the one given, else the nearest to the cursor. */
function errorAt(doc, diagnostic) {
  if (diagnostic) return diagnostic;
  const errs = vscode.languages.getDiagnostics(doc.uri).filter((d) => d.source === 'LaTeX' && d.severity === vscode.DiagnosticSeverity.Error);
  const line = vscode.window.activeTextEditor?.selection.active.line ?? 0;
  return errs.sort((x, y) => Math.abs(x.range.start.line - line) - Math.abs(y.range.start.line - line))[0];
}

async function fixError(uri, diagnostic) {
  const doc = uri ? await vscode.workspace.openTextDocument(uri) : vscode.window.activeTextEditor?.document;
  if (!doc) return;
  const d = errorAt(doc, diagnostic);
  if (!d) return vscode.window.showInformationMessage('AI: no LaTeX compile errors in this file.');
  const line = Math.min(d.range.start.line, doc.lineCount - 1);
  const a = Math.max(0, line - 15);
  const b = Math.min(doc.lineCount - 1, line + 15);
  const range = new vscode.Range(a, 0, b, doc.lineAt(b).text.length);
  const excerpt = doc.getText(range);
  const prompt = `Preamble of the document:\n<preamble>\n${preamble(doc)}\n</preamble>\n\nCompiling the document failed with:\n<error>\n${d.message}\n</error>\nThe error was reported at line ${line + 1} of the file, which is line ${line - a + 1} of this excerpt:\n<excerpt>\n${excerpt}\n</excerpt>\n\nFix the cause of the error with the smallest change. The error may be caused earlier than the reported line. If the fix belongs outside the excerpt (for example a missing package), leave the excerpt unchanged and say so.\nReturn the whole corrected excerpt inside <latex></latex>, then one sentence explaining the fix inside <why></why>.`;
  const reply = await complete('AI: fixing the error…', SYSTEM.replace('with nothing else outside the tags unless asked', 'and anything else only where asked'), prompt);
  if (reply == null) return;
  const text = extract(reply);
  const why = extract(reply, 'why');
  if (doc.getText(range) !== excerpt) return vscode.window.showWarningMessage('AI: the file changed while the model was working; nothing was replaced.');
  if (text.trim() === excerpt.trim()) return vscode.window.showInformationMessage(`AI: no change to this part of the file. ${why || ''}`);
  const r = await applyResult(doc, range, text);
  if (r) {
    const ed = await vscode.window.showTextDocument(doc);
    ed.revealRange(r, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    if (why) vscode.window.showInformationMessage(`AI: ${why}`);
  }
}

class FixActions {
  provideCodeActions(doc, range, ctx) {
    return ctx.diagnostics
      .filter((d) => d.source === 'LaTeX' && d.severity === vscode.DiagnosticSeverity.Error)
      .slice(0, 1)
      .map((d) => {
        const a = new vscode.CodeAction('Fix with AI', vscode.CodeActionKind.QuickFix);
        a.command = { command: 'texPreview.ai.fixError', title: 'Fix with AI', arguments: [doc.uri, d] };
        a.diagnostics = [d];
        return a;
      });
  }
}

function activate(context) {
  secrets = context.secrets;
  const reg = (id, fn) =>
    context.subscriptions.push(
      vscode.commands.registerCommand(id, (...args) => {
        const editor = vscode.window.activeTextEditor;
        if (editor && isTex(editor.document)) return fn(editor, ...args);
        vscode.window.showInformationMessage('AI: open a .tex file first.');
      })
    );
  reg('texPreview.ai.rewrite', rewrite);
  reg('texPreview.ai.generate', generate);
  context.subscriptions.push(
    vscode.commands.registerCommand('texPreview.ai.fixError', fixError),
    vscode.commands.registerCommand('texPreview.ai.chooseProvider', chooseProvider),
    vscode.commands.registerCommand('texPreview.ai.chooseModel', chooseModel),
    vscode.commands.registerCommand('texPreview.ai.menu', showMenu),
    vscode.commands.registerCommand('texPreview.ai.setApiKey', setApiKey),
    vscode.languages.registerCodeActionsProvider(LATEX, new FixActions(), { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] })
  );
}

/** The current provider's name for display, e.g. "Claude (sonnet)". */
function providerName() {
  const p = PROVIDERS[config().get('ai.provider')];
  const model = config().get('ai.model');
  return p ? p.label.replace(/\$\([^)]*\)\s*/, '') + (model ? ` (${model})` : '') : 'AI';
}

module.exports = { activate, extract, applyResult, complete, preamble, providerName, SYSTEM };
