'use strict';

// A light model of a LaTeX project: which file is the root, which files it pulls in, and the
// labels, bibliography entries and macros they define. Everything is parsed lazily and cached
// per file (by editor version or mtime), so asking again is cheap.

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');

const fileCache = new Map(); // fsPath -> { stamp, info }

/** Current text of a file: the open editor's buffer if there is one, otherwise the disk. */
function read(file) {
  const doc = vscode.workspace.textDocuments.find((d) => d.uri.scheme === 'file' && d.uri.fsPath === file);
  if (doc) return { text: doc.getText(), stamp: `v${doc.version}` };
  try {
    const st = fs.statSync(file);
    return { text: fs.readFileSync(file, 'utf8'), stamp: `m${st.mtimeMs}` };
  } catch {
    return null;
  }
}

/** Replaces `%` comments with spaces so offsets and line numbers stay valid. */
function stripComments(text) {
  return text.replace(/(^|[^\\])((?:\\\\)*)(%.*)$/gm, (_, a, b, c) => a + b + ' '.repeat(c.length));
}

/** Content of the brace group opening at text[i] === '{', or null if unbalanced. */
function group(text, i) {
  if (text[i] !== '{') return null;
  let depth = 0;
  for (let j = i; j < text.length; j++) {
    const ch = text[j];
    if (ch === '\\') j++;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return { value: text.slice(i + 1, j), end: j + 1 };
  }
  return null;
}

/** 1-based line number of an offset, given precomputed line starts. */
function lineStarts(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
  return starts;
}
function lineOf(starts, offset) {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo; // 0-based
}

// ---------------------------------------------------------------------------
// Per-file parsing

function parseTex(file, text) {
  const src = stripComments(text);
  const starts = lineStarts(src);
  const dir = path.dirname(file);
  const info = { inputs: [], bibs: [], labels: [], macros: [], envs: [], theorems: {}, bibitems: [], hasDocumentclass: /\\documentclass\s*[[{]/.test(src) };
  const pos = (offset) => {
    const line = lineOf(starts, offset);
    return { line, character: offset - starts[line] };
  };

  let m;
  const inputRe = /\\(input|include|subfile|subfileinclude|(?:sub)?(?:import|inputfrom|includefrom))\*?\s*(?:\{([^}]*)\}\s*)?\{([^}]+)\}/g;
  while ((m = inputRe.exec(src))) {
    // \import{dir}{file} has two arguments; the rest have one.
    const twoArgs = /import|from/.test(m[1]);
    if (twoArgs && m[2] === undefined) continue;
    const target = twoArgs ? path.join(m[2], m[3]) : m[3];
    info.inputs.push({ target: target.trim(), relativeToFile: /^sub/.test(m[1]) || m[1] === 'subfile' });
  }

  const bibRe = /\\(bibliography|addbibresource|addglobalbib)\s*(?:\[[^\]]*\]\s*)?\{([^}]+)\}/g;
  while ((m = bibRe.exec(src))) {
    for (const name of m[2].split(',')) if (name.trim()) info.bibs.push(name.trim());
  }

  const labelRe = /\\label\s*\{([^}]+)\}/g;
  while ((m = labelRe.exec(src))) {
    const p = pos(m.index + m[0].indexOf('{') + 1);
    info.labels.push({ name: m[1].trim(), file, line: p.line, character: p.character, offset: m.index });
  }

  // \newcommand{\foo}[2][default]{body}, \DeclareMathOperator*{\op}{text}, \def\foo{...}
  const macroRe = /\\(?:(?:re|provide)?newcommand|DeclareRobustCommand|DeclareMathOperator)(\*?)\s*\{?\s*\\([a-zA-Z@]+)\s*\}?\s*(?:\[(\d)\])?\s*(\[[^\]]*\])?\s*(?=\{)/g;
  while ((m = macroRe.exec(src))) {
    const body = group(src, macroRe.lastIndex);
    if (!body) continue;
    const isOp = /DeclareMathOperator/.test(m[0]);
    const def = isOp
      ? `\\DeclareMathOperator${m[1]}{\\${m[2]}}{${body.value}}`
      : `\\newcommand{\\${m[2]}}${m[3] ? `[${m[3]}]` : ''}${m[4] || ''}{${body.value}}`;
    info.macros.push({ name: m[2], args: m[3] ? parseInt(m[3], 10) : 0, def, math: isOp || /\\math|\\operator/.test(body.value) });
  }

  // A hand-written bibliography: \bibitem[label]{key} text… up to the next \bibitem.
  const itemRe = /\\bibitem\s*(?:\[[^\]]*\]\s*)?\{([^}]+)\}([\s\S]*?)(?=\\bibitem|\\end\{thebibliography\}|$)/g;
  while ((m = itemRe.exec(src))) {
    const text = cleanBibValue(m[2].replace(/\\newblock/g, ' ').replace(/\\(?:emph|textit|textbf)\s*/g, ''));
    info.bibitems.push({ type: 'bibitem', key: m[1].trim(), file, start: m.index, end: m.index + m[0].length, fields: [{ name: 'title', raw: text, value: text }] });
  }

  const envRe = /\\(?:newenvironment|renewenvironment|newtheorem\*?|declaretheorem)\s*(?:\[[^\]]*\]\s*)?\{([^}]+)\}/g;
  while ((m = envRe.exec(src))) info.envs.push(m[1].trim());
  // \newtheorem{thm}[counter]{Theorem}: name → printed name, for the Outline.
  const thmRe = /\\newtheorem\*?\s*\{([^}]+)\}\s*(?:\[[^\]]*\]\s*)?\{([^}]+)\}/g;
  while ((m = thmRe.exec(src))) info.theorems[m[1].trim()] = m[2].trim();

  return info;
}

