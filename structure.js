'use strict';

// Document structure for VS Code's own features: Outline, breadcrumbs and Go to Symbol;
// folding; Expand Selection; linked editing of \begin{x}/\end{x}; and word counts.

const vscode = require('vscode');
const path = require('path');
const project = require('./project');
const { stripComments, group } = project;
const { mathSpans } = require('./math');

const LEVELS = { part: 0, chapter: 1, section: 2, subsection: 3, subsubsection: 4, paragraph: 5, subparagraph: 6 };

const cache = new WeakMap(); // TextDocument -> { version, data }
function cached(doc, key, fn) {
  let entry = cache.get(doc);
  if (!entry || entry.version !== doc.version) cache.set(doc, (entry = { version: doc.version }));
  if (!(key in entry)) entry[key] = fn(doc.getText());
  return entry[key];
}

/** Matched \begin…\end pairs (offsets) plus the environments still open at the end. */
function environments(text) {
  const src = stripComments(text);
  const re = /\\(begin|end)\s*\{([^}\s]+)\}/g;
  const stack = [];
  const pairs = [];
  let m;
  while ((m = re.exec(src))) {
    const nameStart = m.index + m[0].indexOf('{') + 1;
    const tag = { name: m[2], start: m.index, end: m.index + m[0].length, nameStart, nameEnd: nameStart + m[2].length };
    if (m[1] === 'begin') {
      stack.push(tag);
      continue;
    }
    const i = stack.map((t) => t.name).lastIndexOf(tag.name);
    if (i < 0) continue;
    const open = stack[i];
    stack.length = i;
    pairs.push({ name: tag.name, open, close: tag });
  }
  return { pairs, unclosed: stack };
}

function envs(doc) {
  return cached(doc, 'envs', environments);
}

const HEADING = String.raw`\\(part|chapter|section|subsection|subsubsection|paragraph|subparagraph)(\*?)\s*(?:\[[^\]]*\]\s*)?(?=\{)|\\appendix\b`;

/** Section headings in one file: [{cmd, level, starred, title, start, end}], with {appendix} markers. */
function sections(text) {
  const src = stripComments(text);
  const re = new RegExp(HEADING, 'g');
  const out = [];
  let m;
  while ((m = re.exec(src))) {
    if (!m[1]) {
      out.push({ appendix: true, start: m.index });
      continue;
    }
    const g = group(src, re.lastIndex);
    if (!g) continue;
    out.push({ cmd: m[1] + m[2], level: LEVELS[m[1]], starred: !!m[2], title: cleanTitle(g.value), start: m.index, end: g.end });
  }
  return out;
}

/** A heading as it reads in the PDF: commands dropped, arguments kept, math left as written. */
function cleanTitle(raw) {
  let s = raw.replace(/\\texorpdfstring\s*\{((?:[^{}]|\{[^{}]*\})*)\}\s*\{(?:[^{}]|\{[^{}]*\})*\}/g, '$1');
  s = s.replace(/\\(?:label|footnote|thanks|index)\s*\{(?:[^{}]|\{[^{}]*\})*\}/g, '').replace(/\\\\|~/g, ' ').replace(/\\protect\b/g, '');
  const parts = s.split(/(\$[^$]*\$)/); // keep inline math untouched
  s = parts.map((p, i) => (i % 2 ? p : p.replace(/\\[a-zA-Z@]+\*?\s*/g, '').replace(/\\(.)/g, '$1').replace(/[{}]/g, ''))).join('');
  return s.replace(/\s+/g, ' ').trim();
}

const ROMAN = ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII'];

/**
 * Numbers headings the way the standard classes do: with chapters, chapter.section.subsection;
 * without, section.subsection.subsubsection. Starred headings get none; \appendix switches the
 * top level to letters.
 */
function number(list) {
  const secs = list.filter((s) => !s.appendix);
  const top = secs.some((s) => s.level === 1) ? 1 : 2;
  const deepest = top + 2;
  const counters = [0, 0, 0, 0, 0, 0, 0];
  let appendix = false;
  for (const s of list) {
    if (s.appendix) {
      appendix = true;
      counters[top] = 0;
      continue;
    }
    s.number = '';
    if (s.level === 0) {
      if (!s.starred) s.number = 'Part ' + (ROMAN[++counters[0]] || counters[0]);
      continue;
    }
    if (s.starred || s.level < top || s.level > deepest) continue;
    counters[s.level]++;
    for (let l = s.level + 1; l < counters.length; l++) counters[l] = 0;
    const parts = [];
    for (let l = top; l <= s.level; l++) parts.push(l === top && appendix ? String.fromCharCode(64 + counters[l]) : counters[l]);
    s.number = parts.join('.');
  }
  return secs;
}

