'use strict';

const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const { SyncTex } = require('./synctex');
const overleaf = require('./overleaf');
const project = require('./project');
const { searchPath, which } = require('./tools');
const { CompletionProvider, HoverProvider } = require('./language');
const structure = require('./structure');
const editing = require('./editing');
const palette = require('./palette');
const review = require('./review');
const { BrowserServer } = require('./server');

/** @type {Map<string, Preview>} keyed by root .tex fsPath */
const previews = new Map();
let output;
let diagnostics;
let statusItem;
let extensionUri;
let browserServer;

const WATCHED_EXT = new Set(['.tex', '.bib', '.sty', '.cls', '.ltx', '.bst', '.tikz', '.rnw', '.jnw']);
const ROOT_EXT = new Set(['.tex', '.rnw', '.jnw']);
const AUX_EXT = /\.(aux|bbl|blg|bcf|run\.xml|fdb_latexmk|fls|log|out|toc|lof|lot|loa|nav|snm|vrb|xdv|dvi|synctex(\.gz)?|synctex\(busy\)|idx|ind|ilg|glo|gls|glg|ist|acn|acr|alg|thm|brf|nlo|nls)$/i;
const LATEX = [{ language: 'latex' }, { language: 'tex' }];

function activate(context) {
  extensionUri = context.extensionUri;
  output = vscode.window.createOutputChannel('TeX Preview');
  diagnostics = vscode.languages.createDiagnosticCollection('tex-preview');
  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusItem.command = 'texPreview.menu';
  browserServer = new BrowserServer(context.extensionPath);

  context.subscriptions.push(
    output,
    diagnostics,
    statusItem,
    vscode.commands.registerCommand('texPreview.open', (uri) => openPreview(uri)),
    vscode.commands.registerCommand('texPreview.compile', () => compileActive()),
    vscode.commands.registerCommand('texPreview.showLog', () => output.show(true)),
    vscode.commands.registerCommand('texPreview.syncToPdf', () => syncToPdf()),
    vscode.commands.registerCommand('texPreview.stop', () => activePreview()?.stop()),
    vscode.commands.registerCommand('texPreview.clean', () => clean()),
    vscode.commands.registerCommand('texPreview.openExternal', () => openExternal()),
    vscode.commands.registerCommand('texPreview.openInBrowser', (opts = {}) => {
      const ed = vscode.window.activeTextEditor;
      const p = (ed && previewFor(ed.document.uri)) || activePreview();
      return p ? openInBrowser(p, opts.launch !== false) : undefined;
    }),
    vscode.commands.registerCommand('texPreview.menu', () => showMenu()),
    // Keep the TeX status item visible for LaTeX files so its menu is always one click away.
    vscode.window.onDidChangeActiveTextEditor((ed) => {
      const tex = ed && /^(la)?tex$/.test(ed.document.languageId);
      if (tex && !statusItem.text) setStatus('$(file-pdf) TeX', 'TeX: preview, build and PDF actions');
      else if (!tex && ed && !previews.size) statusItem.hide();
      else if (tex) statusItem.show();
    }),
    { dispose: () => browserServer.dispose() },
    vscode.workspace.onDidSaveTextDocument(onSave),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('texPreview.invertPdf')) for (const p of previews.values()) p.sendConfig();
    }),
    vscode.window.onDidChangeActiveColorTheme(() => {
      for (const p of previews.values()) p.sendConfig();
    }),
    vscode.languages.registerCompletionItemProvider(LATEX, new CompletionProvider(), '\\', '{', ',', '@', '/'),
    vscode.languages.registerHoverProvider(LATEX, new HoverProvider()),
    vscode.languages.registerDocumentSymbolProvider(LATEX, new structure.SymbolProvider()),
    vscode.languages.registerFoldingRangeProvider(LATEX, new structure.FoldingProvider()),
    vscode.languages.registerSelectionRangeProvider(LATEX, new structure.SelectionProvider()),
    vscode.languages.registerLinkedEditingRangeProvider(LATEX, new structure.LinkedEditingProvider())
  );
  editing.activate(context);
  palette.activate(context);
  // Review logs are written outside any editor, so tell the Overleaf sync about them directly.
  review.activate(context, { onLogWritten: (uris) => overleaf.scheduleFor(uris) }).catch((e) => output.appendLine(`[review] ${e.stack || e}`));
  const ed = vscode.window.activeTextEditor;
  if (ed && /^(la)?tex$/.test(ed.document.languageId)) setStatus('$(file-pdf) TeX', 'TeX: preview, build and PDF actions');

  // Changes pulled from Overleaf don't fire save events, so recompile affected previews here.
  overleaf.activate(context, {
    onFilesChanged(files) {
      for (const p of previews.values()) {
        if (files.some((f) => WATCHED_EXT.has(path.extname(f).toLowerCase()) && !path.relative(p.rootDir, f).startsWith('..'))) {
          p.compile();
        }
      }
    },
  });
}