/** Parses BibTeX into entries with their fields (raw and cleaned) and source positions. */
function parseBib(text) {
  const entries = [];
  const re = /@\s*([a-zA-Z]+)\s*([{(])/g;
  let m;
  while ((m = re.exec(text))) {
    const type = m[1].toLowerCase();
    const open = m[2];
    const close = open === '{' ? '}' : ')';
    const start = m.index;
    let i = re.lastIndex;

    if (type === 'comment' || type === 'preamble' || type === 'string') {
      const end = skipBalanced(text, i - 1, open, close);
      entries.push({ type, start, end, raw: text.slice(start, end) });
      re.lastIndex = end;
      continue;
    }

    const comma = text.indexOf(',', i);
    const closeIdx = text.indexOf(close, i);
    if (comma < 0 || (closeIdx >= 0 && closeIdx < comma)) continue;
    const key = text.slice(i, comma).trim();
    i = comma + 1;

    const fields = [];
    for (;;) {
      while (i < text.length && /[\s,]/.test(text[i])) i++;
      if (i >= text.length || text[i] === close) break;
      const nm = /^([^\s=,{}()"#]+)\s*=\s*/.exec(text.slice(i, i + 200));
      if (!nm) break;
      i += nm[0].length;
      const valStart = i;
      // value: parts joined by #, each {balanced}, "quoted" or a bare word/number
      for (;;) {
        if (text[i] === '{') i = skipBalanced(text, i, '{', '}');
        else if (text[i] === '"') {
          let depth = 0;
          i++;
          while (i < text.length && !(text[i] === '"' && depth === 0)) {
            if (text[i] === '\\') i++;
            else if (text[i] === '{') depth++;
            else if (text[i] === '}') depth--;
            i++;
          }
          i++;
        } else {
          while (i < text.length && !/[\s,#}\)]/.test(text[i])) i++;
        }
        let j = i;
        while (j < text.length && /\s/.test(text[j])) j++;
        if (text[j] === '#') {
          i = j + 1;
          while (i < text.length && /\s/.test(text[i])) i++;
        } else break;
      }
      const raw = text.slice(valStart, i).trim();
      fields.push({ name: nm[1].toLowerCase(), raw, value: cleanBibValue(raw) });
    }
    while (i < text.length && text[i] !== close) i++;
    const end = Math.min(text.length, i + 1);
    entries.push({ type, key, fields, start, end });
    re.lastIndex = end;
  }
  return entries;
}

function skipBalanced(text, i, open, close) {
  let depth = 0;
  for (; i < text.length; i++) {
    if (text[i] === '\\') i++;
    else if (text[i] === open) depth++;
    else if (text[i] === close && --depth === 0) return i + 1;
  }
  return text.length;
}

const ACCENTS = { '"': '̈', "'": '́', '`': '̀', '^': '̂', '~': '̃', '=': '̄', '.': '̇', c: '̧', v: '̌', u: '̆', H: '̋' };

/** Turns a raw BibTeX value into readable text (strips braces, common accents and commands). */
function cleanBibValue(raw) {
  let s = raw
    .split(/\s*#\s*/)
    .map((p) => p.replace(/^\{([\s\S]*)\}$/, '$1').replace(/^"([\s\S]*)"$/, '$1'))
    .join('');
  s = s.replace(/\\([`'^"~=.]|[cvuH](?=[\s{]))\s*\{?\s*([a-zA-Z])\}?/g, (_, a, ch) => (ch + (ACCENTS[a] || '')).normalize('NFC'));
  s = s.replace(/\\(ss|o|O|ae|AE|oe|OE|aa|AA|l|L|i)\b\s*/g, (_, c) => ({ ss: 'ß', o: 'ø', O: 'Ø', ae: 'æ', AE: 'Æ', oe: 'œ', OE: 'Œ', aa: 'å', AA: 'Å', l: 'ł', L: 'Ł', i: 'ı' })[c]);
  s = s.replace(/\\&/g, '&').replace(/\\(?:emph|textit|textbf|textsc|mathrm|text)\s*\{/g, '{').replace(/--/g, '–').replace(/~/g, ' ');
  return s.replace(/[{}]/g, '').replace(/\s+/g, ' ').trim();
}

function info(file) {
  const r = read(file);
  if (!r) return null;
  const hit = fileCache.get(file);
  if (hit && hit.stamp === r.stamp) return hit.info;
  const ext = path.extname(file).toLowerCase();
  const parsed = ext === '.bib' ? { entries: parseBib(r.text) } : parseTex(file, r.text);
  fileCache.set(file, { stamp: r.stamp, info: parsed });
  return parsed;
}

// ---------------------------------------------------------------------------
// Root detection and project aggregation

const ROOT_EXT = /\.(tex|rnw|jnw)$/i;

function magicRoot(file) {
  const r = read(file);
  if (!r) return null;
  const head = r.text.split(/\r?\n/, 30).join('\n');
  const m = head.match(/^\s*%\s*!\s*TEX\s+root\s*=\s*(.+?)\s*$/im);
  if (!m) return null;
  const target = path.resolve(path.dirname(file), m[1]);
  return fs.existsSync(target) ? target : null;
}

/**
 * The main file for `file`: a `% !TEX root` comment wins; a file with \documentclass is its own
 * root; otherwise the nearest file (same folder, then parents within the workspace) whose
 * \input / \include tree reaches it.
 */
function findRoot(file) {
  const magic = magicRoot(file);
  if (magic) return magic;
  const own = info(file);
  if (!own || own.hasDocumentclass || !/\.tex$/i.test(file)) return file;

  const ws = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(file));
  const stop = ws ? ws.uri.fsPath : path.dirname(file);
  for (let dir = path.dirname(file); ; dir = path.dirname(dir)) {
    let names = [];
    try {
      names = fs.readdirSync(dir).filter((n) => ROOT_EXT.test(n));
    } catch {
      /* unreadable */
    }
    for (const n of names) {
      const cand = path.join(dir, n);
      if (cand === file) continue;
      const ci = info(cand);
      if (ci && ci.hasDocumentclass && projectFiles(cand).includes(file)) return cand;
    }
    if (dir === stop || path.dirname(dir) === dir || path.relative(stop, dir).startsWith('..')) break;
  }
  return file;
}

function resolveTex(base, target) {
  const p = path.resolve(base, target);
  if (fs.existsSync(p) && fs.statSync(p).isFile()) return p;
  if (fs.existsSync(p + '.tex')) return p + '.tex';
  return null;
}

/** The root plus every .tex file reachable through \input, \include, \subfile and \import. */
function projectFiles(root) {
  const rootDir = path.dirname(root);
  const seen = [root];
  for (let i = 0; i < seen.length && seen.length < 500; i++) {
    const fi = info(seen[i]);
    if (!fi || !fi.inputs) continue;
    for (const inp of fi.inputs) {
      const f = resolveTex(inp.relativeToFile ? path.dirname(seen[i]) : rootDir, inp.target) || resolveTex(path.dirname(seen[i]), inp.target);
      if (f && !seen.includes(f)) seen.push(f);
    }
  }
  return seen;
}

/** .bib files named by \bibliography / \addbibresource anywhere in the project. */
function bibFiles(root) {
  const rootDir = path.dirname(root);
  const out = new Set();
  for (const f of projectFiles(root)) {
    for (const b of info(f)?.bibs || []) {
      for (const cand of [path.resolve(rootDir, b), path.resolve(rootDir, b + '.bib'), path.resolve(path.dirname(f), b + '.bib')]) {
        if (/\.bib$/i.test(cand) && fs.existsSync(cand)) {
          out.add(cand);
          break;
        }
      }
    }
  }
  return [...out];
}

function project(file) {
  const root = findRoot(file);
  const files = projectFiles(root);
  if (!files.includes(file) && /\.tex$/i.test(file)) files.push(file);
  const infos = files.map(info).filter(Boolean);
  const bibs = bibFiles(root);
  return {
    root,
    rootDir: path.dirname(root),
    files,
    labels: infos.flatMap((i) => i.labels),
    macros: infos.flatMap((i) => i.macros),
    envs: [...new Set(infos.flatMap((i) => i.envs))],
    theorems: Object.assign({}, ...infos.map((i) => i.theorems || {})),
    bibs,
    entries: () => [
      ...bibs.flatMap((b) => (info(b)?.entries || []).filter((e) => e.key).map((e) => ({ file: b, ...e }))),
      ...infos.flatMap((i) => i.bibitems),
    ],
  };
}

/** Line number (0-based) of an entry in its .bib file. */
function bibLine(entry) {
  const r = read(entry.file);
  return r ? r.text.slice(0, entry.start).split('\n').length - 1 : 0;
}

function forget(file) {
  fileCache.delete(file);
}

module.exports = { read, stripComments, group, parseBib, cleanBibValue, findRoot, projectFiles, resolveTex, project, info, bibLine, forget, lineStarts, lineOf };