/** Every heading of the project in document order, following \input/\include, numbered. */
function projectSections(root) {
  const rootDir = path.dirname(root);
  const list = [];
  const seen = new Set();
  const walk = (file) => {
    if (!file || seen.has(file) || seen.size > 300) return;
    seen.add(file);
    const text = project.read(file)?.text;
    if (!text) return;
    const src = stripComments(text);
    const starts = project.lineStarts(src);
    const re = new RegExp(HEADING + String.raw`|\\(input|include|subfile)\s*\{([^}]+)\}|\\end\{document\}`, 'g');
    let m;
    while ((m = re.exec(src))) {
      if (m[0] === '\\end{document}') break;
      if (m[3]) {
        walk(project.resolveTex(m[3] === 'subfile' ? path.dirname(file) : rootDir, m[4].trim()) || project.resolveTex(path.dirname(file), m[4].trim()));
      } else if (!m[1]) {
        list.push({ appendix: true });
      } else {
        const g = group(src, re.lastIndex);
        if (!g) continue;
        list.push({ file, start: m.index, line: project.lineOf(starts, m.index), cmd: m[1] + m[2], level: LEVELS[m[1]], starred: !!m[2], title: cleanTitle(g.value) });
      }
    }
  };
  walk(root);
  return number(list);
}

// ---------------------------------------------------------------------------
// Outline

const FLOATS = /^(figure|table|frame|algorithm|listing)\*?$/;
const THEOREMS = /^(theorem|lemma|proposition|corollary|definition|remark|example|assumption|conjecture|claim|problem|exercise|hypothesis|notation|observation|fact|note)\*?$/;
const capital = (s) => s.charAt(0).toUpperCase() + s.slice(1).replace(/\*$/, '');

class SymbolProvider {
  provideDocumentSymbols(doc) {
    const text = doc.getText();
    const src = stripComments(text);
    const docEnd = src.lastIndexOf('\\end{document}');
    const limit = docEnd >= 0 ? docEnd : text.length;
    const file = doc.uri.scheme === 'file' ? doc.uri.fsPath : null;

    // Numbers come from the whole project so a chapter file shows "3.2", not "1.2".
    let secs = cached(doc, 'sections', sections);
    let numbered = null;
    if (file) {
      try {
        numbered = new Map(projectSections(project.findRoot(file)).filter((s) => s.file === file).map((s) => [s.start, s.number]));
      } catch {
        numbered = null;
      }
    }
    if (!numbered || !numbered.size) number(secs.map((s) => s));
    secs = secs.filter((s) => !s.appendix && s.start < limit);
    const userTheorems = file ? project.project(file).theorems : {};

    // The bibliography closes the last section, so References sits beside it, not inside it.
    const bibAt = (() => {
      const m = /\\begin\{thebibliography\}|\\(?:bibliography|printbibliography)\b/.exec(src);
      return m && m.index < limit ? m.index : limit;
    })();
    const items = secs.map((s, i) => {
      let end = s.start < bibAt ? bibAt : limit;
      for (let j = i + 1; j < secs.length; j++) if (secs[j].level <= s.level) {
        end = secs[j].start;
        break;
      }
      const num = numbered && numbered.size ? numbered.get(s.start) : s.number;
      return {
        level: s.level,
        name: [num, s.title || s.cmd].filter(Boolean).join('  '),
        detail: s.cmd,
        kind: s.level <= 1 ? vscode.SymbolKind.Namespace : vscode.SymbolKind.Module,
        start: s.start,
        end,
        selStart: s.start,
        selEnd: s.end,
      };
    });

    for (const p of envs(doc).pairs) {
      const body = src.slice(p.open.end, p.close.start);
      const item = (name, kind, detail = '') =>
        items.push({ level: 99, name, detail, kind, start: p.open.start, end: p.close.end, selStart: p.open.start, selEnd: p.open.end });
      if (FLOATS.test(p.name)) {
        let title = '';
        const cap = /\\caption\s*(?:\[[^\]]*\]\s*)?(?=\{)/.exec(body);
        if (cap) title = group(body, cap.index + cap[0].length)?.value || '';
        else if (/^frame/.test(p.name)) title = (body.match(/^\s*(?:<[^>]*>)?\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}/) || body.match(/\\frametitle\s*\{([^}]*)\}/) || [])[1] || '';
        title = cleanTitle(title);
        item(title ? `${capital(p.name)}: ${title}` : capital(p.name), /^frame/.test(p.name) ? vscode.SymbolKind.Class : vscode.SymbolKind.Object);
      } else if (THEOREMS.test(p.name) || userTheorems[p.name.replace(/\*$/, '')]) {
        const label = userTheorems[p.name.replace(/\*$/, '')] || capital(p.name);
        const opt = body.match(/^\s*\[([^\]]*)\]/);
        item(opt ? `${label} (${cleanTitle(opt[1])})` : label, vscode.SymbolKind.Struct);
      } else if (p.name === 'abstract') {
        item('Abstract', vscode.SymbolKind.String);
      } else if (p.name === 'thebibliography') {
        item('References', vscode.SymbolKind.Module);
      }
    }
    const bib = /\\(?:bibliography|printbibliography)\b/.exec(src);
    if (bib && !/\\begin\{thebibliography\}/.test(src)) {
      items.push({ level: 99, name: 'References', detail: '', kind: vscode.SymbolKind.Module, start: bib.index, end: bib.index + bib[0].length, selStart: bib.index, selEnd: bib.index + bib[0].length });
    }
    items.sort((a, b) => a.start - b.start || a.level - b.level);

    // Nest every item under the closest preceding item that contains it (sorted by start).
    const roots = [];
    const stack = [];
    for (const it of items) {
      const sym = new vscode.DocumentSymbol(
        it.name.length > 90 ? it.name.slice(0, 89) + '…' : it.name,
        it.detail,
        it.kind,
        new vscode.Range(doc.positionAt(it.start), doc.positionAt(it.end)),
        new vscode.Range(doc.positionAt(it.selStart), doc.positionAt(it.selEnd))
      );
      while (stack.length && stack[stack.length - 1].it.end < it.end) stack.pop();
      (stack.length ? stack[stack.length - 1].sym.children : roots).push(sym);
      stack.push({ it, sym });
    }
    return roots;
  }
}