function deactivate() {
  for (const p of previews.values()) p.dispose();
}

// ---------------------------------------------------------------------------
// Root-file resolution

/** The main file: `% !TEX root`, else the file itself if it has \\documentclass, else the file that includes it. */
function resolveRoot(fsPath) {
  return project.findRoot(fsPath);
}

function openPreview(uri) {
  if (!(uri instanceof vscode.Uri)) {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    uri = editor.document.uri;
  }
  const preview = previewFor(uri);
  if (!preview) return;
  preview.showPanel();
  preview.compile();
}

/** The (possibly panel-less) build for the root of `uri`, created if needed. */
function previewFor(uri) {
  if (uri.scheme !== 'file' || !ROOT_EXT.has(path.extname(uri.fsPath).toLowerCase())) {
    vscode.window.showWarningMessage('TeX Preview: open a .tex file first.');
    return null;
  }
  const root = resolveRoot(uri.fsPath);
  let preview = previews.get(root);
  if (!preview) {
    preview = new Preview(root);
    previews.set(root, preview);
  }
  return preview;
}

function activePreview() {
  const editor = vscode.window.activeTextEditor;
  if (editor && editor.document.uri.scheme === 'file') {
    const p = previews.get(resolveRoot(editor.document.uri.fsPath));
    if (p) return p;
  }
  return previews.size === 1 ? [...previews.values()][0] : null;
}

/** Opens the PDF in the system viewer (or texPreview.externalViewer.command) and keeps it rebuilt on save. */
async function openExternal() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;
  const preview = previewFor(editor.document.uri);
  if (!preview) return;
  preview.external = true;
  if (!fs.existsSync(preview.pdfPath)) await preview.compile();
  if (!fs.existsSync(preview.pdfPath)) return;
  const cmd = vscode.workspace.getConfiguration('texPreview').get('externalViewer.command');
  if (cmd) runShell(fill(cmd, preview, { PDF: preview.pdfPath }), preview.rootDir);
  else vscode.env.openExternal(vscode.Uri.file(preview.pdfPath));
}

/** Opens the live preview in the default web browser; it stays in sync with VS Code. */
async function openInBrowser(preview, launch = true) {
  preview.external = true;
  const url = await browserServer.url(preview);
  if (launch) vscode.env.openExternal(url);
  if (!fs.existsSync(preview.pdfPath)) preview.compile();
  return url.toString(); // the address, for scripts and tests
}

/** The TeX status bar item's menu: everything you can do with the build and the PDF. */
async function showMenu() {
  const p = activePreview();
  const items = [
    { label: '$(refresh) Recompile', command: 'texPreview.compile' },
    { label: '$(debug-stop) Stop Compiling', command: 'texPreview.stop', hide: !p || (!p.proc && !p.running) },
    { label: '$(open-preview) Open Preview to the Side', command: 'texPreview.open' },
    { label: '$(globe) Open Preview in Browser', description: 'live reload and SyncTeX', command: 'texPreview.openInBrowser' },
    { label: '$(file-pdf) Open PDF in External Viewer', command: 'texPreview.openExternal' },
    { label: '$(go-to-file) Jump to Location in PDF', command: 'texPreview.syncToPdf' },
    { label: '', kind: vscode.QuickPickItemKind.Separator },
    { label: '$(book) Word Count', command: 'texPreview.wordCount' },
    { label: '$(symbol-operator) Show Symbol Palette', command: 'texPreview.showSymbols' },
    { label: '$(search) Insert Symbol…', command: 'texPreview.insertSymbol' },
    { label: '$(trash) Clean Auxiliary Files', command: 'texPreview.clean' },
    { label: '$(output) Show Compile Log', command: 'texPreview.showLog' },
  ].filter((i) => !i.hide);
  const picked = await vscode.window.showQuickPick(items, { title: 'TeX' });
  if (picked && picked.command) vscode.commands.executeCommand(picked.command);
}

