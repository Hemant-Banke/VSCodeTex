'use strict';

// Completions and hovers: \cite keys, \ref labels, commands, environments, file paths, packages,
// `@` shortcuts; previews of math, citations, references, images and packages on hover.

const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const os = require('os');
const project = require('./project');
const math = require('./math');
const { environments } = require('./structure');
const { which, exec } = require('./tools');
const { COMMANDS, ENVIRONMENTS, MATH_ENVS, AT, ENV_SHORTCUTS, FONT_SHORTCUTS, PACKAGES } = require('./data');
const symbols = require('./symbols');

const CITE = /\\(?:[a-zA-Z]*cite[a-zA-Z]*|bibentry)\*?\s*(?:\[[^\]]*\]\s*){0,2}\{([^}]*)$/;
const REF = /\\(?:ref|eqref|pageref|autoref|nameref|vref|cref|Cref|cpageref|Cpageref|labelcref|subref)\*?\s*\{([^}]*)$/;
const ENV = /\\(begin|end)\s*\{([^}]*)$/;
const FILE = /\\(input|include|subfile|includegraphics|bibliography|addbibresource|includeonly|includepdf|lstinputlisting|includestandalone)\*?\s*(?:\[[^\]]*\]\s*)?\{([^}]*)$/;
const PKG = /\\(?:usepackage|RequirePackage)\s*(?:\[[^\]]*\]\s*)?\{([^}]*)$/;
const IMAGE_EXT = ['.pdf', '.png', '.jpg', '.jpeg', '.eps', '.svg', '.gif'];

/** TeX with plain backslashes → VS Code snippet syntax ($1 / ${1:…} stay placeholders, other $ are literal). */
const snippetText = (tex) => tex.replace(/\\/g, '\\\\').replace(/\$(?![\d{])/g, '\\$');
const snippet = (tex) => new vscode.SnippetString(snippetText(tex));

const md = (s) => {
  const m = new vscode.MarkdownString(s);
  m.supportThemeIcons = true;
  return m;
};

function fsPathOf(doc) {
  return doc.uri.scheme === 'file' ? doc.uri.fsPath : null;
}

/** Range of the comma-separated item being typed inside {…}, extended over what follows the cursor. */
function argRange(doc, pos, typedSoFar) {
  const typed = typedSoFar.split(',').pop().replace(/^\s+/, '');
  const after = doc.lineAt(pos.line).text.slice(pos.character).match(/^[^,}\s]*/)[0];
  return new vscode.Range(pos.translate(0, -typed.length), pos.translate(0, after.length));
}

// ---------------------------------------------------------------------------
// Completion

class CompletionProvider {
  provideCompletionItems(doc, pos) {
    const line = doc.lineAt(pos.line).text;
    const before = line.slice(0, pos.character);
    const file = fsPathOf(doc);
    let m;

    if ((m = before.match(CITE)) && file) return this.cites(doc, pos, m[1], file);
    if ((m = before.match(REF)) && file) return this.refs(doc, pos, m[1], file);
    if ((m = before.match(ENV))) return this.envs(doc, pos, m[1], m[2], file);
    if ((m = before.match(FILE)) && file) return this.files(doc, pos, m[1], m[2], file);
    if ((m = before.match(PKG))) return this.packages(doc, pos, m[1]);
    if ((m = before.match(/\\([a-zA-Z]*)$/)) && !/\\\\[a-zA-Z]*$/.test(before)) return this.commands(doc, pos, m[1], file);
    if ((m = before.match(/(?:^|[^\\a-zA-Z0-9@])@([a-zA-Z]{0,2}|[^\sa-zA-Z])$/))) return this.at(pos, m[1]);
    // Ask again on every keystroke while an uppercase shortcut (BEQ, FIT, …) may still be forming.
    if ((m = before.match(/(?:^|[^\\a-zA-Z])([BFM][A-Z]{0,3})$/))) return new vscode.CompletionList(this.shortcuts(pos, m[1]), true);
    return undefined;
  }