// ---------------------------------------------------------------------------
// Folding

class FoldingProvider {
  provideFoldingRanges(doc) {
    const ranges = [];
    const line = (off) => doc.positionAt(off).line;

    const secs = cached(doc, 'sections', sections).filter((s) => !s.appendix);
    const text = doc.getText();
    const docEnd = stripComments(text).lastIndexOf('\\end{document}');
    secs.forEach((s, i) => {
      let endOff = docEnd >= 0 && docEnd > s.start ? docEnd : text.length;
      for (let j = i + 1; j < secs.length; j++) if (secs[j].level <= s.level) {
        endOff = secs[j].start;
        break;
      }
      let end = line(endOff) - (endOff === text.length ? 0 : 1);
      while (end > line(s.start) && doc.lineAt(end).isEmptyOrWhitespace) end--;
      if (end > line(s.start)) ranges.push(new vscode.FoldingRange(line(s.start), end));
    });

    for (const p of envs(doc).pairs) {
      const a = line(p.open.start);
      const b = line(p.close.start) - 1;
      if (b > a) ranges.push(new vscode.FoldingRange(a, b));
    }

    // % region / % endregion markers, and runs of comment lines.
    const regions = [];
    let commentStart = -1;
    for (let i = 0; i <= doc.lineCount; i++) {
      const t = i < doc.lineCount ? doc.lineAt(i).text : '';
      if (/^\s*%\s*#?region\b/.test(t)) regions.push(i);
      else if (/^\s*%\s*#?endregion\b/.test(t) && regions.length) ranges.push(new vscode.FoldingRange(regions.pop(), i, vscode.FoldingRangeKind.Region));
      const isComment = i < doc.lineCount && /^\s*%/.test(t) && !/^\s*%\s*#?(end)?region\b/.test(t);
      if (isComment && commentStart < 0) commentStart = i;
      if (!isComment && commentStart >= 0) {
        if (i - 1 > commentStart) ranges.push(new vscode.FoldingRange(commentStart, i - 1, vscode.FoldingRangeKind.Comment));
        commentStart = -1;
      }
    }
    return ranges;
  }
}

// ---------------------------------------------------------------------------
// Expand Selection: math, environment contents, whole environments. VS Code merges these
// with its own word and bracket ranges.

class SelectionProvider {
  provideSelectionRanges(doc, positions) {
    const text = doc.getText();
    const pairs = envs(doc).pairs;
    const math = cached(doc, 'math', mathSpans);
    return positions.map((pos) => {
      const off = doc.offsetAt(pos);
      const spans = [];
      for (const p of pairs) {
        if (off < p.open.start || off > p.close.end) continue;
        let a = p.open.end;
        let b = p.close.start;
        while (a < b && /\s/.test(text[a])) a++;
        while (b > a && /\s/.test(text[b - 1])) b--;
        if (off >= a && off <= b && b > a) spans.push([a, b]);
        spans.push([p.open.start, p.close.end]);
      }
      for (const s of math) {
        if (off < s.start || off > s.end) continue;
        const inner = s.start + (text.startsWith('$$', s.start) || text.startsWith('\\[', s.start) || text.startsWith('\\(', s.start) ? 2 : text[s.start] === '$' ? 1 : 0);
        const innerEnd = s.end - (inner - s.start);
        if (inner > s.start && off >= inner && off <= innerEnd) spans.push([inner, innerEnd]);
        spans.push([s.start, s.end]);
      }
      spans.sort((x, y) => x[1] - x[0] - (y[1] - y[0]));
      let parent;
      for (const [a, b] of spans.reverse()) {
        parent = new vscode.SelectionRange(new vscode.Range(doc.positionAt(a), doc.positionAt(b)), parent);
      }
      return parent || new vscode.SelectionRange(new vscode.Range(pos, pos));
    });
  }
}

// ---------------------------------------------------------------------------
// Linked editing: renaming \begin{foo} renames its \end{foo} (editor.linkedEditing).

class LinkedEditingProvider {
  provideLinkedEditingRanges(doc, pos) {
    const off = doc.offsetAt(pos);
    for (const p of envs(doc).pairs) {
      for (const t of [p.open, p.close]) {
        if (off >= t.nameStart && off <= t.nameEnd) {
          const r = (x) => new vscode.Range(doc.positionAt(x.nameStart), doc.positionAt(x.nameEnd));
          return new vscode.LinkedEditingRanges([r(p.open), r(p.close)], /[^\s{}]+/);
        }
      }
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// Word count

const NON_PROSE =
  /\\(?:label|ref|eqref|[cC]ref|autoref|pageref|nameref|cite[a-zA-Z]*|[pP]arencite|[tT]extcite|autocite|nocite|includegraphics|input|include|subfile|bibliography(?:style)?|addbibresource|usepackage|documentclass|begin|end|url|[hv]space|setlength|(?:re)?newcommand|newtheorem|DeclareMathOperator|graphicspath|hypersetup)\*?\s*(?:\[[^\]]*\]\s*)*(?:\{[^{}]*\}\s*)*/g;

/** The prose of LaTeX source: comments, math, command names and labels/refs removed. */
function prose(text, bodyOnly) {
  let s = stripComments(text);
  const spans = mathSpans(s);
  const math = { inline: spans.filter((m) => !m.display).length, display: spans.filter((m) => m.display).length };
  for (const m of [...spans].reverse()) s = s.slice(0, m.start) + ' ' + s.slice(m.end);
  if (bodyOnly) {
    const b = s.indexOf('\\begin{document}');
    if (b >= 0) s = s.slice(b);
    const e = s.indexOf('\\end{document}');
    if (e >= 0) s = s.slice(0, e);
  }
  s = s.replace(NON_PROSE, ' ').replace(/\\[a-zA-Z@]+\*?/g, ' ').replace(/\\./g, ' ').replace(/[{}~&]/g, ' ');
  return { text: s, math };
}

const WORD = /[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu;

/** Words of prose (math, commands, comments and labels excluded). */
function countWords(text, bodyOnly) {
  return (prose(text, bodyOnly).text.match(WORD) || []).length;
}

/** {words, chars, charsNoSpaces, inlineMath, displayMath} for LaTeX source. */
function textStats(text, bodyOnly) {
  const p = prose(text, bodyOnly);
  const flat = p.text.replace(/\s+/g, ' ').trim();
  return {
    words: (p.text.match(WORD) || []).length,
    chars: flat.length,
    charsNoSpaces: flat.replace(/\s/g, '').length,
    inlineMath: p.math.inline,
    displayMath: p.math.display,
  };
}

module.exports = { environments, envs, sections, projectSections, cleanTitle, SymbolProvider, FoldingProvider, SelectionProvider, LinkedEditingProvider, countWords, textStats };
