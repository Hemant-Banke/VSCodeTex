'use strict';

// Editing helpers that plug into VS Code's own mechanisms: commands with keybindings, Enter
// rules for \item, Format Document for .tex and .bib, and diagnostics from chktex and
// duplicate labels.

const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const os = require('os');
const project = require('./project');
const math = require('./math');
const { environments, envs, countWords, textStats } = require('./structure');
const { which, exec } = require('./tools');
const { ENVIRONMENTS } = require('./data');

const LATEX = [{ language: 'latex' }, { language: 'tex' }];
const isTex = (doc) => doc && (doc.languageId === 'latex' || doc.languageId === 'tex');
const config = () => vscode.workspace.getConfiguration('texPreview');

function activate(context) {
  // Plain commands rather than registerTextEditorCommand: these are async and make their own edits.
  const reg = (id, fn) =>
    context.subscriptions.push(
      vscode.commands.registerCommand(id, (args) => {
        const editor = vscode.window.activeTextEditor;
        if (editor) return fn(editor, args);
      })
    );
  reg('texPreview.wrap', wrap);
  for (const [id, args] of Object.entries(FORMATS)) reg(`texPreview.${id}`, (ed) => wrap(ed, args));
  reg('texPreview.wrapEnvironment', wrapEnvironment);
  reg('texPreview.closeEnvironment', closeEnvironment);
  reg('texPreview.toggleDisplayMath', toggleDisplayMath);
  reg('texPreview.gotoMatchingEnvironment', gotoMatching);
  reg('texPreview.endList', endList);
  reg('texPreview.wrapMath', wrapMath);
  reg('texPreview.promoteSection', (ed) => shiftSections(ed, -1));
  reg('texPreview.demoteSection', (ed) => shiftSections(ed, +1));
  reg('texPreview.toggleStar', toggleStar);
  context.subscriptions.push(vscode.commands.registerCommand('texPreview.wordCount', wordCount));
  wordCountStatus(context);
  menuContext(context);

  // Enter on a line starting with \item continues the list. (Enter on an empty \item ends it:
  // see the texPreview.emptyItem context key below.)
  context.subscriptions.push(
    vscode.languages.setLanguageConfiguration('latex', {
      onEnterRules: [
        {
          beforeText: /^\s*\\item\b(\[[^\]]*\])?\s*\S.*$/,
          action: { indentAction: vscode.IndentAction.None, appendText: '\\item ' },
        },
      ],
    })
  );
  let emptyItem = false;
  const updateEmptyItem = () => {
    const ed = vscode.window.activeTextEditor;
    const now = !!ed && isTex(ed.document) && ed.selections.length === 1 && ed.selection.isEmpty && /^\s*\\item(\[\])?\s*$/.test(ed.document.lineAt(ed.selection.active.line).text);
    if (now !== emptyItem) vscode.commands.executeCommand('setContext', 'texPreview.emptyItem', (emptyItem = now));
  };
  context.subscriptions.push(vscode.window.onDidChangeTextEditorSelection(updateEmptyItem), vscode.window.onDidChangeActiveTextEditor(updateEmptyItem));

  context.subscriptions.push(
    vscode.languages.registerDocumentFormattingEditProvider(LATEX, { provideDocumentFormattingEdits: (doc, opts) => formatTex(doc, opts) }),
    vscode.languages.registerDocumentRangeFormattingEditProvider(LATEX, { provideDocumentRangeFormattingEdits: (doc, range, opts) => indentEdits(doc, opts, range) }),
    vscode.languages.registerDocumentFormattingEditProvider({ language: 'bibtex' }, { provideDocumentFormattingEdits: (doc, opts) => formatBib(doc, opts) })
  );

  lint(context);
}

// ---------------------------------------------------------------------------
// Wrapping selections

/** Text formats with their own commands (keys and the LaTeX context menu); math variants inside math. */
const FORMATS = {
  bold: { cmd: 'textbf', mathCmd: 'mathbf' },
  italic: { cmd: 'textit', mathCmd: 'mathit' },
  emph: { cmd: 'emph' },
  typewriter: { cmd: 'texttt', mathCmd: 'mathtt' },
  underline: { cmd: 'underline' },
  smallCaps: { cmd: 'textsc' },
  footnote: { cmd: 'footnote' },
};

