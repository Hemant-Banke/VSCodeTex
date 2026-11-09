'use strict';

// Tools for AI agents (GitHub Copilot agent mode and other VS Code chat agents), through VS Code's
// Language Model Tools API: build the project and read its errors, see its structure, labels and
// references, and add a reference by DOI or arXiv id. With them an agent can write LaTeX, compile,
// and fix what broke, the way it works on code.

const vscode = require('vscode');
const path = require('path');
const project = require('./project');
const structure = require('./structure');

let api; // { compile(file) -> {root, ok, message, errors, warnings} } from extension.js

/** The .tex file a tool call is about: its `file` input (absolute or workspace-relative), else the active editor. */
function texFile(input) {
  let f = input && typeof input.file === 'string' && input.file.trim();
  if (f) {
    if (f.startsWith('file://')) f = vscode.Uri.parse(f).fsPath;
    if (!path.isAbsolute(f)) {
      const ws = vscode.workspace.workspaceFolders?.[0];
      if (ws) f = path.join(ws.uri.fsPath, f);
    }
    return f;
  }
  const ed = vscode.window.activeTextEditor;
  if (ed && /\.(tex|rnw|jnw)$/i.test(ed.document.uri.fsPath) && ed.document.uri.scheme === 'file') return ed.document.uri.fsPath;
  const tex = vscode.window.visibleTextEditors.find((e) => /\.tex$/i.test(e.document.uri.fsPath));
  if (tex) return tex.document.uri.fsPath;
  throw new Error('No .tex file given and none is open. Pass "file": the path of a .tex file of the project.');
}

const result = (text) => new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(text)]);

function rel(root, f) {
  return path.relative(path.dirname(root), f).split(path.sep).join('/') || path.basename(f);
}

const compileTool = {
  prepareInvocation() {
    return { invocationMessage: 'Compiling the LaTeX project' };
  },
  async invoke(options) {
    const file = texFile(options.input);
    const r = await api.compile(file);
    const lines = [`Project main file: ${r.root}`, `Result: ${r.ok ? 'compiled successfully' : 'FAILED'} — ${r.message}`];
    if (r.errors.length) {
      lines.push('', `Errors (${r.errors.length}):`);
      for (const e of r.errors.slice(0, 40)) lines.push(`- ${rel(r.root, e.file)}:${e.line}: ${e.message}`);
    }
    if (r.warnings.length) {
      lines.push('', `Warnings (${r.warnings.length}${r.warnings.length > 40 ? ', first 40' : ''}):`);
      for (const w of r.warnings.slice(0, 40)) lines.push(`- ${rel(r.root, w.file)}:${w.line}: ${w.message}`);
    }
    if (!r.ok && !r.errors.length) lines.push('', 'No error lines were parsed; the compile log is in the "TeX Preview" output channel.');
    return result(lines.join('\n'));
  },
};

const infoTool = {
  prepareInvocation() {
    return { invocationMessage: 'Reading the LaTeX project structure' };
  },
  async invoke(options) {
    const file = texFile(options.input);
    const p = project.project(file);
    const root = p.root;
    const out = [`Main file: ${root}`, `Files (\\input/\\include tree): ${p.files.map((f) => rel(root, f)).join(', ')}`];
    const rootText = project.read(root)?.text || '';
    const cls = /\\documentclass\s*(\[[^\]]*\])?\s*\{([^}]+)\}/.exec(rootText);
    if (cls) out.push(`Document class: ${cls[2]}${cls[1] || ''}`);
    const pkgs = [...project.stripComments(rootText).matchAll(/\\usepackage\s*(?:\[[^\]]*\])?\s*\{([^}]+)\}/g)].flatMap((m) => m[1].split(',').map((x) => x.trim()));
    if (pkgs.length) out.push(`Packages: ${pkgs.join(', ')}`);
    if (p.macros.length) out.push(`Macros: ${p.macros.slice(0, 80).map((m) => '\\' + m.name + (m.args ? `[${m.args}]` : '')).join(' ')}`);
    try {
      const secs = structure.projectSections(root);
      if (secs.length) {
        out.push('', 'Outline:');
        for (const s of secs.slice(0, 200)) out.push(`${'  '.repeat(Math.max(0, s.level - 1))}- ${[s.number, s.title].filter(Boolean).join(' ')} (${rel(root, s.file)}:${s.line + 1})`);
      }
    } catch {
      /* no outline */
    }
    if (p.labels.length) {
      out.push('', `Labels (${p.labels.length}): ${p.labels.slice(0, 300).map((l) => `${l.name} (${rel(root, l.file)}:${l.line + 1})`).join(', ')}`);
    }
    const entries = p.entries();
    out.push('', `Bibliography: ${p.bibs.map((b) => rel(root, b)).join(', ') || 'no .bib file'}; ${entries.length} entries`);
    for (const e of entries.slice(0, 300)) {
      const f = Object.fromEntries((e.fields || []).map((x) => [x.name, x.value]));
      out.push(`- ${e.key}: ${(f.author || '').split(/\s+and\s+/)[0]}${f.year ? ` (${f.year})` : ''} ${f.title || ''}`.trim());
    }
    return result(out.join('\n'));
  },
};

const citeTool = {
  prepareInvocation(options) {
    return {
      invocationMessage: `Adding ${options.input.id} to the bibliography`,
      confirmationMessages: { title: 'Add a reference', message: new vscode.MarkdownString(`Fetch the BibTeX for **${options.input.id}** and add it to the project's .bib file?`) },
    };
  },
  async invoke(options) {
    const file = texFile(options.input);
    const r = await require('./cite').addReference(file, options.input.id);
    return result(`${r.added ? 'Added' : 'Already present'} in ${r.bib}. Cite it with \\cite{${r.keys.join(',')}}.`);
  },
};

function activate(context, extensionApi) {
  api = extensionApi;
  if (!vscode.lm || !vscode.lm.registerTool || !vscode.LanguageModelToolResult) return; // VS Code before 1.95
  context.subscriptions.push(
    vscode.lm.registerTool('texpreview_compile', compileTool),
    vscode.lm.registerTool('texpreview_project', infoTool),
    vscode.lm.registerTool('texpreview_addReference', citeTool)
  );
}

module.exports = { activate };