/** Deletes auxiliary files (not the PDF) for the active document's project. */
async function clean() {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.uri.scheme !== 'file') return;
  const root = resolveRoot(editor.document.uri.fsPath);
  const rel = vscode.workspace.getConfiguration('texPreview').get('outDir') || '.';
  const outDir = path.resolve(path.dirname(root), rel);
  const removed = [];
  const walk = (dir, depth) => {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (depth > 0 && !e.name.startsWith('.') && e.name !== 'node_modules') walk(full, depth - 1);
      } else if (AUX_EXT.test(e.name)) {
        fs.rmSync(full, { force: true });
        removed.push(full);
      }
    }
  };
  // A dedicated build folder is cleaned throughout; building next to the source, only top-level files.
  walk(outDir, outDir === path.dirname(root) ? 0 : 3);
  vscode.window.setStatusBarMessage(`TeX: removed ${removed.length} auxiliary file${removed.length === 1 ? '' : 's'}`, 4000);
}

/** Replaces %DOC%, %DOCFILE%, %TEX%, %DIR%, %OUTDIR% (and any extra keys) in a user command. */
function fill(cmd, p, extra = {}) {
  const vars = { DOC: path.join(p.rootDir, p.base), DOCFILE: p.base, TEX: p.root, DIR: p.rootDir, OUTDIR: p.outDir, ...extra };
  return cmd.replace(/%([A-Z]+)%/g, (m, k) => (k in vars ? vars[k] : m));
}

function runShell(cmd, cwd) {
  const proc = spawn(cmd, { cwd, shell: true, env: { ...process.env, PATH: searchPath() }, detached: true, stdio: 'ignore' });
  proc.on('error', (e) => vscode.window.showErrorMessage(`TeX Preview: ${e.message}`));
  proc.unref();
}

function compileActive() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;
  const doc = editor.document;
  const run = () => {
    const root = resolveRoot(doc.uri.fsPath);
    const p = previews.get(root);
    if (p) p.compile();
    else openPreview(doc.uri);
  };
  if (doc.isDirty) doc.save().then(run); // the save handler compiles open previews
  else run();
}

/** Forward search: scroll the preview to the cursor's line and flash it. */
function syncToPdf() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;
  const file = editor.document.uri.fsPath;
  const root = resolveRoot(file);
  const p = previews.get(root) || [...previews.values()].find((v) => !path.relative(v.rootDir, file).startsWith('..'));
  const syncCmd = vscode.workspace.getConfiguration('texPreview').get('externalViewer.syncCommand');
  if (p && !p.panel && !p.clients.size && syncCmd) {
    runShell(fill(syncCmd, p, { PDF: p.pdfPath, LINE: String(editor.selection.active.line + 1), TEX: file }), p.rootDir);
    return;
  }
  if (!p || (!p.panel && !p.clients.size)) {
    openPreview(editor.document.uri);
    return;
  }
  const loc = p.synctex()?.toPdf(file, editor.selection.active.line + 1);
  if (!loc) {
    vscode.window.setStatusBarMessage('TeX Preview: no PDF location for this line (compile first?)', 3000);
    return;
  }
  if (p.panel) p.panel.reveal(undefined, true);
  p.post({ type: 'scrollTo', ...loc });
}

function onSave(doc) {
  if (doc.uri.scheme !== 'file') return;
  if (!vscode.workspace.getConfiguration('texPreview').get('compileOnSave')) return;
  const file = doc.uri.fsPath;
  if (!WATCHED_EXT.has(path.extname(file).toLowerCase())) return;

  const explicitRoot = path.extname(file).toLowerCase() === '.tex' ? resolveRoot(file) : file;
  for (const [root, p] of previews) {
    const rootDir = path.dirname(root);
    const related =
      root === explicitRoot || file === root || !path.relative(rootDir, file).startsWith('..');
    if (related) p.compile();
  }
}

// ---------------------------------------------------------------------------
// Tool discovery

function pickEngine(PATH, docker) {
  const wanted = vscode.workspace.getConfiguration('texPreview').get('engine') || 'auto';
  // Inside a container we can't look for binaries; trust the image to have the one asked for.
  if (docker) return { name: wanted === 'auto' ? 'latexmk' : wanted, bin: wanted === 'auto' ? 'latexmk' : wanted };
  const order = wanted === 'auto' ? ['latexmk', 'tectonic', 'pdflatex'] : [wanted];
  for (const name of order) {
    const bin = which(name, PATH);
    if (bin) return { name, bin };
  }
  return { name: wanted, bin: null };
}

// ---------------------------------------------------------------------------
// Process helpers