const COMMON_WRAPS = ['textbf', 'textit', 'emph', 'underline', 'texttt', 'textsc', 'textsf', 'textsuperscript', 'textsubscript', 'text', 'mathbf', 'mathrm', 'mathcal', 'mathbb', 'mathfrak', 'boldsymbol', 'operatorname', 'sqrt', 'hat', 'bar', 'tilde', 'vec', 'overline', 'boxed', 'footnote', 'marginpar', 'section', 'subsection', 'caption', 'label', 'ref', 'cite', 'url', 'href{}', 'textcolor{red}', 'mbox', 'fbox'];

/**
 * Wraps each selection in \cmd{…}, or unwraps it if it already is. In math, `mathCmd` is used
 * instead (Bold → \mathbf). With no command given, asks which one.
 */
async function wrap(editor, args = {}) {
  const doc = editor.document;
  let cmd = args.cmd;
  if (args.mathCmd && math.mathAt(doc, editor.selection.start, true)) cmd = args.mathCmd;
  if (!cmd) {
    const picked = await vscode.window.showQuickPick([...COMMON_WRAPS.map((c) => '\\' + c), 'Other…'], { placeHolder: 'Surround the selection with a command' });
    if (!picked) return;
    cmd = picked === 'Other…' ? await vscode.window.showInputBox({ prompt: 'Command name', placeHolder: 'textcolor{red}' }) : picked.slice(1);
    if (!cmd) return;
    cmd = cmd.replace(/^\\/, '');
  }

  // Already wrapped? (selection is \cmd{…}, or sits directly inside one) → unwrap.
  const open = `\\${cmd}{`;
  const spans = editor.selections.map((sel) => {
    const text = doc.getText(sel);
    if (text.startsWith(open) && text.endsWith('}')) return { outer: sel, inner: text.slice(open.length, -1) };
    const before = doc.getText(new vscode.Range(sel.start.translate(0, -Math.min(open.length, sel.start.character)), sel.start));
    const afterRange = new vscode.Range(sel.end, sel.end.translate(0, 1));
    if (!sel.isEmpty && before === open && doc.getText(afterRange) === '}') {
      return { outer: new vscode.Range(sel.start.translate(0, -open.length), afterRange.end), inner: text };
    }
    return null;
  });
  if (spans.every(Boolean)) {
    await editor.edit((e) => spans.forEach((s) => e.replace(s.outer, s.inner)));
    return;
  }
  await editor.insertSnippet(new vscode.SnippetString(`\\\\${cmd.replace(/[$}\\]/g, '\\$&')}{\${TM_SELECTED_TEXT}$0}`));
}

async function wrapEnvironment(editor) {
  const doc = editor.document;
  const file = doc.uri.scheme === 'file' ? doc.uri.fsPath : null;
  const names = [...new Set([...ENVIRONMENTS.map((e) => e[0]), ...(file ? project.project(file).envs : [])])];
  const env = await vscode.window.showQuickPick([...names, 'Other…'], { placeHolder: 'Surround the selection with an environment' });
  if (!env) return;
  const name = env === 'Other…' ? await vscode.window.showInputBox({ prompt: 'Environment name' }) : env;
  if (!name) return;

  const unit = editor.options.insertSpaces ? ' '.repeat(editor.options.tabSize) : '\t';
  if (editor.selections.every((s) => s.isEmpty)) {
    await editor.insertSnippet(new vscode.SnippetString(`\\\\begin{${name}}\n\t$0\n\\\\end{${name}}`));
    return;
  }
  await editor.edit((e) => {
    for (const sel of editor.selections) {
      const range = new vscode.Range(sel.start.line, 0, sel.end.character === 0 && sel.end.line > sel.start.line ? sel.end.line - 1 : sel.end.line, Number.MAX_SAFE_INTEGER);
      const lines = doc.getText(doc.validateRange(range)).split(/\r?\n/);
      const indent = lines[0].match(/^\s*/)[0];
      const body = lines.map((l) => (l.trim() ? unit + l : l)).join('\n');
      e.replace(doc.validateRange(range), `${indent}\\begin{${name}}\n${body}\n${indent}\\end{${name}}`);
    }
  });
}

