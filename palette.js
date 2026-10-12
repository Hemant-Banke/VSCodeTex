'use strict';

// The Symbols palette (a view in the bottom panel, shown for LaTeX files) and
// TeX: Insert Symbol… (a quick pick of the same catalogue). Clicking inserts at the cursor;
// math symbols typed outside math get $…$ around them; a selection becomes the first argument.

const vscode = require('vscode');
const symbols = require('./symbols');
const math = require('./math');
const { snippetText } = require('./language');

const isTex = (doc) => doc && (doc.languageId === 'latex' || doc.languageId === 'tex');
let lastEditor = null;
let context;

function activate(ctx) {
  context = ctx;
  const track = (ed) => {
    if (ed && isTex(ed.document)) lastEditor = ed;
    vscode.commands.executeCommand('setContext', 'texPreview.texActive', !!(ed && isTex(ed.document)) || !!lastEditor);
  };
  track(vscode.window.activeTextEditor);
  ctx.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(track),
    vscode.window.registerWebviewViewProvider('texPreview.symbols', new PaletteView(), { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.commands.registerCommand('texPreview.insertSymbol', pickSymbol),
    vscode.commands.registerCommand('texPreview.showSymbols', () => vscode.commands.executeCommand('texPreview.symbols.focus'))
  );
}

function targetEditor() {
  const ed = vscode.window.activeTextEditor;
  if (ed && isTex(ed.document)) return ed;
  if (lastEditor && vscode.window.visibleTextEditors.includes(lastEditor)) return lastEditor;
  return vscode.window.visibleTextEditors.find((e) => isTex(e.document)) || null;
}

async function insert(item) {
  let editor = targetEditor();
  if (!editor) {
    vscode.window.showInformationMessage('Open a LaTeX file to insert symbols.');
    return;
  }
  editor = await vscode.window.showTextDocument(editor.document, editor.viewColumn);
  let tex = item.tex;
  if (editor.selections.some((s) => !s.isEmpty)) tex = tex.replace(/\$\{1:[^}]*\}|\$1(?!\d)/, '${1:${TM_SELECTED_TEXT}}');
  if (item.math && !math.mathAt(editor.document, editor.selection.start, true)) {
    tex = item.display ? `\\[\n${tex}\n\\]` : `$${tex}$`;
  }
  await editor.insertSnippet(new vscode.SnippetString(snippetText(tex)));
  const recent = [item.tex, ...context.globalState.get('texPreview.recentSymbols', []).filter((t) => t !== item.tex)].slice(0, 16);
  context.globalState.update('texPreview.recentSymbols', recent);
  PaletteView.current?.postRecent();
}

const plain = (tex) => tex.replace(/\$\{\d+:([^}]*)\}/g, '$1').replace(/\$\d+/g, '…').replace(/\n\s*/g, ' ');

async function pickSymbol() {
  const recent = context.globalState.get('texPreview.recentSymbols', []);
  const toItem = (it) => ({ label: `${it.glyph} ${plain(it.tex)}`, description: it.name, detail: it.pkg ? `package ${it.pkg}` : undefined, it });
  const items = [];
  if (recent.length) {
    items.push({ label: 'Recent', kind: vscode.QuickPickItemKind.Separator });
    for (const t of recent) {
      const it = symbols.ALL.find((x) => x.tex === t);
      if (it) items.push(toItem(it));
    }
  }
  for (const cat of symbols.CATEGORIES) {
    items.push({ label: cat.name, kind: vscode.QuickPickItemKind.Separator });
    for (const it of cat.items) items.push(toItem({ ...it, category: cat.name }));
  }
  const picked = await vscode.window.showQuickPick(items, { title: 'Insert Symbol', placeHolder: 'Search by name or command, e.g. "alpha", "arrow", "matrix"', matchOnDescription: true });
  if (picked && picked.it) insert(picked.it);
}

class PaletteView {
  resolveWebviewView(view) {
    PaletteView.current = this;
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = this.html();
    view.webview.onDidReceiveMessage((msg) => {
      if (msg.type === 'insert') insert(symbols.ALL[msg.index]);
      if (msg.type === 'ready') this.postRecent();
    });
    view.onDidDispose(() => {
      if (PaletteView.current === this) PaletteView.current = null;
    });
  }

  postRecent() {
    const recent = context.globalState.get('texPreview.recentSymbols', []);
    this.view?.webview.postMessage({ type: 'recent', indices: recent.map((t) => symbols.ALL.findIndex((x) => x.tex === t)).filter((i) => i >= 0) });
  }

