'use strict';

// Minimal SyncTeX reader: parses <name>.synctex(.gz) produced by pdflatex/xelatex/lualatex/tectonic
// and answers "which source line is at this PDF point?" and the reverse.
// Records use TeX scaled points measured from the page's top-left corner; we convert to PDF
// big points (1/72 in), the same unit pdf.js uses at scale 1.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SP_PER_BP = 65781.76;

function realpath(p) {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
}

// On Windows, TeX engines can write Input: paths in the system's ANSI code page (GBK on Chinese
// Windows, Shift-JIS on Japanese…) rather than UTF-8. These are tried when a path isn't valid
// UTF-8 or doesn't exist; a decoding only counts if the file it names exists.
const FALLBACK_ENCODINGS = ['gb18030', 'big5', 'shift_jis', 'euc-kr', 'windows-1252', 'windows-1251', 'windows-1250'];

function decoder(enc, fatal) {
  try {
    return new TextDecoder(enc, { fatal });
  } catch {
    return null; // not supported by this runtime's ICU
  }
}

/**
 * An Input: path from its raw bytes: UTF-8 if that names an existing file, else the first code
 * page whose decoding does, else the longest tail of it that exists under `baseDir` (the folder
 * names that couldn't be decoded are usually above the project), else lossy UTF-8.
 */
function decodePath(bytes, baseDir) {
  const tried = [];
  const exists = (p) => {
    try {
      return fs.statSync(p).isFile();
    } catch {
      return false;
    }
  };
  for (const enc of ['utf-8', ...FALLBACK_ENCODINGS]) {
    const d = decoder(enc, true);
    if (!d) continue;
    let text;
    try {
      text = d.decode(bytes);
    } catch {
      continue; // not valid in this encoding
    }
    const full = path.resolve(baseDir, text);
    if (exists(full)) return full;
    tried.push(text);
    if (enc === 'utf-8' && !/[^\x00-\x7f]/.test(text)) break; // plain ASCII: no other decoding differs
  }
  const lossy = bytes.toString('utf8');
  // Valid UTF-8 that names no file (built on another machine, a deleted file…) is kept as written,
  // as before. Only bytes no listed encoding could read fall back to matching the path's tail.
  if (tried.length && tried[0] === lossy) return path.resolve(baseDir, lossy);
  const segs = lossy.split(/[\\/]+/).filter(Boolean);
  for (let k = segs.length - 1; k >= 1; k--) {
    const cand = path.join(baseDir, ...segs.slice(-k));
    if (exists(cand)) return cand;
  }
  return path.resolve(baseDir, tried[0] || lossy);
}

class SyncTex {
  /** @param {string} file path to .synctex.gz or .synctex  @param {string} baseDir dir used to resolve relative Input paths */
  constructor(file, baseDir) {
    let buf = fs.readFileSync(file);
    if (file.endsWith('.gz')) buf = zlib.gunzipSync(buf);
    this.inputs = new Map(); // tag -> absolute path
    this.pages = new Map(); // page number -> { boxes: [], leaves: [] }
    // latin1 keeps one character per byte, so Input: paths can be re-read as raw bytes and
    // decoded properly (everything else in the file is ASCII).
    this.parse(buf.toString('latin1'), baseDir);
  }

