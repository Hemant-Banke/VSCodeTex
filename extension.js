'use strict';

const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const { SyncTex } = require('./synctex');
const overleaf = require('./overleaf');

/** @type {Map<string, Preview>} keyed by root .tex fsPath */
const previews = new Map();
let output;
let diagnostics;
let statusItem;
let extensionUri;

const WATCHED_EXT = new Set(['.tex', '.bib', '.sty', '.cls', '.ltx', '.bst', '.tikz']);

function activate(context) {
  extensionUri = context.extensionUri;
  output = vscode.window.createOutputChannel('TeX Preview');
  diagnostics = vscode.languages.createDiagnosticCollection('tex-preview');
  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusItem.command = 'texPreview.showLog';

  context.subscriptions.push(
    output,
    diagnostics,
    statusItem,
    vscode.commands.registerCommand('texPreview.open', (uri) => openPreview(uri)),
    vscode.commands.registerCommand('texPreview.compile', () => compileActive()),
    vscode.commands.registerCommand('texPreview.showLog', () => output.show(true)),
    vscode.commands.registerCommand('texPreview.syncToPdf', () => syncToPdf()),
    vscode.workspace.onDidSaveTextDocument(onSave)
  );

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

/** Follows a `% !TEX root = ...` magic comment, otherwise returns the file itself. */
function resolveRoot(fsPath) {
  let text = '';
  try {
    text = fs.readFileSync(fsPath, 'utf8').split(/\r?\n/, 30).join('\n');
  } catch {
    return fsPath;
  }
  const m = text.match(/^\s*%\s*!\s*TEX\s+root\s*=\s*(.+?)\s*$/im);
  if (m) {
    const target = path.resolve(path.dirname(fsPath), m[1]);
    if (fs.existsSync(target)) return target;
  }
  return fsPath;
}

function openPreview(uri) {
  if (!(uri instanceof vscode.Uri)) {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    uri = editor.document.uri;
  }
  if (uri.scheme !== 'file' || path.extname(uri.fsPath).toLowerCase() !== '.tex') {
    vscode.window.showWarningMessage('TeX Preview: open a .tex file first.');
    return;
  }
  const root = resolveRoot(uri.fsPath);
  let preview = previews.get(root);
  if (preview) {
    preview.panel.reveal(vscode.ViewColumn.Beside, true);
  } else {
    preview = new Preview(root);
    previews.set(root, preview);
  }
  preview.compile();
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
  if (!p) {
    openPreview(editor.document.uri);
    return;
  }
  const loc = p.synctex()?.toPdf(file, editor.selection.active.line + 1);
  if (!loc) {
    vscode.window.setStatusBarMessage('TeX Preview: no PDF location for this line (compile first?)', 3000);
    return;
  }
  p.panel.reveal(undefined, true);
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

function searchPath() {
  const cfg = vscode.workspace.getConfiguration('texPreview');
  const extra = cfg.get('extraPath') || [];
  const home = os.homedir();
  const defaults =
    process.platform === 'win32'
      ? []
      : [
          '/Library/TeX/texbin',
          '/opt/homebrew/bin',
          '/usr/local/bin',
          '/usr/texbin',
          '/usr/bin',
          path.join(home, '.cargo', 'bin'),
          path.join(home, 'bin'),
        ];
  // Also pick up any TeX Live install under /usr/local/texlive/<year>/bin/<arch>.
  try {
    const tl = '/usr/local/texlive';
    for (const year of fs.readdirSync(tl).sort().reverse()) {
      const binRoot = path.join(tl, year, 'bin');
      if (!fs.existsSync(binRoot)) continue;
      for (const arch of fs.readdirSync(binRoot)) defaults.push(path.join(binRoot, arch));
    }
  } catch {
    /* no TeX Live there */
  }
  const parts = [...extra, ...(process.env.PATH || '').split(path.delimiter), ...defaults];
  return [...new Set(parts.filter(Boolean))].join(path.delimiter);
}

function which(cmd, PATH) {
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const dir of PATH.split(path.delimiter)) {
    for (const ext of exts) {
      const full = path.join(dir, cmd + ext);
      try {
        fs.accessSync(full, fs.constants.X_OK);
        if (fs.statSync(full).isFile()) return full;
      } catch {
        /* keep looking */
      }
    }
  }
  return null;
}

function pickEngine(PATH) {
  const wanted = vscode.workspace.getConfiguration('texPreview').get('engine') || 'auto';
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
    log(`$ ${path.basename(bin)} ${args.join(' ')}\n`);
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
    const key = `${file}:${line}:${message}:${severity}`;
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

    this.panel = vscode.window.createWebviewPanel(
      'texPreview',
      `Preview ${path.basename(root)}`,
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
    this.panel.webview.html = this.html();
    this.ready = new Promise((resolve) => (this.resolveReady = resolve));
    this.panel.webview.onDidReceiveMessage((msg) => this.onMessage(msg));
    this.panel.onDidDispose(() => this.dispose());
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
    previews.delete(this.root);
    diagnostics.clear();
    statusItem.hide();
  }

  post(msg) {
    this.ready.then(() => this.panel.webview.postMessage(msg));
  }

  onMessage(msg) {
    switch (msg.type) {
      case 'ready':
        this.resolveReady();
        if (fs.existsSync(this.pdfPath)) this.sendPdf();
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

  sendPdf() {
    fs.readFile(this.pdfPath, (err, buf) => {
      if (err) return;
      this.post({ type: 'pdf', data: buf.toString('base64') });
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
    const PATH = searchPath();
    const engine = pickEngine(PATH);
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
    const file = path.basename(this.root);

    let result;
    const latexFlags = ['-interaction=nonstopmode', '-file-line-error', '-synctex=1', '-halt-on-error'];

    if (engine.name === 'latexmk') {
      const mode = vscode.workspace.getConfiguration('texPreview').get('latexmkEngine') || 'pdf';
      result = await run(
        engine.bin,
        [`-${mode}`, ...latexFlags.filter((f) => f !== '-halt-on-error'), '-f', `-outdir=${outRel}`, file],
        opts,
        log
      );
    } else if (engine.name === 'tectonic') {
      result = await run(engine.bin, ['--keep-logs', '--synctex', '--outdir', outRel, file], opts, log);
    } else {
      result = await this.runPlainLatex(engine.bin, PATH, file, outRel, opts, log, gen);
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
  async runPlainLatex(bin, PATH, file, outRel, opts, log, gen) {
    const args = [...['-interaction=nonstopmode', '-file-line-error', '-synctex=1'], `-output-directory=${outRel}`, file];
    const auxPath = path.join(this.outDir, this.base + '.aux');
    const logPath = path.join(this.outDir, this.base + '.log');

    let result = await run(bin, args, opts, log);
    if (result.killed || gen !== this.generation) return result;

    let needRerun = false;
    const aux = readIfExists(auxPath);
    if (/\\bibdata\{/.test(aux)) {
      const bibtex = which('bibtex', PATH);
      if (bibtex) {
        const env = { ...opts.env, BIBINPUTS: this.rootDir + path.delimiter, BSTINPUTS: this.rootDir + path.delimiter };
        const r = await run(bibtex, [this.base], { ...opts, cwd: this.outDir, env }, log);
        if (r.killed) return r;
        needRerun = true;
      }
    }
    for (let pass = 0; pass < 3; pass++) {
      const logText = readIfExists(logPath);
      if (!needRerun && !/Rerun to get|Label\(s\) may have changed|undefined references/.test(logText)) break;
      if (pass > 0 && !/Rerun to get|Label\(s\) may have changed/.test(logText)) break;
      needRerun = false;
      result = await run(bin, args, opts, log);
      if (result.killed || gen !== this.generation) return result;
    }
    return result;
  }

  html() {
    const webview = this.panel.webview;
    const media = (f) => webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', f));
    const pdfjs = (f) => webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'node_modules', 'pdfjs-dist', 'build', f));
    const nonce = Array.from({ length: 32 }, () => Math.floor(Math.random() * 36).toString(36)).join('');
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} data: blob:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `font-src ${webview.cspSource} data:`,
      `script-src 'nonce-${nonce}' ${webview.cspSource}`,
      `connect-src ${webview.cspSource} data: blob:`,
      `worker-src blob:`,
    ].join('; ');

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${media('viewer.css')}">
<title>Preview</title>
</head>
<body>
  <header id="toolbar">
    <button id="recompile" title="Recompile (⌘/Ctrl+Enter in the editor)">
      <span class="codicon">⟳</span> Recompile
    </button>
    <span id="status" class="status idle"><span class="dot"></span><span id="status-text">Waiting…</span></span>
    <span class="spacer"></span>
    <span id="pages"></span>
    <button id="zoom-out" title="Zoom out">−</button>
    <button id="zoom-label" title="Fit to width">Fit</button>
    <button id="zoom-in" title="Zoom in">+</button>
  </header>
  <section id="errors" hidden></section>
  <main id="viewer"><div id="empty">The PDF will appear here after the first compile.</div></main>
  <script nonce="${nonce}" src="${pdfjs('pdf.min.js')}"></script>
  <script nonce="${nonce}">window.PDF_WORKER_URL = ${JSON.stringify(pdfjs('pdf.worker.min.js').toString())};
    window.PDF_ASSETS = ${JSON.stringify(webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'node_modules', 'pdfjs-dist')).toString())};</script>
  <script nonce="${nonce}" src="${media('viewer.js')}"></script>
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