function openEnvAt(doc, pos) {
  return environments(doc.getText().slice(0, doc.offsetAt(pos))).unclosed.pop();
}

async function closeEnvironment(editor) {
  const doc = editor.document;
  const pos = editor.selection.active;
  const open = openEnvAt(doc, pos);
  if (!open) {
    vscode.window.setStatusBarMessage('No open environment here', 2000);
    return;
  }
  const line = doc.lineAt(pos.line);
  const indent = doc.lineAt(doc.positionAt(open.start).line).text.match(/^\s*/)[0];
  await editor.edit((e) => {
    if (line.isEmptyOrWhitespace) e.replace(line.range, `${indent}\\end{${open.name}}`);
    else e.insert(pos, `\\end{${open.name}}`);
  });
}

/** \[ … \] ⇄ \begin{equation*} … \end{equation*} around the cursor. */
async function toggleDisplayMath(editor) {
  const doc = editor.document;
  const off = doc.offsetAt(editor.selection.active);
  const text = doc.getText();
  const span = math.mathSpans(text).find((s) => off >= s.start && off <= s.end);
  if (!span) return;
  const raw = text.slice(span.start, span.end);
  let replacement = null;
  if (raw.startsWith('\\[')) replacement = `\\begin{equation*}${raw.slice(2, -2)}\\end{equation*}`;
  else {
    // Only unnumbered forms: turning a numbered equation into \[ \] would drop its number and label.
    const m = raw.match(/^\\begin\{(equation\*|displaymath)\}([\s\S]*)\\end\{\1\}$/);
    if (m) replacement = `\\[${m[2]}\\]`;
  }
  if (!replacement) {
    vscode.window.setStatusBarMessage('Toggles between \\[ … \\] and equation*', 2500);
    return;
  }
  await editor.edit((e) => e.replace(new vscode.Range(doc.positionAt(span.start), doc.positionAt(span.end)), replacement));
}

/** Jumps between \begin{x} and its \end{x} (from inside an environment, to its \begin first). */
function gotoMatching(editor) {
  const doc = editor.document;
  const off = doc.offsetAt(editor.selection.active);
  const { pairs } = environments(doc.getText());
  let target = null;
  for (const p of pairs) {
    if (off >= p.open.start && off <= p.open.end) target = p.close.start;
    else if (off >= p.close.start && off <= p.close.end) target = p.open.start;
  }
  if (target === null) {
    const inner = pairs.filter((p) => off > p.open.end && off < p.close.start).sort((a, b) => b.open.start - a.open.start)[0];
    if (inner) target = inner.open.start;
  }
  if (target === null) return;
  const pos = doc.positionAt(target);
  editor.selection = new vscode.Selection(pos, pos);
  editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
}

/** $…$ around each selection, or removes it if the selection is already inline math. */
async function wrapMath(editor) {
  const doc = editor.document;
  const spans = editor.selections.map((sel) => {
    const text = doc.getText(sel);
    if (/^\$[^$]*\$$/.test(text) && text.length > 1) return { outer: sel, inner: text.slice(1, -1) };
    if (sel.isEmpty || sel.start.character === 0) return null;
    const outer = new vscode.Range(sel.start.translate(0, -1), sel.end.translate(0, 1));
    const t = doc.getText(outer);
    return t.startsWith('$') && t.endsWith('$') ? { outer, inner: text } : null;
  });
  if (spans.every(Boolean)) {
    await editor.edit((e) => spans.forEach((s) => e.replace(s.outer, s.inner)));
    return;
  }
  await editor.insertSnippet(new vscode.SnippetString('\\$${TM_SELECTED_TEXT}$0\\$'));
}

const HEADINGS = ['part', 'chapter', 'section', 'subsection', 'subsubsection', 'paragraph', 'subparagraph'];

