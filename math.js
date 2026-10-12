'use strict';

// Finds the math around a position and renders it to SVG with MathJax (loaded on first use).

const vscode = require('vscode');
const { stripComments } = require('./project');
const { MATH_ENV_NAMES } = require('./data');

let mathjax;

function load() {
  if (!mathjax) {
    mathjax = require('mathjax').init({
      loader: { load: ['input/tex-full', 'output/svg'] },
      svg: { fontCache: 'local' },
      startup: { typeset: false },
    });
  }
  return mathjax;
}

/** All math spans in `text`: [{start, end, tex, display}] with offsets into `text`. */
function mathSpans(text) {
  const src = stripComments(text);
  const spans = [];

  const envRe = new RegExp(`\\\\begin\\{(${MATH_ENV_NAMES})(\\*?)\\}[\\s\\S]*?\\\\end\\{\\1\\2\\}`, 'g');
  let m;
  while ((m = envRe.exec(src))) spans.push({ start: m.index, end: m.index + m[0].length, tex: m[0], display: true });
  const inEnv = (i) => spans.some((s) => i >= s.start && i < s.end);

  // \[ \], \( \), $$ $$ and $ $ — a small scanner so escaped dollars don't confuse it.
  let open = null;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === '\\') {
      const next = src[i + 1];
      if (!open && (next === '[' || next === '(') && !inEnv(i)) open = { start: i, close: next === '[' ? ']' : ')' };
      else if (open && (next === ']' || next === ')') && open.close === next) {
        spans.push({ start: open.start, end: i + 2, tex: src.slice(open.start + 2, i), display: next === ']' });
        open = null;
      }
      i++;
    } else if (ch === '$' && !inEnv(i)) {
      const dbl = src[i + 1] === '$';
      if (!open) open = { start: i, close: dbl ? '$$' : '$' };
      else if (open.close === (dbl ? '$$' : '$')) {
        const a = open.start + open.close.length;
        spans.push({ start: open.start, end: i + open.close.length, tex: src.slice(a, i), display: dbl });
        open = null;
      }
      if (dbl) i++;
    } else if (ch === '\n' && open && open.close === '$' && /^[ \t]*\n/.test(src.slice(i + 1, i + 200))) {
      open = null; // a blank line ends a paragraph; an unclosed $ there is a typo
    }
  }
  return spans.sort((a, b) => a.start - b.start);
}

/** The math span at `position`; with `strict`, only if the position is between its delimiters. */
function mathAt(document, position, strict = false) {
  const offset = document.offsetAt(position);
  const inside = (s) => {
    if (!strict) return offset >= s.start && offset <= s.end;
    const open = /^(\$\$|\\\[|\\\(|\$)/.exec(document.getText().slice(s.start, s.start + 2));
    const len = open ? open[0].length : 0;
    return len ? offset >= s.start + len && offset <= s.end - len : offset > s.start && offset < s.end;
  };
  const span = mathSpans(document.getText()).find(inside);
  if (!span) return null;
  return { ...span, range: new vscode.Range(document.positionAt(span.start), document.positionAt(span.end)) };
}

/**
 * Renders TeX to a markdown image (an SVG data URI) for hovers, or returns {error}.
 * `macros` are \newcommand definitions to prepend.
 */
async function render(tex, display, macros = '') {
  const MJ = await load();
  MJ.texReset();
  const body = tex.replace(/\\label\s*\{[^}]*\}/g, '');
  const node = MJ.tex2svg(macros + body, { display });
  let svg = MJ.startup.adaptor.innerHTML(node);
  const err = svg.match(/data-mjx-error="([^"]*)"/);
  if (err) return { error: err[1] };

  const kind = vscode.window.activeColorTheme.kind;
  const dark = kind === vscode.ColorThemeKind.Dark || kind === vscode.ColorThemeKind.HighContrast;
  svg = svg.replace(/currentColor/g, dark ? '#e6e6e6' : '#1f1f1f');
  // Sizes come in ex; give the image fixed pixels so it reads at editor size.
  svg = svg.replace(/(width|height)="([\d.]+)ex"/g, (_, a, v) => `${a}="${(parseFloat(v) * 9).toFixed(1)}px"`);
  const uri = 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64');
  return { markdown: `![equation](${uri})` };
}

module.exports = { mathSpans, mathAt, render };