  cites(doc, pos, typed, file) {
    const range = argRange(doc, pos, typed);
    return project.project(file).entries().map((e) => {
      const f = Object.fromEntries(e.fields.map((x) => [x.name, x.value]));
      const item = new vscode.CompletionItem({ label: e.key, description: shortAuthors(f.author || f.editor) + (f.year ? ` ${f.year}` : '') }, vscode.CompletionItemKind.Reference);
      item.range = range;
      item.detail = f.title || e.type;
      item.filterText = [e.key, f.author, f.title].filter(Boolean).join(' ');
      item.documentation = md(citationMarkdown(e, f));
      return item;
    });
  }

  refs(doc, pos, typed, file) {
    const range = argRange(doc, pos, typed);
    const p = project.project(file);
    const numbers = auxLabels(p.root);
    return p.labels.map((l, i) => {
      const item = new vscode.CompletionItem({ label: l.name, description: numbers[l.name] ? `(${numbers[l.name]})` : undefined }, vscode.CompletionItemKind.Reference);
      item.range = range;
      item.sortText = String(i).padStart(5, '0');
      const ctx = labelContext(l);
      item.detail = ctx.title;
      item.documentation = ctx.code ? md('```latex\n' + ctx.code + '\n```') : undefined;
      return item;
    });
  }