  parse(text, baseDir) {
    let unit = 1;
    let mag = 1000;
    let xOff = 0;
    let yOff = 0;
    let factor = 1 / SP_PER_BP;
    let page = null;
    const stack = [];
    const lines = text.split('\n');
    const rec = /^([[(vhxkg$])(\d+),(\d+)(?:,-?\d+)?:(-?\d+),(-?\d+)(?::(-?\d+)(?:,(-?\d+),(-?\d+))?)?/;

    for (const raw of lines) {
      const c = raw.charAt(0);
      if (c === 'I' && raw.startsWith('Input:')) {
        const m = raw.match(/^Input:(\d+):(.*?)\r?$/); // `.` stops at \r, so allow CRLF files
        if (m && m[2]) this.inputs.set(Number(m[1]), realpath(decodePath(Buffer.from(m[2], 'latin1'), baseDir)));
        continue;
      }
      if (!page) {
        if (raw.startsWith('Unit:')) unit = Number(raw.slice(5)) || 1;
        else if (raw.startsWith('Magnification:')) mag = Number(raw.slice(14)) || 1000;
        else if (raw.startsWith('X Offset:')) xOff = Number(raw.slice(9)) || 0;
        else if (raw.startsWith('Y Offset:')) yOff = Number(raw.slice(9)) || 0;
        factor = (unit * mag) / 1000 / SP_PER_BP;
      }
      if (c === '{') {
        const n = Number(raw.slice(1));
        page = { boxes: [], leaves: [] };
        this.pages.set(n, page);
        stack.length = 0;
        continue;
      }
      if (c === '}') {
        page = null;
        continue;
      }
      if (!page) continue;
      if (c === ')' || c === ']') {
        stack.pop();
        continue;
      }
      const m = rec.exec(raw);
      if (!m) continue;
      const r = {
        type: m[1],
        tag: Number(m[2]),
        line: Number(m[3]),
        x: (Number(m[4]) + xOff) * factor,
        y: (Number(m[5]) + yOff) * factor,
        w: m[6] ? Number(m[6]) * factor : 0,
        h: m[7] ? Number(m[7]) * factor : 0,
        d: m[8] ? Number(m[8]) * factor : 0,
        parent: stack.length ? stack[stack.length - 1] : null,
      };
      if (r.type === '[' || r.type === '(') {
        stack.push(r);
        if (r.type === '(') page.boxes.push(r);
      } else {
        page.leaves.push(r);
        if (r.type === 'h') page.boxes.push(r);
      }
    }
  }

  /** PDF → source. x, y in PDF points from the page's top-left. Returns {file, line} or null. */
  toSource(pageNo, x, y) {
    const page = this.pages.get(pageNo);
    if (!page) return null;

    // Smallest horizontal box (a typeset line) containing the point.
    let best = null;
    for (const b of page.boxes) {
      if (b.w <= 0) continue;
      if (x < b.x - 1 || x > b.x + b.w + 1 || y < b.y - b.h - 1 || y > b.y + b.d + 1) continue;
      if (!best || b.w * (b.h + b.d) < best.w * (best.h + best.d)) best = b;
    }

    let hit = null;
    if (best) {
      // Leaves on that line: take the nearest one at or left of the click. Leaves carry the
      // line they were read from; the enclosing box carries where the paragraph ended.
      let left = null;
      let any = null;
      for (const l of page.leaves) {
        if (Math.abs(l.y - best.y) > 0.5 || l.x < best.x - 1 || l.x > best.x + best.w + 1) continue;
        if (l.x <= x + 0.5 && (!left || l.x > left.x)) left = l;
        if (!any || Math.abs(l.x - x) < Math.abs(any.x - x)) any = l;
      }
      hit = left || any || best;
    } else {
      // Nothing under the cursor (e.g. a gap or a figure): nearest record, vertical distance weighted.
      let bestDist = Infinity;
      for (const l of [...page.leaves, ...page.boxes]) {
        const dy = y < l.y - l.h ? l.y - l.h - y : y > l.y + l.d ? y - l.y - l.d : 0;
        const dx = x < l.x ? l.x - x : x > l.x + l.w ? x - l.x - l.w : 0;
        const dist = dy * 4 + dx;
        if (dist < bestDist) {
          bestDist = dist;
          hit = l;
        }
      }
    }
    if (!hit) return null;
    const file = this.inputs.get(hit.tag);
    return file ? { file, line: hit.line } : null;
  }

  /** Source → PDF. Returns {page, x, y, h}: top-left corner and height of the line, PDF points or null. */
  toPdf(file, line) {
    const target = realpath(file);
    const tags = [...this.inputs].filter(([, f]) => f === target).map(([t]) => t);
    if (!tags.length) return null;

    // Leaf records (glue, kerns, math) carry the line they were read from, while line boxes carry
    // the line where their paragraph ended, so only fall back to boxes when no leaf matches.
    const search = (kind) => {
      let best = null;
      let bestDelta = Infinity;
      for (const [pageNo, page] of this.pages) {
        for (const r of page[kind]) {
          if (!tags.includes(r.tag)) continue;
          // Right-margin kern/glue (\rightskip, \parfillskip) is tagged with the paragraph's last line.
          if (kind === 'leaves' && r.parent && r.type !== 'h' && r.x >= r.parent.x + r.parent.w - 0.01) continue;
          // Prefer an exact line; otherwise the nearest following line, then the nearest preceding.
          const delta = r.line >= line ? r.line - line : (line - r.line) * 1.5 + 0.1;
          if (delta < bestDelta || (delta === bestDelta && (pageNo < best.page || (pageNo === best.page && r.y < best.ry)))) {
            bestDelta = delta;
            // Highlight the whole typeset line the record sits on.
            // The outermost horizontal box above the record is the typeset line (this climbs out
            // of fractions, scripts and other nested boxes in display math).
            let box = r;
            for (let a = r.parent; a; a = a.parent) if (a.type === '(' && a.w > 0) box = a;
            const h = Math.max(box.h, 7);
            best = { page: pageNo, x: box.x, w: box.w, ry: r.y, y: box.y - h, h: h + Math.max(box.d, 2) };
          }
        }
      }
      return best && bestDelta <= 3 ? best : null;
    };
    const best = search('leaves') || search('boxes');
    if (best) delete best.ry;
    return best;
  }
}

module.exports = { SyncTex };
