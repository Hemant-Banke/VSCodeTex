'use strict';

// TeX: Add Citation… — fetches BibTeX for a DOI or an arXiv paper, or picks references in Zotero
// (with the Better BibTeX add-on), adds what's missing to the project's .bib file and cites it at
// the cursor. An entry already in the .bib (same key, DOI or arXiv id) is reused, not duplicated.

const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const project = require('./project');

const isTex = (doc) => doc && (doc.languageId === 'latex' || doc.languageId === 'tex');
const ZOTERO = 'http://127.0.0.1:23119/better-bibtex/cayw';

/** {kind: 'doi'|'arxiv', id} from a DOI, an arXiv id, or a doi.org / arxiv.org URL. */
function parseId(input) {
  const s = input.trim();
  const arxiv = /(?:arxiv\.org\/(?:abs|pdf)\/|arxiv:\s*|^)(\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?\/\d{7})(?:v\d+)?(?:\.pdf)?$/i.exec(s);
  if (arxiv) return { kind: 'arxiv', id: arxiv[1] };
  const doi = /(10\.\d{4,9}\/[^\s"<>]+)/.exec(decodeURIComponent(s));
  if (doi) {
    const id = doi[1].replace(/[.,;]+$/, '');
    const ax = /^10\.48550\/arxiv\.(.+)$/i.exec(id);
    return ax ? { kind: 'arxiv', id: ax[1] } : { kind: 'doi', id };
  }
  return null;
}

async function fetchText(url, headers = {}) {
  const res = await fetch(url, { headers: { 'User-Agent': 'TeX-Side-Preview (VS Code extension)', ...headers }, redirect: 'follow', signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(res.status === 404 ? 'not found' : `${new URL(url).host} answered ${res.status}`);
  return res.text();
}

/** BibTeX for a DOI (content negotiation at doi.org) or an arXiv id (arXiv's own export). */
async function fetchBibtex(ref) {
  const text = ref.kind === 'arxiv' ? await fetchText(`https://arxiv.org/bibtex/${encodeURIComponent(ref.id)}`) : await fetchText(`https://doi.org/${ref.id.split('/').map(encodeURIComponent).join('/')}`, { Accept: 'application/x-bibtex; charset=utf-8' });
  if (!/@\s*\w+\s*[{(]/.test(text)) throw new Error('no BibTeX came back');
  return text;
}

const field = (e, name) => (e.fields || []).find((f) => f.name === name)?.value || '';
const norm = (s) => s.toLowerCase().replace(/^https?:\/\/(dx\.)?doi\.org\//, '').trim();

/** A readable key like smith2020deep, from the entry's first author, year and title. */
function niceKey(e) {
  const author = field(e, 'author').split(/\s+and\s+/)[0] || '';
  const last = (author.includes(',') ? author.split(',')[0] : author.trim().split(/\s+/).pop() || 'ref').normalize('NFD').replace(/[^a-zA-Z]/g, '').toLowerCase();
  const year = (field(e, 'year') || field(e, 'date')).match(/\d{4}/)?.[0] || '';
  const stop = new Set(['a', 'an', 'the', 'on', 'of', 'for', 'and', 'in', 'to', 'with', 'towards', 'toward']);
  const word = field(e, 'title').normalize('NFD').toLowerCase().replace(/[^a-z\s]/g, ' ').split(/\s+/).find((w) => w && !stop.has(w)) || '';
  return (last || 'ref') + year + word;
}

/** One field per line, as Format Document writes it. */
function formatEntry(e, key) {
  const width = Math.max(0, ...e.fields.map((f) => f.name.length));
  return `@${e.type}{${key},\n${e.fields.map((f) => `  ${f.name.padEnd(width)} = ${f.raw.replace(/\s*\n\s*/g, ' ')},`).join('\n')}\n}\n`;
}

/**
 * Merges fetched BibTeX into the project's entries: returns the keys to cite and the text to
 * append (only entries that aren't there yet, with keys that don't clash).
 */
function merge(bibtex, existing, { rekey }) {
  const keys = [];
  let append = '';
  const taken = new Set(existing.map((e) => e.key));
  for (const e of project.parseBib(bibtex).filter((x) => x.key && x.fields)) {
    const doi = norm(field(e, 'doi'));
    const eprint = field(e, 'eprint').toLowerCase();
    const same = existing.find((x) => (doi && norm(field(x, 'doi')) === doi) || (eprint && field(x, 'eprint').toLowerCase() === eprint) || (!rekey && x.key === e.key));
    if (same) {
      keys.push(same.key);
      continue;
    }
    let key = rekey ? niceKey(e) : e.key;
    for (let n = 0, base = key; taken.has(key); n++) key = base + String.fromCharCode(97 + (n % 26)) + (n >= 26 ? Math.floor(n / 26) : '');
    taken.add(key);
    keys.push(key);
    append += (append ? '\n' : '') + formatEntry(e, key);
  }
  return { keys, append };
}

/** The .bib to add to: the project's first one, or a new references.bib (wired into the root). */
async function targetBib(file) {
  const p = project.project(file);
  if (p.bibs.length) return { bib: p.bibs[0], root: p.root };
  const bib = path.join(p.rootDir, 'references.bib');
  if (!fs.existsSync(bib)) fs.writeFileSync(bib, '');
  const rootDoc = await vscode.workspace.openTextDocument(p.root);
  const text = rootDoc.getText();
  const end = text.lastIndexOf('\\end{document}');
  if (end >= 0) {
    const biblatex = /\\usepackage\s*(\[[^\]]*\])?\s*\{biblatex\}/.test(text);
    const head = text.indexOf('\\begin{document}');
    const edit = new vscode.WorkspaceEdit();
    if (biblatex) {
      if (head >= 0) edit.insert(rootDoc.uri, rootDoc.positionAt(head), '\\addbibresource{references.bib}\n');
      edit.insert(rootDoc.uri, rootDoc.positionAt(end), '\\printbibliography\n\n');
    } else {
      edit.insert(rootDoc.uri, rootDoc.positionAt(end), '\\bibliographystyle{plain}\n\\bibliography{references}\n\n');
    }
    await vscode.workspace.applyEdit(edit);
    vscode.window.setStatusBarMessage('Created references.bib and added the bibliography to the main file', 5000);
  }
  project.forget(file);
  return { bib, root: p.root };
}

async function appendToBib(bib, text) {
  const doc = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === bib);
  if (doc) {
    const cur = doc.getText();
    const sep = !cur.trim() ? '' : cur.endsWith('\n\n') ? '' : cur.endsWith('\n') ? '\n' : '\n\n';
    const edit = new vscode.WorkspaceEdit();
    edit.insert(doc.uri, doc.positionAt(cur.length), sep + text);
    await vscode.workspace.applyEdit(edit);
    await doc.save();
  } else {
    const cur = fs.existsSync(bib) ? fs.readFileSync(bib, 'utf8') : '';
    const sep = !cur.trim() ? '' : cur.endsWith('\n\n') ? '' : cur.endsWith('\n') ? '\n' : '\n\n';
    fs.appendFileSync(bib, sep + text);
  }
  project.forget(bib);
}

/** \cite{keys} at the cursor, or just the keys when the cursor is already inside a \cite{…}. */
async function insertCite(editor, keys) {
  const pos = editor.selection.active;
  const before = editor.document.lineAt(pos.line).text.slice(0, pos.character);
  const inCite = /\\[a-zA-Z]*cite[a-zA-Z]*\*?\s*(?:\[[^\]]*\]\s*){0,2}\{([^}]*)$/.exec(before);
  let text;
  if (inCite) text = (inCite[1].trim() && !/,\s*$/.test(inCite[1]) ? ',' : '') + keys.join(',');
  else text = (/[\p{L}\p{N}.,;:)]$/u.test(before) ? '~' : '') + `\\cite{${keys.join(',')}}`;
  await editor.edit((e) => e.replace(editor.selection, text));
}

async function zoteroReady() {
  try {
    return (await fetchText(`${ZOTERO}?probe=1`)).trim() === 'ready';
  } catch {
    return false;
  }
}

async function addCitation(arg) {
  const editor = vscode.window.activeTextEditor;
  if (!editor || !isTex(editor.document) || editor.document.uri.scheme !== 'file') return vscode.window.showInformationMessage('Open a .tex file to add a citation.');
  const file = editor.document.uri.fsPath;

  let input = typeof arg === 'string' ? arg : null;
  let fromZotero = false;
  if (!input) {
    const qp = vscode.window.createQuickPick();
    qp.title = 'Add citation';
    qp.placeholder = 'Paste a DOI, an arXiv id or a doi.org / arxiv.org link';
    qp.ignoreFocusOut = true;
    // alwaysShow: the quick pick would otherwise filter these out against the pasted link.
    const zItem = { label: '$(library) Pick from Zotero…', description: 'needs Zotero with the Better BibTeX add-on', zotero: true, alwaysShow: true };
    qp.items = [zItem];
    qp.onDidChangeValue((v) => {
      const ref = v.trim() && parseId(v);
      qp.items = ref ? [{ label: `$(cloud-download) Fetch ${ref.kind === 'doi' ? 'DOI' : 'arXiv'} ${ref.id}`, description: ref.kind === 'doi' ? 'from doi.org' : 'from arxiv.org', ref: v, alwaysShow: true }, zItem] : [zItem];
    });
    const picked = await new Promise((resolve) => {
      qp.onDidAccept(() => resolve(qp.selectedItems[0] || (qp.value.trim() ? { ref: qp.value } : null)));
      qp.onDidHide(() => resolve(null));
      qp.show();
    });
    qp.dispose();
    if (!picked) return;
    if (picked.zotero) fromZotero = true;
    else input = picked.ref;
  }

  let bibtex;
  try {
    if (fromZotero) {
      if (!(await zoteroReady())) {
        const pick = await vscode.window.showWarningMessage('Zotero is not reachable. Start Zotero, and install the Better BibTeX add-on if you haven’t.', 'Get Better BibTeX');
        if (pick) vscode.env.openExternal(vscode.Uri.parse('https://retorque.re/zotero-better-bibtex/installation/'));
        return;
      }
      const translator = /\\usepackage\s*(\[[^\]]*\])?\s*\{biblatex\}/.test(project.read(project.findRoot(file))?.text || '') ? 'biblatex' : 'bibtex';
      // Brings up Zotero's picker and returns the chosen items exported as BibTeX.
      bibtex = await fetchText(`${ZOTERO}?format=translate&translator=${translator}&minimize=1`);
      if (!bibtex.trim()) return; // picker cancelled
    } else {
      const ref = parseId(input || '');
      if (!ref) return vscode.window.showWarningMessage(`"${input}" doesn't look like a DOI or an arXiv id.`);
      bibtex = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: `Fetching ${ref.id}…` }, () => fetchBibtex(ref));
    }
  } catch (e) {
    return vscode.window.showErrorMessage(`Add citation: ${e.message}.`);
  }

  const { bib } = await targetBib(file);
  const existing = project.project(file).entries();
  // Zotero keys are the person's own (Better BibTeX citekeys); fetched ones get readable keys.
  const { keys, append } = merge(bibtex, existing, { rekey: !fromZotero });
  if (!keys.length) return vscode.window.showWarningMessage('Add citation: the BibTeX that came back had no entries.');
  if (append) await appendToBib(bib, append);
  await insertCite(editor, keys);
  vscode.window.setStatusBarMessage(append ? `Added ${keys.join(', ')} to ${path.basename(bib)}` : `Cited ${keys.join(', ')} (already in ${path.basename(bib)})`, 5000);
  return keys;
}

/** For tools: add a DOI/arXiv reference to the project of `file`; returns {keys, bib}. */
async function addReference(file, input) {
  const ref = parseId(input || '');
  if (!ref) throw new Error(`"${input}" is not a DOI or an arXiv id`);
  const bibtex = await fetchBibtex(ref);
  const { bib } = await targetBib(file);
  const { keys, append } = merge(bibtex, project.project(file).entries(), { rekey: true });
  if (append) await appendToBib(bib, append);
  return { keys, bib, added: !!append };
}

function activate(context) {
  context.subscriptions.push(vscode.commands.registerCommand('texPreview.addCitation', addCitation));
}

module.exports = { activate, parseId, fetchBibtex, merge, niceKey, addReference };
