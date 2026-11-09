'use strict';

// Pasting and dropping into .tex files:
// - paste an image (a screenshot) → saved under figures/ and inserted as a figure; the paste
//   menu also offers "\includegraphics only" and "Convert to LaTeX with AI" (an equation, a table…);
// - drop image files from the Explorer or the desktop → \includegraphics (copied into figures/
//   when they're outside the project); drop .tex files → \input.

const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const project = require('./project');

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.pdf', '.eps', '.gif', '.svg']);
// Formats pdflatex/xelatex can include (screenshots arrive as PNG on every OS).
const MIME_EXT = { 'image/png': '.png', 'image/jpeg': '.jpg' };

/** Where pasted images go: the first \graphicspath folder, else figures/ next to the main file. */
function figureDir(root) {
  const text = project.read(root)?.text || '';
  const gp = /\\graphicspath\s*\{\s*\{([^}]*)\}/.exec(project.stripComments(text));
  return path.resolve(path.dirname(root), gp ? gp[1] : 'figures');
}

/** How \includegraphics should name `file`: relative to a \graphicspath folder or the main file, '/' separators. */
function graphicsName(root, file) {
  const rootDir = path.dirname(root);
  const text = project.stripComments(project.read(root)?.text || '');
  const gp = /\\graphicspath\s*\{((?:\s*\{[^}]*\})+)\s*\}/.exec(text);
  for (const m of gp ? gp[1].matchAll(/\{([^}]*)\}/g) : []) {
    const rel = path.relative(path.resolve(rootDir, m[1]), file);
    if (!rel.startsWith('..') && !path.isAbsolute(rel)) return rel.split(path.sep).join('/');
  }
  return path.relative(rootDir, file).split(path.sep).join('/');
}

const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);

function unusedName(dir, base, ext) {
  let name = base + ext;
  for (let n = 2; fs.existsSync(path.join(dir, name)); n++) name = `${base}-${n}${ext}`;
  return name;
}

/** \usepackage{graphicx} in the main file, if it isn't loaded yet (added to `edit`). */
function ensureGraphicx(edit, root) {
  const text = project.read(root)?.text || '';
  if (/\\usepackage\s*(\[[^\]]*\])?\s*\{[^}]*\bgraphicx?\b[^}]*\}/.test(text) || /\\documentclass\s*(\[[^\]]*\])?\s*\{beamer\}/.test(text)) return;
  const b = text.indexOf('\\begin{document}');
  if (b < 0) return;
  const line = text.slice(0, b).split('\n').length - 1;
  edit.insert(vscode.Uri.file(root), new vscode.Position(line, 0), '\\usepackage{graphicx}\n');
}

const label = (name) => 'fig:' + name.replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9-]+/g, '-').toLowerCase();

function figureSnippet(name, base) {
  const s = new vscode.SnippetString();
  s.appendText('\\begin{figure}[htbp]\n\t\\centering\n\t\\includegraphics[width=0.8\\linewidth]{');
  s.appendText(name);
  s.appendText('}\n\t\\caption{');
  s.appendPlaceholder('Caption');
  s.appendText('}\n\t\\label{');
  s.appendText(label(base));
  s.appendText('}\n\\end{figure}\n');
  return s;
}

function includeSnippet(name) {
  const s = new vscode.SnippetString();
  s.appendText('\\includegraphics[width=');
  s.appendPlaceholder('0.8\\linewidth');
  s.appendText(']{' + name + '}');
  return s;
}

function rootOf(doc) {
  return doc.uri.scheme === 'file' ? project.findRoot(doc.uri.fsPath) : null;
}

/** The pasted image: {data, mime}, or null. */
async function pastedImage(dataTransfer, token) {
  for (const mime of Object.keys(MIME_EXT)) {
    const item = dataTransfer.get(mime);
    const file = item && item.asFile();
    if (!file) continue;
    const data = await file.data();
    return data && !token.isCancellationRequested ? { data, mime } : null;
  }
  return null;
}

/** Image as a figure, or as \includegraphics. */
class PasteProvider {
  constructor(kinds) {
    this.kinds = kinds;
  }

  async provideDocumentPasteEdits(doc, ranges, dataTransfer, context, token) {
    const root = rootOf(doc);
    if (!root) return;
    const img = await pastedImage(dataTransfer, token);
    if (!img) return;
    const { data, mime } = img;

    const dir = figureDir(root);
    const ext = MIME_EXT[mime];
    const name = unusedName(dir, `pasted-${stamp()}`, ext);
    const target = path.join(dir, name);
    const gname = graphicsName(root, target);
    // The image file is only written if one of these edits is applied.
    const save = () => {
      const edit = new vscode.WorkspaceEdit();
      edit.createFile(vscode.Uri.file(target), { contents: data, ignoreIfExists: true });
      ensureGraphicx(edit, root);
      return edit;
    };

    const figure = new vscode.DocumentPasteEdit(figureSnippet(gname, name), 'Insert image as a figure', this.kinds.figure);
    figure.additionalEdit = save();
    const include = new vscode.DocumentPasteEdit(includeSnippet(gname), 'Insert image with \\includegraphics', this.kinds.include);
    include.additionalEdit = save();
    return [figure, include];
  }
}