function run(bin, args, opts, log) {
  return new Promise((resolve) => {
    log(`$ ${opts.shell ? bin : path.basename(bin)} ${args.join(' ')}\n`);
    const proc = spawn(bin, args, { ...opts, detached: process.platform !== 'win32' });
    opts.onSpawn && opts.onSpawn(proc);
    let text = '';
    const onData = (d) => {
      const s = d.toString();
      text += s;
      log(s);
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.on('error', (err) => {
      log(`\n${err.message}\n`);
      resolve({ code: -1, text, killed: false });
    });
    proc.on('close', (code, signal) => resolve({ code, text, killed: !!signal }));
  });
}

function killTree(proc) {
  if (!proc || proc.exitCode !== null) return;
  try {
    if (process.platform === 'win32') proc.kill();
    else process.kill(-proc.pid, 'SIGTERM');
  } catch {
    try {
      proc.kill();
    } catch {
      /* already gone */
    }
  }
}

function readIfExists(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// Log parsing

/** Returns [{file, line, message, severity}] from a TeX log (and tool stdout). */
function parseLog(logText, rootFile, rootDir) {
  const items = [];
  const seen = new Set();
  const add = (file, line, message, severity) => {
    file = file ? path.resolve(rootDir, file) : rootFile;
    message = message.trim();
    // The same error can come from both the .log and the compiler's console output, with and
    // without a trailing period or the offending-text suffix.
    const key = `${file}:${line}:${message.replace(/ — .*$/, '').replace(/\.$/, '')}:${severity}`;
    if (seen.has(key)) return;
    seen.add(key);
    items.push({ file, line: Math.max(1, line || 1), message, severity });
  };

  const lines = logText.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];

    // -file-line-error style:  ./paper.tex:42: Undefined control sequence.
    // tectonic prefixes its console copies with "error: " / "warning: ".
    let m = l.match(/^(?:(error|warning): )?([^:\s][^:]*?\.(?:tex|sty|cls|ltx|bbl|tikz)):(\d+): (.+)$/);
    if (m) {
      if (m[1] === 'warning') {
        if (!/^(Overfull|Underfull)/.test(m[4])) add(m[2], parseInt(m[3], 10), m[4], 'warning');
      } else {
        add(m[2], parseInt(m[3], 10), m[4] + contextOf(lines, i), 'error');
      }
      continue;
    }

    // Classic style:  ! Undefined control sequence.   ...   l.42 \foo
    m = l.match(/^! (.+)$/);
    if (m) {
      let lineNo = 0;
      for (let j = i + 1; j < Math.min(i + 30, lines.length); j++) {
        const lm = lines[j].match(/^l\.(\d+)/);
        if (lm) {
          lineNo = parseInt(lm[1], 10);
          break;
        }
      }
      add(null, lineNo, m[1], 'error');
      continue;
    }

    // LaTeX / package warnings, possibly continued on following lines.
    m = l.match(/^(?:LaTeX|Package [\w-]+|Class [\w-]+) Warning: (.*)$/);
    if (m) {
      let msg = m[1];
      let j = i + 1;
      while (j < lines.length && /^\(?[\w-]*\)?\s{2,}\S/.test(lines[j]) && lines[j].trim()) {
        msg += ' ' + lines[j].replace(/^\([\w-]+\)\s+/, '').trim();
        j++;
      }
      const lm = msg.match(/on input line (\d+)/);
      add(null, lm ? parseInt(lm[1], 10) : 0, msg, 'warning');
    }
  }
  return items;
}

function contextOf(lines, i) {
  // For "Undefined control sequence" etc. the next line shows the offending text.
  const next = lines[i + 1] || '';
  const m = next.match(/^l\.\d+\s?(.*)$/);
  return m && m[1].trim() ? ` — ${m[1].trim()}` : '';
}

// ---------------------------------------------------------------------------
// Preview panel

class Preview {
  constructor(root) {
    this.root = root;
    this.rootDir = path.dirname(root);
    this.base = path.basename(root, path.extname(root));
    this.proc = null;
    this.generation = 0;
    this.running = null;
    this.panel = null;
    this.external = false; // also shown outside VS Code (browser or external viewer), so it outlives its panel
    this.clients = new Map(); // browser tabs: id -> { res, queue }
  }

  addClient(id, res) {
    const queued = this.clients.get(id)?.queue || [];
    this.clients.set(id, { res, queue: null });
    queued.forEach((m) => res.write(`data: ${JSON.stringify(m)}\n\n`));
  }

  removeClient(id) {
    this.clients.delete(id);
  }