  envs(doc, pos, which, typed, file) {
    const line = doc.lineAt(pos.line).text;
    const rest = line.slice(pos.character);
    const tail = rest.match(/^[^}\s]*\}?/)[0];
    const range = new vscode.Range(pos.translate(0, -typed.length), pos.translate(0, tail.length));
    const fresh = /^\}?\s*$/.test(rest); // typing a new \begin{…}, not editing an existing one

    if (which === 'end') {
      const open = environments(doc.getText().slice(0, doc.offsetAt(pos))).unclosed.reverse();
      const names = [...new Set([...open.map((t) => t.name), ...ENVIRONMENTS.map((e) => e[0])])];
      return names.map((name, i) => {
        const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.EnumMember);
        item.range = range;
        item.insertText = name + '}';
        item.sortText = String(i).padStart(4, '0');
        item.preselect = i === 0 && open.length > 0;
        return item;
      });
    }

    const user = file ? project.project(file).envs : [];
    const all = [...ENVIRONMENTS, ...user.filter((n) => !ENVIRONMENTS.some((e) => e[0] === n)).map((n) => [n, '', 'Defined in this project'])];
    return all.map(([name, args, desc, list]) => {
      const item = new vscode.CompletionItem({ label: name, description: desc }, vscode.CompletionItemKind.Module);
      item.range = range;
      const body = list ? '\t\\item $0' : '\t$0';
      item.insertText = fresh ? snippet(`${name}}${args}\n${body}\n\\end{${name}}`) : name + (tail.endsWith('}') ? '}' : '');
      return item;
    });
  }

  files(doc, pos, cmd, typed, file) {
    const rootDir = path.dirname(project.findRoot(file));
    const typedItem = typed.split(',').pop().replace(/^\s+/, '');
    const dirPart = typedItem.includes('/') ? typedItem.slice(0, typedItem.lastIndexOf('/') + 1) : '';
    const range = new vscode.Range(pos.translate(0, -(typedItem.length - dirPart.length)), pos);
    const want =
      cmd === 'includegraphics' ? IMAGE_EXT : /bib/.test(cmd) ? ['.bib'] : cmd === 'includepdf' ? ['.pdf'] : cmd === 'lstinputlisting' ? null : ['.tex'];
    const strip = cmd === 'bibliography' ? '.bib' : /^(include|includeonly|subfile)$/.test(cmd) ? '.tex' : null;
    const outDir = vscode.workspace.getConfiguration('texPreview').get('outDir') || '';
    let names = [];
    try {
      names = fs.readdirSync(path.join(rootDir, dirPart), { withFileTypes: true });
    } catch {
      return [];
    }
    const items = [];
    for (const d of names) {
      if (d.name.startsWith('.') || d.name === 'node_modules' || d.name === outDir) continue;
      if (d.isDirectory()) {
        const item = new vscode.CompletionItem(d.name + '/', vscode.CompletionItemKind.Folder);
        item.range = range;
        item.command = { command: 'editor.action.triggerSuggest', title: '' };
        items.push(item);
      } else if (!want || want.includes(path.extname(d.name).toLowerCase())) {
        const item = new vscode.CompletionItem(d.name, vscode.CompletionItemKind.File);
        item.range = range;
        item.insertText = strip && d.name.toLowerCase().endsWith(strip) ? d.name.slice(0, -strip.length) : d.name;
        items.push(item);
      }
    }
    return items;
  }

  packages(doc, pos, typed) {
    const range = argRange(doc, pos, typed);
    return PACKAGES.map(([name, desc]) => {
      const item = new vscode.CompletionItem({ label: name, description: desc }, vscode.CompletionItemKind.Module);
      item.range = range;
      return item;
    });
  }

  commands(doc, pos, typed, file) {
    const range = new vscode.Range(pos.translate(0, -typed.length - 1), pos);
    const items = [];
    const seen = new Set();
    const add = (name, args, desc, pkg, kind = vscode.CompletionItemKind.Function) => {
      if (seen.has(name)) return;
      seen.add(name);
      const item = new vscode.CompletionItem({ label: '\\' + name, description: pkg }, kind);
      item.range = range;
      item.filterText = '\\' + name;
      item.insertText = snippet('\\' + name + args);
      item.detail = desc;
      if (name === 'begin') item.command = { command: 'editor.action.triggerSuggest', title: '' };
      items.push(item);
    };
    if (file) {
      for (const mac of project.project(file).macros) {
        add(mac.name, Array.from({ length: mac.args }, (_, i) => `{$${i + 1}}`).join(''), mac.def, 'this project', vscode.CompletionItemKind.Variable);
      }
    }
    add('begin', '{$1}', 'Start an environment');
    for (const [name, args, desc, pkg] of COMMANDS) {
      const sym = symbols.BY_COMMAND.get(name);
      add(name, args, desc, [sym && sym.glyph, pkg].filter(Boolean).join('  ') || undefined);
    }
    for (const [name, sym] of symbols.BY_COMMAND) {
      add(name, sym.args, sym.name, [sym.glyph, sym.pkg].filter(Boolean).join('  '), vscode.CompletionItemKind.Constant);
    }
    return items;
  }

  at(pos, typed) {
    const range = new vscode.Range(pos.translate(0, -typed.length - 1), pos);
    return AT.map(([key, tex, label]) => {
      const item = new vscode.CompletionItem({ label: '@' + key, description: label }, vscode.CompletionItemKind.Snippet);
      item.range = range;
      item.filterText = '@' + key;
      item.insertText = snippet(tex);
      return item;
    });
  }

  shortcuts(pos, word) {
    const range = new vscode.Range(pos.translate(0, -word.length), pos);
    const items = [];
    const starred = word.startsWith('BS') && ENV_SHORTCUTS[word.slice(2)];
    const env = word.startsWith('B') && (ENV_SHORTCUTS[word.slice(1)] || (starred && starred + '*'));
    if (env) {
      const item = new vscode.CompletionItem({ label: word, description: `\\begin{${env}}` }, vscode.CompletionItemKind.Snippet);
      item.range = range;
      item.insertText = snippet(`\\begin{${env}}\n\t$0\n\\end{${env}}`);
      items.push(item);
    }
    if (FONT_SHORTCUTS[word]) {
      const item = new vscode.CompletionItem({ label: word, description: `\\${FONT_SHORTCUTS[word]}{}` }, vscode.CompletionItemKind.Snippet);
      item.range = range;
      item.insertText = snippet(`\\${FONT_SHORTCUTS[word]}{$1}`);
      items.push(item);
    }
    return items;
  }
}

// ---------------------------------------------------------------------------
// Shared formatting helpers