/**
 * "Convert image to LaTeX with AI". A provider of its own: its text is only worked out (by
 * resolveDocumentPasteEdit) if the person picks it, and the figure edits above stay plain.
 */
class AiPasteProvider {
  constructor(kind, yieldTo) {
    this.kind = kind;
    this.yieldTo = yieldTo;
  }

  async provideDocumentPasteEdits(doc, ranges, dataTransfer, context, token) {
    if (!rootOf(doc)) return;
    const img = await pastedImage(dataTransfer, token);
    if (!img) return;
    const ai = new vscode.DocumentPasteEdit('', 'Convert image to LaTeX with AI (equation, table, notes)', this.kind);
    ai.yieldTo = this.yieldTo; // never the default: it costs a model call
    ai.image = { ...img, doc };
    return [ai];
  }

  async resolveDocumentPasteEdit(edit, token) {
    if (!edit.image) return edit;
    const text = await require('./ai').imageToLatex(edit.image.doc, edit.image);
    if (token.isCancellationRequested) return edit;
    edit.insertText = text || '';
    return edit;
  }
}

class DropProvider {
  constructor(kind) {
    this.kind = kind;
  }

  async provideDocumentDropEdits(doc, position, dataTransfer, token) {
    const root = rootOf(doc);
    if (!root) return;
    const list = await dataTransfer.get('text/uri-list')?.asString();
    if (!list || token.isCancellationRequested) return;
    const uris = list
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'))
      .map((l) => vscode.Uri.parse(l))
      .filter((u) => u.scheme === 'file');
    if (!uris.length) return;

    const rootDir = path.dirname(root);
    const edit = new vscode.WorkspaceEdit();
    const snippet = new vscode.SnippetString();
    let images = 0;
    let n = 0;
    for (const u of uris) {
      const ext = path.extname(u.fsPath).toLowerCase();
      const inside = !path.relative(rootDir, u.fsPath).startsWith('..');
      if (n++) snippet.appendText('\n');
      if (IMAGE_EXT.has(ext)) {
        let file = u.fsPath;
        if (!inside) {
          // From outside the project: copy it in, so the project stays self-contained (and syncs).
          const dir = figureDir(root);
          file = path.join(dir, unusedName(dir, path.basename(u.fsPath, ext).replace(/[^\w.-]+/g, '-'), ext));
          edit.createFile(vscode.Uri.file(file), { contents: fs.readFileSync(u.fsPath), ignoreIfExists: true });
        }
        const name = graphicsName(root, file);
        if (uris.length === 1) snippet.value += figureSnippet(name, path.basename(file)).value;
        else snippet.appendText(`\\includegraphics[width=0.8\\linewidth]{${name}}`);
        images++;
      } else if (ext === '.tex' && inside) {
        snippet.appendText(`\\input{${path.relative(rootDir, u.fsPath).split(path.sep).join('/').replace(/\.tex$/i, '')}}`);
      } else if (ext === '.bib' && inside) {
        snippet.appendText(`\\bibliography{${path.relative(rootDir, u.fsPath).split(path.sep).join('/').replace(/\.bib$/i, '')}}`);
      } else {
        return; // something else: leave it to VS Code's own drop
      }
    }
    if (images) ensureGraphicx(edit, root);
    const drop = new vscode.DocumentDropEdit(snippet, images ? 'Insert as LaTeX figure' : 'Insert as \\input', this.kind);
    drop.additionalEdit = edit;
    return [drop];
  }
}

function activate(context) {
  const L = vscode.languages;
  if (!L.registerDocumentPasteEditProvider || !vscode.DocumentDropOrPasteEditKind || !vscode.DocumentPasteEdit) return; // VS Code before 1.97
  const base = vscode.DocumentDropOrPasteEditKind.Empty.append('latex');
  const kinds = { figure: base.append('figure'), include: base.append('includegraphics'), ai: base.append('ai') };
  const selector = [{ language: 'latex' }, { language: 'tex' }];
  context.subscriptions.push(
    L.registerDocumentPasteEditProvider(selector, new PasteProvider(kinds), { providedPasteEditKinds: [kinds.figure, kinds.include], pasteMimeTypes: Object.keys(MIME_EXT) }),
    L.registerDocumentPasteEditProvider(selector, new AiPasteProvider(kinds.ai, [kinds.figure, kinds.include]), { providedPasteEditKinds: [kinds.ai], pasteMimeTypes: Object.keys(MIME_EXT) }),
    L.registerDocumentDropEditProvider(selector, new DropProvider(base.append('drop')), { providedDropEditKinds: [base.append('drop')], dropMimeTypes: ['text/uri-list'] })
  );
}

module.exports = { activate, graphicsName, figureDir, PasteProvider, AiPasteProvider, DropProvider };