/** Moves the headings on the selected lines one level up (-1) or down (+1). */
async function shiftSections(editor, delta) {
  const doc = editor.document;
  const hasChapters = /\\chapter\*?\s*[[{]/.test(doc.getText()) || /\\documentclass(\[[^\]]*\])?\{(book|report|memoir|scrbook|scrreprt)\}/.test(project.read(doc.uri.fsPath)?.text || '');
  const lowest = hasChapters ? 1 : 2;
  const lines = new Set();
  for (const sel of editor.selections) for (let l = sel.start.line; l <= sel.end.line; l++) lines.add(l);
  const edits = [];
  for (const l of lines) {
    const text = doc.lineAt(l).text;
    const m = /\\(part|chapter|section|subsection|subsubsection|paragraph|subparagraph)(?=\*?\s*[[{])/.exec(text);
    if (!m) continue;
    const next = HEADINGS.indexOf(m[1]) + delta;
    if (next < lowest || next >= HEADINGS.length) continue;
    edits.push([new vscode.Range(l, m.index + 1, l, m.index + 1 + m[1].length), HEADINGS[next]]);
  }
  if (!edits.length) {
    vscode.window.setStatusBarMessage(delta < 0 ? 'No heading to promote here' : 'No heading to demote here', 2000);
    return;
  }
  await editor.edit((e) => edits.forEach(([r, t]) => e.replace(r, t)));
}

/** \section ⇄ \section*, equation ⇄ equation*, figure ⇄ figure*, … at the cursor. */
async function toggleStar(editor) {
  const doc = editor.document;
  const pos = editor.selection.active;
  const line = doc.lineAt(pos.line).text;
  const head = /\\(part|chapter|section|subsection|subsubsection|paragraph|subparagraph)(\*?)(?=\s*[[{])/.exec(line);
  if (head) {
    const at = new vscode.Position(pos.line, head.index + 1 + head[1].length);
    await editor.edit((e) => (head[2] ? e.delete(new vscode.Range(at, at.translate(0, 1))) : e.insert(at, '*')));
    return;
  }
  const off = doc.offsetAt(pos);
  const pair = environments(doc.getText())
    .pairs.filter((p) => off >= p.open.start && off <= p.close.end && p.name !== 'document')
    .sort((a, b) => b.open.start - a.open.start)[0];
  if (!pair) return;
  const name = pair.name.endsWith('*') ? pair.name.slice(0, -1) : pair.name + '*';
  await editor.edit((e) => {
    for (const t of [pair.open, pair.close]) e.replace(new vscode.Range(doc.positionAt(t.nameStart), doc.positionAt(t.nameEnd)), name);
  });
}

/** Enter on an empty \item: remove it and step out of the list. */
async function endList(editor) {
  const doc = editor.document;
  const line = doc.lineAt(editor.selection.active.line);
  const open = openEnvAt(doc, line.range.start);
  const indent = open ? doc.lineAt(doc.positionAt(open.start).line).text.match(/^\s*/)[0] : '';
  await editor.edit((e) => e.replace(line.range, indent));
}

// ---------------------------------------------------------------------------
// Context keys, so the right-click menu offers only what applies where you clicked

const STARRABLE = /^(equation|align|gather|multline|alignat|flalign|eqnarray|figure|table|section|subsection|subsubsection|chapter|part|paragraph)\*?$/;

const menuKeys = {}; // the values last set, for tests

function menuContext(context) {
  const keys = menuKeys;
  const set = (k, v) => {
    if (keys[k] === v) return;
    keys[k] = v;
    vscode.commands.executeCommand('setContext', `texPreview.${k}`, v);
  };
  let timer;
  const update = () => {
    const ed = vscode.window.activeTextEditor;
    if (!ed || !isTex(ed.document)) return;
    const doc = ed.document;
    const pos = ed.selection.active;
    const line = doc.lineAt(pos.line).text;
    const onHeading = /\\(part|chapter|section|subsection|subsubsection|paragraph|subparagraph)\*?\s*[[{]/.test(line);
    const off = doc.offsetAt(pos);
    const { pairs } = envs(doc);
    const around = pairs.filter((p) => off >= p.open.start && off <= p.close.end && p.name !== 'document');
    const inner = around.sort((a, b) => b.open.start - a.open.start)[0];
    const span = math.mathAt(doc, pos);
    const raw = span ? doc.getText(span.range) : '';
    const review = require('./review').contextInfo(ed);
    set('onHeading', onHeading);
    set('canStar', onHeading || !!(inner && STARRABLE.test(inner.name)));
    set('inEnvironment', !!inner);
    const open = openEnvAt(doc, pos);
    set('canCloseEnvironment', !!open && open.name !== 'document');
    set('inDisplayMath', raw.startsWith('\\[') || /^\\begin\{(equation\*|displaymath)\}/.test(raw));
    set('onChange', review.onChange);
    set('hasChanges', review.hasChanges);
    set('structure', keys.onHeading || keys.canStar || keys.inEnvironment || keys.canCloseEnvironment || keys.inDisplayMath);
  };
  const later = () => {
    clearTimeout(timer);
    timer = setTimeout(update, 120);
  };
  context.subscriptions.push(
    // Immediately on cursor moves: a right-click moves the cursor and opens the menu at once.
    vscode.window.onDidChangeTextEditorSelection(update),
    vscode.window.onDidChangeActiveTextEditor(update),
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (isTex(e.document)) later();
    })
  );
  later();
}

// ---------------------------------------------------------------------------
// Word count: a status bar item for LaTeX files, and a breakdown on click

function projectStats(doc) {
  const add = (a, b) => ({ words: a.words + b.words, chars: a.chars + b.chars, charsNoSpaces: a.charsNoSpaces + b.charsNoSpaces, inlineMath: a.inlineMath + b.inlineMath, displayMath: a.displayMath + b.displayMath });
  if (doc.uri.scheme !== 'file') return { total: textStats(doc.getText(), true), files: [] };
  const root = project.findRoot(doc.uri.fsPath);
  const files = project.projectFiles(root).map((f) => ({ file: f, stats: textStats(project.read(f)?.text || '', f === root) }));
  return { root, total: files.reduce((a, f) => add(a, f.stats), { words: 0, chars: 0, charsNoSpaces: 0, inlineMath: 0, displayMath: 0 }), files };
}

function selectionStats(editor) {
  if (editor.selections.every((s) => s.isEmpty)) return null;
  return editor.selections.reduce((sum, s) => sum + countWords(editor.document.getText(s), false), 0);
}

function wordCountStatus(context) {
  const item = vscode.window.createStatusBarItem('texPreview.words', vscode.StatusBarAlignment.Right, 110);
  item.name = 'LaTeX Word Count';
  item.command = 'texPreview.wordCount';
  context.subscriptions.push(item);
  let timer;
  const update = () => {
    const ed = vscode.window.activeTextEditor;
    if (!ed || !isTex(ed.document)) {
      item.hide();
      return;
    }
    const { total } = projectStats(ed.document);
    const sel = selectionStats(ed);
    item.text = sel !== null ? `${sel.toLocaleString()} of ${total.words.toLocaleString()} words` : `${total.words.toLocaleString()} words`;
    item.tooltip = `${total.words.toLocaleString()} words · ${total.chars.toLocaleString()} characters (${total.charsNoSpaces.toLocaleString()} without spaces)\nText only: math, commands and comments are not counted.\nClick for details.`;
    item.show();
  };
  const later = (ms) => {
    clearTimeout(timer);
    timer = setTimeout(update, ms);
  };
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(() => later(50)),
    vscode.window.onDidChangeTextEditorSelection(() => later(150)),
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (isTex(e.document)) later(600);
    })
  );
  later(300);
}

async function wordCount() {
  const editor = vscode.window.activeTextEditor;
  if (!editor || !isTex(editor.document)) return;
  const { root, total, files } = projectStats(editor.document);
  const n = (x) => x.toLocaleString();
  const items = [];
  const sel = selectionStats(editor);
  if (sel !== null) items.push({ label: `$(selection) ${n(sel)} words selected` });
  items.push(
    { label: `$(book) ${n(total.words)} words`, description: root ? path.basename(root) + (files.length > 1 ? ` and ${files.length - 1} included file${files.length > 2 ? 's' : ''}` : '') : '' },
    { label: `$(symbol-text) ${n(total.chars)} characters`, description: `${n(total.charsNoSpaces)} without spaces` },
    { label: `$(symbol-operator) ${n(total.inlineMath)} inline formulas, ${n(total.displayMath)} displayed`, description: 'not counted as words' }
  );
  if (files.length > 1) {
    items.push({ label: 'By file', kind: vscode.QuickPickItemKind.Separator });
    for (const f of files) items.push({ label: `$(file) ${path.relative(path.dirname(root), f.file)}`, description: `${n(f.stats.words)} words · ${n(f.stats.chars)} characters`, file: f.file });
  }
  const picked = await vscode.window.showQuickPick(items, { title: 'Word Count', placeHolder: 'Text only: math, commands and comments are not counted' });
  if (picked && picked.file) vscode.window.showTextDocument(vscode.Uri.file(picked.file));
}

// ---------------------------------------------------------------------------
// Formatting

const VERBATIM = /^(verbatim|Verbatim|lstlisting|minted|comment|filecontents)\*?$/;

/** Uses latexindent when it is installed, otherwise re-indents by environment depth. */
async function formatTex(doc, opts) {
  const bin = which('latexindent');
  if (!bin) return indentEdits(doc, opts);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tex-preview-'));
  const tmp = path.join(dir, 'input.tex');
  fs.writeFileSync(tmp, doc.getText());
  const r = await exec(bin, ['-g', path.join(dir, 'indent.log'), tmp], { cwd: dir });
  fs.rm(dir, { recursive: true, force: true }, () => {});
  if (r.code !== 0 || !r.stdout) {
    vscode.window.setStatusBarMessage('latexindent failed; using the built-in indenter', 3000);
    return indentEdits(doc, opts);
  }
  return [vscode.TextEdit.replace(new vscode.Range(0, 0, doc.lineCount, 0), r.stdout)];
}

function indentEdits(doc, opts, range) {
  const unit = opts.insertSpaces ? ' '.repeat(opts.tabSize) : '\t';
  const src = project.stripComments(doc.getText()).split(/\r?\n/);
  const edits = [];
  let depth = 0;
  let verbatim = null;
  for (let i = 0; i < doc.lineCount; i++) {
    const line = doc.lineAt(i);
    const code = src[i] || '';
    if (verbatim) {
      if (new RegExp(`\\\\end\\{${verbatim.replace('*', '\\*')}\\}`).test(code)) verbatim = null;
      else continue;
    }
    const tags = [...code.matchAll(/\\(begin|end)\s*\{([^}]+)\}/g)].filter((m) => m[2] !== 'document');
    let lead = 0;
    while (lead < tags.length && tags[lead][1] === 'end' && /^\s*$/.test(code.slice(0, tags[lead].index).replace(/\\end\s*\{[^}]+\}/g, ''))) lead++;
    const lineDepth = Math.max(0, depth - lead);
    const want = line.isEmptyOrWhitespace ? '' : unit.repeat(lineDepth) + line.text.trim();
    if (want !== line.text && (!range || range.contains(line.range.start))) edits.push(vscode.TextEdit.replace(line.range, want));
    for (const t of tags) {
      depth = Math.max(0, depth + (t[1] === 'begin' ? 1 : -1));
      if (t[1] === 'begin' && VERBATIM.test(t[2])) verbatim = t[2];
    }
  }
  return edits;
}