function shortAuthors(a) {
  if (!a) return '';
  const names = a.split(/\s+and\s+/).map((n) => (n.includes(',') ? n.split(',')[0] : n.trim().split(/\s+/).pop()));
  return names.length > 2 ? `${names[0]} et al.` : names.join(' & ');
}

function citationMarkdown(e, f) {
  const where = f.journal || f.journaltitle || f.booktitle || f.publisher || f.school || f.institution || f.howpublished || '';
  const parts = [f.author || f.editor, f.year || f.date, where].filter(Boolean).map(escapeMd);
  const line = project.bibLine(e);
  return [
    e.type === 'bibitem' ? escapeMd(f.title) : f.title ? `**${escapeMd(f.title)}**` : `**${e.key}**`,
    parts.join(' · '),
    `[${path.basename(e.file)}:${line + 1}](${vscode.Uri.file(e.file).with({ fragment: `L${line + 1}` })})`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

function escapeMd(s) {
  return String(s).replace(/([\\`*_{}[\]<>#|])/g, '\\$1');
}

/** Label → printed number, from the last compile's .aux files. */
function auxLabels(root) {
  const rel = vscode.workspace.getConfiguration('texPreview').get('outDir') || '.';
  const dir = path.resolve(path.dirname(root), rel);
  const out = {};
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith('.aux'));
  } catch {
    return out;
  }
  for (const n of names) {
    const text = project.read(path.join(dir, n))?.text || '';
    for (const m of text.matchAll(/\\newlabel\{([^}]+)\}\{\{([^}]*)\}\{([^}]*)\}/g)) {
      if (m[2]) out[m[1]] = m[2];
    }
  }
  return out;
}

/** What a label is attached to: {env, title, code, mathTex} */
function labelContext(label) {
  const text = project.read(label.file)?.text || '';
  const { pairs } = environments(text);
  const enclosing = pairs.filter((p) => p.open.start <= label.offset && p.close.end >= label.offset).sort((a, b) => b.open.start - a.open.start)[0];
  const lines = text.split(/\r?\n/);
  const code = lines.slice(Math.max(0, label.line - 1), label.line + 2).join('\n').trim();
  if (!enclosing) {
    const heading = (lines[label.line] || '').match(/\\(part|chapter|(?:sub)*section|paragraph)\*?\s*\{([^}]*)\}/);
    return { title: heading ? `${heading[1]}: ${heading[2]}` : '', code };
  }
  const body = text.slice(enclosing.open.start, enclosing.close.end);
  if (MATH_ENVS.test(enclosing.name)) return { env: enclosing.name, title: enclosing.name, code: body.length < 600 ? body : code, mathTex: body };
  const cap = body.match(/\\caption\s*(?:\[[^\]]*\])?\s*\{((?:[^{}]|\{[^{}]*\})*)\}/);
  return { env: enclosing.name, title: cap ? `${enclosing.name}: ${cap[1].replace(/\s+/g, ' ').trim()}` : enclosing.name, code };
}

function macroPreamble(file) {
  const byName = new Map();
  for (const m of project.project(file).macros) byName.set(m.name, m.def);
  return [...byName.values()].join('');
}

// ---------------------------------------------------------------------------
// Hover

/** The {…} argument under the cursor: {cmd, item, range} where item is the comma-separated piece. */
function argumentAt(doc, pos) {
  const line = doc.lineAt(pos.line).text;
  const re = /\\([a-zA-Z]+)\*?\s*(?:\[[^\]]*\]\s*)*\{([^}]*)\}/g;
  let m;
  while ((m = re.exec(line))) {
    const open = m.index + m[0].lastIndexOf('{') + 1;
    const close = open + m[2].length;
    if (pos.character < open || pos.character > close) continue;
    let start = open;
    for (const piece of m[2].split(',')) {
      const end = start + piece.length;
      if (pos.character <= end) {
        const lead = piece.length - piece.trimStart().length;
        return { cmd: m[1], item: piece.trim(), range: new vscode.Range(pos.line, start + lead, pos.line, start + lead + piece.trim().length) };
      }
      start = end + 1;
    }
  }
  return null;
}

class HoverProvider {
  async provideHover(doc, pos) {
    const file = fsPathOf(doc);
    const arg = argumentAt(doc, pos);
    if (arg && file) {
      if (/cite/i.test(arg.cmd) || arg.cmd === 'bibentry') return this.cite(file, arg);
      if (/^(ref|eqref|pageref|autoref|nameref|vref|cref|Cref|cpageref|Cpageref|labelcref|subref|label)$/.test(arg.cmd)) return this.ref(file, arg);
      if (/^(includegraphics|includestandalone|includepdf)$/.test(arg.cmd)) return this.image(file, arg);
      if (/^(usepackage|RequirePackage)$/.test(arg.cmd)) return this.pkg(arg);
    }
    const inMath = math.mathAt(doc, pos);
    if (inMath && inMath.tex.trim()) {
      const r = await math.render(inMath.tex, inMath.display, file ? macroPreamble(file) : '');
      const fallback = r.error && file ? await math.render(inMath.tex, inMath.display) : null;
      const out = fallback && !fallback.error ? fallback : r;
      return new vscode.Hover(md(out.markdown || `$(warning) ${escapeMd(out.error)}`), inMath.range);
    }
    return this.command(doc, pos, file);
  }

  cite(file, arg) {
    const e = project.project(file).entries().find((x) => x.key === arg.item);
    if (!e) return new vscode.Hover(md(`$(warning) No entry \`${arg.item}\` in ${project.project(file).bibs.map((b) => path.basename(b)).join(', ') || 'any .bib file named by \\bibliography or \\addbibresource'}`), arg.range);
    const f = Object.fromEntries(e.fields.map((x) => [x.name, x.value]));
    return new vscode.Hover(md(citationMarkdown(e, f)), arg.range);
  }

  async ref(file, arg) {
    const p = project.project(file);
    const label = p.labels.find((l) => l.name === arg.item);
    if (!label) return arg.cmd === 'label' ? null : new vscode.Hover(md(`$(warning) No \\label{${arg.item}} in this project`), arg.range);
    const ctx = labelContext(label);
    const num = auxLabels(p.root)[label.name];
    const loc = `[${path.basename(label.file)}:${label.line + 1}](${vscode.Uri.file(label.file).with({ fragment: `L${label.line + 1}` })})`;
    const head = [num ? `**(${num})**` : '', ctx.title ? escapeMd(ctx.title) : '', loc].filter(Boolean).join(' · ');
    if (arg.cmd === 'label' && !ctx.mathTex) return null;
    if (ctx.mathTex) {
      const r = await math.render(ctx.mathTex, true, macroPreamble(file));
      if (r.markdown) return new vscode.Hover(md(head + '\n\n' + r.markdown), arg.range);
    }
    return new vscode.Hover(md(head + (ctx.code ? '\n\n```latex\n' + ctx.code + '\n```' : '')), arg.range);
  }

  async image(file, arg) {
    const rootDir = path.dirname(project.findRoot(file));
    const dirs = [rootDir, path.dirname(file), ...graphicsPaths(file, rootDir)];
    let target = null;
    for (const d of dirs) {
      for (const ext of ['', ...IMAGE_EXT]) {
        const p = path.resolve(d, arg.item + ext);
        if (fs.existsSync(p) && fs.statSync(p).isFile()) {
          target = p;
          break;
        }
      }
      if (target) break;
    }
    if (!target) return new vscode.Hover(md(`$(warning) Image \`${escapeMd(arg.item)}\` not found`), arg.range);
    const link = `[${path.basename(target)}](${vscode.Uri.file(target)})`;
    const img = await imageDataUri(target);
    return new vscode.Hover(md(img ? `![${path.basename(target)}](${img}|width=360)\n\n${link}` : link), arg.range);
  }

  pkg(arg) {
    const known = PACKAGES.find((p) => p[0] === arg.item);
    return new vscode.Hover(md(`**${arg.item}**${known ? ` — ${known[1]}` : ''}\n\n[Documentation on CTAN](https://ctan.org/pkg/${encodeURIComponent(arg.item)})`), arg.range);
  }

  command(doc, pos, file) {
    const range = doc.getWordRangeAtPosition(pos, /\\[a-zA-Z@]+\*?/);
    if (!range) return null;
    const name = doc.getText(range).slice(1);
    const known = COMMANDS.find((c) => c[0] === name);
    const sym = symbols.BY_COMMAND.get(name);
    if (known || sym) {
      const args = known ? known[1] : sym.args;
      const sig = '\\' + name + args.replace(/\$\{\d+:([^}]*)\}/g, '$1').replace(/\$\d+/g, '…');
      const pkg = (known && known[3]) || (sym && sym.pkg);
      const glyph = sym && /^[^\x00-\x7f]/.test(sym.glyph) ? `**${sym.glyph}**  ` : '';
      return new vscode.Hover(md(`${glyph}\`${sig}\` — ${escapeMd(known ? known[2] : sym.name)}${pkg ? ` · package \`${pkg}\`` : ''}`), range);
    }
    if (!file) return null;
    const mac = project.project(file).macros.find((m) => m.name === name);
    return mac ? new vscode.Hover(md('```latex\n' + mac.def + '\n```'), range) : null;
  }
}

function graphicsPaths(file, rootDir) {
  const text = project.read(project.findRoot(file))?.text || '';
  const m = text.match(/\\graphicspath\s*\{((?:\{[^}]*\}\s*)+)\}/);
  return m ? [...m[1].matchAll(/\{([^}]*)\}/g)].map((x) => path.resolve(rootDir, x[1])) : [];
}

const imageCache = new Map();

// VS Code truncates hover markdown at about 100,000 characters, which would cut a large image's
// data URI in half and show it as text. Thumbnails are kept well under that.
const MAX_URI = 90000;

/**
 * A small thumbnail as a data URI for hovers, or null (the hover then shows just a link).
 * Small raster images are used as they are; larger ones, and PDF/EPS figures, are converted to
 * a JPEG thumbnail with Ghostscript or, on macOS, the built-in sips.
 */
async function imageDataUri(file) {
  const ext = path.extname(file).toLowerCase();
  const stat = fs.statSync(file);
  const key = file + ':' + stat.mtimeMs;
  if (imageCache.has(key)) return imageCache.get(key);

  const mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml' }[ext];
  let uri = null;
  if (mime && stat.size * 1.37 < MAX_URI) {
    uri = `data:${mime};base64,${fs.readFileSync(file).toString('base64')}`;
  } else if (mime || ext === '.pdf' || ext === '.eps') {
    const out = path.join(os.tmpdir(), `tex-preview-${Buffer.from(key).toString('base64url').slice(-40)}.jpg`);
    const gs = (ext === '.pdf' || ext === '.eps') && which(process.platform === 'win32' ? 'gswin64c' : 'gs');
    let r = { code: -1 };
    if (gs) {
      r = await exec(gs, ['-q', '-dSAFER', '-dBATCH', '-dNOPAUSE', '-sDEVICE=jpeg', '-dJPEGQ=80', '-r72', '-dFirstPage=1', '-dLastPage=1', '-dEPSCrop', '-dUseCropBox', `-sOutputFile=${out}`, file]);
    } else if (process.platform === 'darwin' && ext !== '.eps' && ext !== '.svg') {
      r = await exec('/usr/bin/sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '75', '-Z', '520', file, '--out', out]);
    }
    if (r.code === 0 && fs.existsSync(out)) {
      uri = `data:image/jpeg;base64,${fs.readFileSync(out).toString('base64')}`;
      fs.rm(out, () => {});
    }
  }
  if (uri && uri.length > MAX_URI) uri = null;
  imageCache.set(key, uri);
  return uri;
}

module.exports = { CompletionProvider, HoverProvider, snippetText };