  html() {
    const nonce = Array.from({ length: 24 }, () => Math.floor(Math.random() * 36).toString(36)).join('');
    const data = symbols.ALL.map((it) => ({ g: it.glyph, t: plain(it.tex), n: it.name, c: it.category, p: it.pkg || '' }));
    const cats = symbols.CATEGORIES.map((c) => c.name);
    return `<!DOCTYPE html>
<html><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  body { padding: 0 8px 8px; font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); }
  .bar { position: sticky; top: 0; background: var(--vscode-panel-background, var(--vscode-sideBar-background)); padding: 6px 0; display: flex; flex-wrap: wrap; gap: 4px; align-items: center; z-index: 1; }
  input { flex: 1 1 160px; min-width: 120px; padding: 3px 6px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); border-radius: 2px; outline: none; }
  input:focus { border-color: var(--vscode-focusBorder); }
  .tab { font: inherit; color: var(--vscode-foreground); background: none; border: 1px solid transparent; border-radius: 10px; padding: 1px 8px; cursor: pointer; opacity: .75; }
  .tab:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground); }
  .tab.on { opacity: 1; border-color: var(--vscode-focusBorder); }
  h4 { margin: 8px 0 4px; font-weight: 600; font-size: 11px; text-transform: uppercase; opacity: .7; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(42px, 1fr)); gap: 3px; }
  .sym { height: 34px; font: inherit; font-size: 17px; line-height: 1; color: var(--vscode-foreground); background: var(--vscode-editorWidget-background, rgba(128,128,128,.08)); border: 1px solid var(--vscode-widget-border, rgba(128,128,128,.2)); border-radius: 4px; cursor: pointer; overflow: hidden; white-space: nowrap; padding: 0 2px; font-family: 'STIX Two Math', 'Cambria Math', 'Latin Modern Math', var(--vscode-font-family); }
  .sym.small { font-size: 12px; }
  .sym:hover { background: var(--vscode-list-hoverBackground); border-color: var(--vscode-focusBorder); }
  .sym:focus-visible { outline: 1px solid var(--vscode-focusBorder); }
  .hint { opacity: .6; margin: 6px 0; font-size: 11px; }
  #empty { opacity: .6; padding: 8px 0; }
</style></head>
<body>
  <div class="bar"><input id="q" type="search" placeholder="Search symbols: alpha, arrow, matrix…" aria-label="Search symbols"><span id="tabs"></span></div>
  <div id="list"></div>
  <div class="hint">Click to insert at the cursor. Math symbols get $…$ when typed outside math; a selection becomes the first argument.</div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const DATA = ${JSON.stringify(data)};
  const CATS = ${JSON.stringify(cats)};
  let recent = [];
  let cat = (vscode.getState() || {}).cat || 'All';
  const q = document.getElementById('q');
  const list = document.getElementById('list');
  const tabs = document.getElementById('tabs');

  function tab(name) {
    const b = document.createElement('button');
    b.className = 'tab' + (name === cat ? ' on' : '');
    b.textContent = name;
    b.onclick = () => { cat = name; vscode.setState({ cat }); render(); };
    return b;
  }
  function button(i) {
    const d = DATA[i];
    const b = document.createElement('button');
    b.className = 'sym' + ([...d.g].length > 2 ? ' small' : '');
    b.textContent = d.g;
    b.title = d.t + '  —  ' + d.n + (d.p ? '  (package ' + d.p + ')' : '');
    b.onclick = () => vscode.postMessage({ type: 'insert', index: i });
    return b;
  }
  function section(title, indices) {
    if (!indices.length) return;
    const h = document.createElement('h4');
    h.textContent = title;
    const g = document.createElement('div');
    g.className = 'grid';
    indices.forEach((i) => g.appendChild(button(i)));
    list.append(h, g);
  }
  function render() {
    tabs.replaceChildren(...['All', ...CATS].map(tab));
    list.replaceChildren();
    const term = q.value.trim().toLowerCase();
    const match = (d) => !term || d.n.toLowerCase().includes(term) || d.t.toLowerCase().includes(term) || d.g === term;
    const idx = DATA.map((d, i) => i).filter((i) => match(DATA[i]));
    if (term) section('Results', idx);
    else {
      if (cat === 'All' && recent.length) section('Recent', recent);
      for (const c of CATS) if (cat === 'All' || cat === c) section(c, idx.filter((i) => DATA[i].c === c));
    }
    if (!list.children.length) list.innerHTML = '<div id="empty">No symbols match.</div>';
  }
  q.addEventListener('input', render);
  q.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { const first = list.querySelector('.sym'); if (first) first.click(); }
  });
  window.addEventListener('message', (e) => { if (e.data.type === 'recent') { recent = e.data.indices; render(); } });
  render();
  vscode.postMessage({ type: 'ready' });
</script>
</body></html>`;
  }
}

module.exports = { activate, insert, pickSymbol, PaletteView };