/** One field per line, aligned `=`, entries separated by a blank line. Text between entries is kept. */
function formatBib(doc, opts) {
  const text = doc.getText();
  const unit = opts.insertSpaces ? ' '.repeat(opts.tabSize) : '\t';
  const entries = project.parseBib(text);
  let out = '';
  let last = 0;
  for (const e of entries) {
    const between = text.slice(last, e.start).trim();
    if (between) out += between + '\n\n';
    if (!e.fields) out += e.raw.trim() + '\n\n';
    else {
      const width = Math.max(0, ...e.fields.map((f) => f.name.length));
      const body = e.fields.map((f) => `${unit}${f.name.padEnd(width)} = ${f.raw.replace(/\s*\n\s*/g, ' ')},`).join('\n');
      out += `@${e.type}{${e.key},\n${body}\n}\n\n`;
    }
    last = e.end;
  }
  const tail = text.slice(last).trim();
  if (tail) out += tail + '\n';
  out = out.replace(/\n+$/, '\n');
  if (out === text) return [];
  return [vscode.TextEdit.replace(new vscode.Range(0, 0, doc.lineCount, 0), out)];
}

// ---------------------------------------------------------------------------
// Diagnostics: duplicate labels (always) and chktex (opt-in)

function lint(context) {
  const labels = vscode.languages.createDiagnosticCollection('tex-labels');
  const chktex = vscode.languages.createDiagnosticCollection('chktex');
  context.subscriptions.push(labels, chktex);
  const timers = new Map();

  const checkLabels = () => {
    labels.clear();
    for (const doc of vscode.workspace.textDocuments) {
      if (!isTex(doc) || doc.uri.scheme !== 'file') continue;
      const all = project.project(doc.uri.fsPath).labels;
      const count = new Map();
      for (const l of all) count.set(l.name, [...(count.get(l.name) || []), l]);
      const ds = [];
      for (const l of all) {
        if (l.file !== doc.uri.fsPath || count.get(l.name).length < 2) continue;
        const others = count.get(l.name).filter((o) => o !== l).map((o) => `${path.basename(o.file)}:${o.line + 1}`);
        const d = new vscode.Diagnostic(new vscode.Range(l.line, l.character, l.line, l.character + l.name.length), `Label '${l.name}' is also defined at ${others.join(', ')}`, vscode.DiagnosticSeverity.Warning);
        d.source = 'LaTeX';
        ds.push(d);
      }
      labels.set(doc.uri, ds);
    }
  };

  const runChktex = async (doc) => {
    if (!config().get('chktex')) {
      chktex.delete(doc.uri);
      return;
    }
    const bin = which('chktex');
    if (!bin) return;
    const r = await exec(bin, ['-q', '-I0', '-f', '%l:%c:%d:%k:%n:%m\n'], { cwd: doc.uri.scheme === 'file' ? path.dirname(doc.uri.fsPath) : undefined, input: doc.getText() });
    const ds = [];
    for (const m of r.stdout.matchAll(/^(\d+):(\d+):(\d+):(\w+):(\d+):(.*)$/gm)) {
      const line = parseInt(m[1], 10) - 1;
      const col = parseInt(m[2], 10) - 1;
      if (line >= doc.lineCount) continue;
      const sev = m[4] === 'Error' ? vscode.DiagnosticSeverity.Error : m[4] === 'Warning' ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Information;
      const d = new vscode.Diagnostic(new vscode.Range(line, col, line, col + Math.max(1, parseInt(m[3], 10))), m[6].trim(), sev);
      d.source = 'chktex';
      d.code = parseInt(m[5], 10);
      ds.push(d);
    }
    chktex.set(doc.uri, ds);
  };

  const schedule = (doc, delay) => {
    if (!isTex(doc)) return;
    clearTimeout(timers.get(doc.uri.toString()));
    timers.set(
      doc.uri.toString(),
      setTimeout(() => {
        checkLabels();
        runChktex(doc);
      }, delay)
    );
  };

  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument((d) => schedule(d, 100)),
    vscode.workspace.onDidChangeTextDocument((e) => schedule(e.document, 700)),
    vscode.workspace.onDidCloseTextDocument((d) => {
      labels.delete(d.uri);
      chktex.delete(d.uri);
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('texPreview.chktex')) vscode.workspace.textDocuments.forEach((d) => schedule(d, 0));
    })
  );
  vscode.workspace.textDocuments.forEach((d) => schedule(d, 500));
}

module.exports = { activate, _menuKeys: () => ({ ...menuKeys }) };