  showPanel() {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Beside, true);
      return;
    }
    this.panel = vscode.window.createWebviewPanel(
      'texPreview',
      `Preview ${path.basename(this.root)}`,
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(extensionUri, 'media'),
          vscode.Uri.joinPath(extensionUri, 'node_modules', 'pdfjs-dist'),
        ],
      }
    );
    this.panel.iconPath = {
      light: vscode.Uri.joinPath(extensionUri, 'media', 'preview-light.svg'),
      dark: vscode.Uri.joinPath(extensionUri, 'media', 'preview-dark.svg'),
    };
    this.ready = new Promise((resolve) => (this.resolveReady = resolve));
    this.panel.webview.onDidReceiveMessage((msg) => this.onMessage(msg));
    this.panel.webview.html = this.html();
    this.panel.onDidDispose(() => {
      this.panel = null;
      if (!this.external && !this.clients.size) this.dispose();
    });
  }

  /** Whether the viewer should show the PDF inverted (texPreview.invertPdf). */
  sendConfig(initial = false, client) {
    const mode = vscode.workspace.getConfiguration('texPreview').get('invertPdf') || 'never';
    const kind = vscode.window.activeColorTheme.kind;
    const darkTheme = kind === vscode.ColorThemeKind.Dark || kind === vscode.ColorThemeKind.HighContrast;
    this.post({ type: 'config', invert: mode === 'always' || (mode === 'darkTheme' && darkTheme), initial }, client);
  }

  stop() {
    if (!this.proc && !this.running) return;
    this.generation++;
    killTree(this.proc);
    this.proc = null;
    this.post({ type: 'status', state: 'idle', message: 'Compile stopped', errors: [] });
    setStatus('$(debug-stop) TeX: stopped', 'Compile stopped — save or Recompile to build again');
  }

  get outDir() {
    const rel = vscode.workspace.getConfiguration('texPreview').get('outDir') || '.';
    return path.resolve(this.rootDir, rel);
  }

  get pdfPath() {
    return path.join(this.outDir, this.base + '.pdf');
  }

  dispose() {
    killTree(this.proc);
    if (this.panel) this.panel.dispose();
    browserServer?.forget(this);
    for (const c of this.clients.values()) c.res?.end();
    previews.delete(this.root);
    diagnostics.clear();
    statusItem.hide();
  }

  /** To the panel and every browser tab, or to one browser tab (`client`). */
  post(msg, client) {
    if (msg.type === 'status' && !client) this.lastStatus = msg;
    const toClient = (id) => {
      let c = this.clients.get(id);
      if (!c) this.clients.set(id, (c = { res: null, queue: [] }));
      if (c.res) c.res.write(`data: ${JSON.stringify(msg)}\n\n`);
      else c.queue.push(msg); // its event stream hasn't connected yet
    };
    if (client) return toClient(client);
    if (this.panel) {
      const panel = this.panel;
      this.ready.then(() => panel.webview.postMessage(msg));
    }
    for (const [id, c] of this.clients) if (c.res) toClient(id);
  }

  /** Headings of the whole project for the preview's Sections menu. */
  sendSections(client) {
    try {
      const items = structure.projectSections(this.root).map((s) => ({ title: [s.number, s.title].filter(Boolean).join('  '), level: s.level, file: s.file, line: s.line + 1 }));
      this.post({ type: 'sections', items }, client);
    } catch (e) {
      output.appendLine(`[tex-preview] sections: ${e.message}`);
    }
  }

  onMessage(msg, client) {
    switch (msg.type) {
      case 'ready':
        if (!client && this.resolveReady) this.resolveReady();
        this.sendConfig(true, client);
        this.sendSections(client);
        if (client && this.lastStatus) this.post(this.lastStatus, client);
        if (fs.existsSync(this.pdfPath)) this.sendPdf(client);
        break;
      case 'goto': {
        const loc = this.synctex()?.toPdf(msg.file, msg.line);
        if (loc) this.post({ type: 'scrollTo', ...loc }, client);
        else revealLine(msg.file, msg.line);
        break;
      }
      case 'openBrowser':
        openInBrowser(this);
        break;
      case 'reveal':
        revealLine(msg.file || this.root, msg.line);
        break;
      case 'inverse': {
        const hit = this.synctex()?.toSource(msg.page, msg.x, msg.y);
        if (hit) revealLine(hit.file, hit.line, msg.word);
        else vscode.window.setStatusBarMessage('TeX Preview: no SyncTeX data for that spot', 3000);
        break;
      }
      case 'openExternal':
        if (/^(https?|mailto|ftp):/i.test(msg.url)) vscode.env.openExternal(vscode.Uri.parse(msg.url));
        break;
      case 'recompile':
        this.compile();
        break;
      case 'showLog':
        output.show(true);
        break;
    }
  }

  /** Parsed SyncTeX for the current PDF, re-read whenever the file changes. */
  synctex() {
    for (const f of [this.base + '.synctex.gz', this.base + '.synctex']) {
      const file = path.join(this.outDir, f);
      let mtime;
      try {
        mtime = fs.statSync(file).mtimeMs;
      } catch {
        continue;
      }
      if (!this._synctex || this._synctex.file !== file || this._synctex.mtime !== mtime) {
        try {
          this._synctex = { file, mtime, data: new SyncTex(file, this.rootDir) };
        } catch (e) {
          output.appendLine(`[tex-preview] could not read ${file}: ${e.message}`);
          return null;
        }
      }
      return this._synctex.data;
    }
    return null;
  }

  sendPdf(client) {
    if (!this.panel && !this.clients.size) return;
    fs.readFile(this.pdfPath, (err, buf) => {
      if (err) return;
      this.post({ type: 'pdf', data: buf.toString('base64') }, client);
    });
  }

  /** Compiles; if a compile is already running it is cancelled and restarted. */
  async compile() {
    const gen = ++this.generation;
    if (this.proc) killTree(this.proc);
    if (this.running) await this.running;
    if (gen !== this.generation) return; // a newer save superseded us

    this.running = this.doCompile(gen).catch((e) => {
      output.appendLine(`\n[tex-preview] ${e && e.stack ? e.stack : e}`);
    });
    await this.running;
    this.running = null;
  }

  async doCompile(gen) {
    const cfg = vscode.workspace.getConfiguration('texPreview');
    const PATH = searchPath();
    const docker = (cfg.get('docker.image') || '').trim();
    const custom = (cfg.get('buildCommand') || '').trim();
    const engine = custom ? { name: 'build command', bin: custom } : pickEngine(PATH, docker);
    const name = path.basename(this.root);

    if (!engine.bin) {
      const msg =
        engine.name === 'auto'
          ? 'No LaTeX compiler found (looked for latexmk, tectonic, pdflatex).'
          : `"${engine.name}" was not found on PATH.`;
      this.post({ type: 'status', state: 'error', message: msg, missingEngine: true, errors: [] });
      setStatus('$(error) TeX: no compiler', msg);
      return;
    }

    fs.mkdirSync(this.outDir, { recursive: true });
    const started = Date.now();
    this.post({ type: 'status', state: 'compiling', message: `Compiling with ${engine.name}…` });
    setStatus('$(sync~spin) TeX: compiling', `Compiling ${name} with ${engine.name}`);

    output.clear();
    output.appendLine(`[tex-preview] ${new Date().toLocaleTimeString()}  ${this.root}`);
    const log = (s) => output.append(s);
    const env = { ...process.env, PATH, max_print_line: '10000', error_line: '254', half_error_line: '238' };
    const opts = {
      cwd: this.rootDir,
      env,
      onSpawn: (p) => (this.proc = p),
    };
    const outRel = path.relative(this.rootDir, this.outDir) || '.';
    let file = path.basename(this.root);

    // TeX programs run directly, or inside texPreview.docker.image with the project mounted at
    // the same path.
    this.tool = (bin, args, o) => {
      if (!docker) return run(bin, args, o, log);
      const ws = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(this.root));
      const mount = ws ? ws.uri.fsPath : this.rootDir;
      const envArgs = Object.entries(o.env)
        .filter(([k, v]) => k !== 'PATH' && process.env[k] !== v)
        .flatMap(([k, v]) => ['-e', `${k}=${v}`]);
      const user = process.platform === 'linux' && process.getuid ? ['--user', `${process.getuid()}:${process.getgid()}`] : [];
      const dockerArgs = ['run', '--rm', '-i', '-v', `${mount}:${mount}`, '-w', o.cwd, ...user, ...envArgs, docker, bin, ...args];
      return run(which('docker', PATH) || 'docker', dockerArgs, o, log);
    };

    // Literate sources are woven to .tex first (knitr for .rnw, Weave.jl for .jnw).
    const ext = path.extname(this.root).toLowerCase();
    if (!custom && (ext === '.rnw' || ext === '.jnw')) {
      const r =
        ext === '.rnw'
          ? await run(which('Rscript', PATH) || 'Rscript', ['-e', `knitr::knit('${file.replace(/'/g, "\\'")}')`], opts, log)
          : await run(which('julia', PATH) || 'julia', ['-e', `using Weave; weave(${JSON.stringify(file)}, doctype="tex")`], opts, log);
      if (gen !== this.generation || r.killed) return;
      if (r.code !== 0) {
        const message = `Weaving ${file} failed (${ext === '.rnw' ? 'Rscript/knitr' : 'julia/Weave'}) — see the log.`;
        this.post({ type: 'status', state: 'error', message, errors: [{ file: this.root, rel: file, line: 0, message }] });
        setStatus('$(error) TeX: errors', message);
        return;
      }
      file = this.base + '.tex';
    }

    let result;
    const latexFlags = ['-interaction=nonstopmode', '-file-line-error', '-synctex=1', '-halt-on-error'];

    if (custom) {
      result = await run(fill(custom, this), [], { ...opts, shell: true }, log);
    } else if (engine.name === 'latexmk') {
      const mode = cfg.get('latexmkEngine') || 'pdf';
      result = await this.tool(
        engine.bin,
        [`-${mode}`, ...latexFlags.filter((f) => f !== '-halt-on-error'), '-f', `-outdir=${outRel}`, file],
        opts
      );
    } else if (engine.name === 'tectonic') {
      result = await this.tool(engine.bin, ['--keep-logs', '--synctex', '--outdir', outRel, file], opts);
    } else {
      result = await this.runPlainLatex(engine.bin, PATH, file, outRel, opts, gen, !!docker);
    }

    if (gen !== this.generation || result.killed) return; // superseded

    const logText = readIfExists(path.join(this.outDir, this.base + '.log'));
    const items = parseLog(logText + '\n' + (engine.name === 'tectonic' ? result.text : ''), this.root, this.rootDir);
    publishDiagnostics(items, this.root);

    const errors = items.filter((d) => d.severity === 'error');
    const warnings = items.filter((d) => d.severity === 'warning');
    let pdfFresh = false;
    try {
      pdfFresh = fs.statSync(this.pdfPath).mtimeMs >= started - 10;
    } catch {
      /* no pdf */
    }

    const secs = ((Date.now() - started) / 1000).toFixed(1);
    const failed = errors.length > 0 || result.code !== 0;
    if (pdfFresh) this.sendPdf();
    this.sendSections();

    const shownErrors = errors.slice(0, 50).map((e) => ({
      file: e.file,
      rel: path.relative(this.rootDir, e.file),
      line: e.line,
      message: e.message,
    }));
    if (failed && !shownErrors.length) {
      shownErrors.push({ file: this.root, rel: file, line: 0, message: `${engine.name} exited with code ${result.code} — see the log.` });
    }
    this.post({
      type: 'status',
      state: failed ? 'error' : 'ok',
      message: failed
        ? `${errors.length || 1} error${errors.length === 1 ? '' : 's'}${pdfFresh ? '' : ' — showing last good PDF'}`
        : `Compiled in ${secs}s${warnings.length ? ` · ${warnings.length} warning${warnings.length === 1 ? '' : 's'}` : ''}`,
      errors: shownErrors,
    });
    setStatus(
      failed ? '$(error) TeX: errors' : '$(check) TeX',
      failed ? 'Compile failed — click to show log' : `Compiled ${name} in ${secs}s`
    );
    this.proc = null;
  }

  /** pdflatex/xelatex/lualatex: one pass, bibtex if needed, then reruns until refs settle. */
  async runPlainLatex(bin, PATH, file, outRel, opts, gen, inDocker) {
    const args = [...['-interaction=nonstopmode', '-file-line-error', '-synctex=1'], `-output-directory=${outRel}`, file];
    const auxPath = path.join(this.outDir, this.base + '.aux');
    const logPath = path.join(this.outDir, this.base + '.log');

    let result = await this.tool(bin, args, opts);
    if (result.killed || gen !== this.generation) return result;

    let needRerun = false;
    const aux = readIfExists(auxPath);
    if (/\\bibdata\{/.test(aux)) {
      const bibtex = inDocker ? 'bibtex' : which('bibtex', PATH);
      if (bibtex) {
        const env = { ...opts.env, BIBINPUTS: this.rootDir + path.delimiter, BSTINPUTS: this.rootDir + path.delimiter };
        const r = await this.tool(bibtex, [this.base], { ...opts, cwd: this.outDir, env });
        if (r.killed) return r;
        needRerun = true;
      }
    }
    for (let pass = 0; pass < 3; pass++) {
      const logText = readIfExists(logPath);
      if (!needRerun && !/Rerun to get|Label\(s\) may have changed|undefined references/.test(logText)) break;
      if (pass > 0 && !/Rerun to get|Label\(s\) may have changed/.test(logText)) break;
      needRerun = false;
      result = await this.tool(bin, args, opts);
      if (result.killed || gen !== this.generation) return result;
    }
    return result;
  }

  /** Webview asset URLs, CSP and nonce for the panel. */
  webviewAssets() {
    const webview = this.panel.webview;
    const nonce = Array.from({ length: 32 }, () => Math.floor(Math.random() * 36).toString(36)).join('');
    return {
      nonce,
      media: (f) => webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', f)),
      pdfjs: (f) => webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'node_modules', 'pdfjs-dist', 'build', f)),
      assets: webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'node_modules', 'pdfjs-dist')).toString(),
      csp: [
        `default-src 'none'`,
        `img-src ${webview.cspSource} data: blob:`,
        `style-src ${webview.cspSource} 'unsafe-inline'`,
        `font-src ${webview.cspSource} data:`,
        `script-src 'nonce-${nonce}' ${webview.cspSource}`,
        `connect-src ${webview.cspSource} data: blob:`,
        `worker-src blob:`,
      ].join('; '),
    };
  }

  /** The viewer page, for the panel (webview assets) or a browser (see server.js). */
  html(a = this.webviewAssets()) {
    const nonce = a.nonce || '';
    const n = nonce ? ` nonce="${nonce}"` : '';
    const assets = a.browser ? `new URL(${JSON.stringify(a.assets)}, location.href).href` : JSON.stringify(a.assets);
    const worker = a.browser ? `new URL(${JSON.stringify(a.pdfjs('pdf.worker.min.js'))}, location.href).href` : JSON.stringify(a.pdfjs('pdf.worker.min.js').toString());
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
${a.csp ? `<meta http-equiv="Content-Security-Policy" content="${a.csp}">` : ''}
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${a.media('viewer.css')}">
<title>${a.browser ? `${this.base}.pdf — TeX Preview` : 'Preview'}</title>
</head>
<body class="${a.browser ? 'browser' : ''}">
  <header id="toolbar">
    <button id="recompile" title="Recompile (⌘/Ctrl+Enter in the editor)">
      <span class="codicon">⟳</span> Recompile
    </button>
    <span id="status" class="status idle"><span class="dot"></span><span id="status-text">Waiting…</span></span>
    <span class="spacer"></span>
    <span class="menu-wrap"><button id="sections-btn" title="Sections — jump to a heading" hidden>☰ Sections</button><div id="sections" class="menu" hidden></div></span>
    <span id="pages"></span>
    <button id="zoom-out" title="Zoom out">−</button>
    <button id="zoom-label" title="Fit to width">Fit</button>
    <button id="zoom-in" title="Zoom in">+</button>
    <button id="invert" title="Dark PDF (texPreview.invertPdf)">◐</button>
    <button id="open-browser" title="Open in browser (live, with SyncTeX)">↗</button>
  </header>
  <section id="errors" hidden></section>
  <main id="viewer"><div id="empty">The PDF will appear here after the first compile.</div></main>
  ${a.shim ? `<script>${a.shim}</script>` : ''}
  <script${n} src="${a.pdfjs('pdf.min.js')}"></script>
  <script${n}>window.PDF_WORKER_URL = ${worker};
    window.PDF_ASSETS = ${assets};</script>
  <script${n} src="${a.media('viewer.js')}"></script>
</body>
</html>`;
  }
}

function setStatus(text, tooltip) {
  statusItem.text = text;
  statusItem.tooltip = tooltip;
  statusItem.show();
}

function publishDiagnostics(items, root) {
  diagnostics.clear();
  const byFile = new Map();
  for (const it of items) {
    if (!fs.existsSync(it.file)) it.file = root;
    const range = new vscode.Range(it.line - 1, 0, it.line - 1, Number.MAX_SAFE_INTEGER);
    const d = new vscode.Diagnostic(
      range,
      it.message,
      it.severity === 'error' ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning
    );
    d.source = 'LaTeX';
    if (!byFile.has(it.file)) byFile.set(it.file, []);
    byFile.get(it.file).push(d);
  }
  for (const [file, ds] of byFile) diagnostics.set(vscode.Uri.file(file), ds);
}

async function revealLine(file, line, word) {
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
  const col =
    vscode.window.visibleTextEditors.find((e) => e.document.uri.fsPath === file)?.viewColumn ||
    vscode.ViewColumn.One;
  const editor = await vscode.window.showTextDocument(doc, { viewColumn: col });
  const lineIdx = Math.min(Math.max(0, (line || 1) - 1), doc.lineCount - 1);
  let range = new vscode.Range(lineIdx, 0, lineIdx, 0);
  // Select the double-clicked word if it appears on (or right next to) the mapped line.
  const w = (word || '').replace(/[^\p{L}\p{N}]+$/u, '').replace(/^[^\p{L}\p{N}]+/u, '');
  if (w.length >= 2) {
    const re = new RegExp(`(?<![\\p{L}\\\\])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'u');
    for (const d of [0, 1, -1, 2, -2, 3]) {
      const i = lineIdx + d;
      if (i < 0 || i >= doc.lineCount) continue;
      const m = re.exec(doc.lineAt(i).text);
      if (m) {
        range = new vscode.Range(i, m.index, i, m.index + w.length);
        break;
      }
    }
  }
  editor.selection = new vscode.Selection(range.start, range.end);
  editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
}

module.exports = { activate, deactivate };
