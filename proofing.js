'use strict';

// Spelling (Hunspell dictionaries through nspell, offline) and grammar (LanguageTool, opt-in).
//
// Both read the same "reading text" of a file: prose as written, markup (commands, math,
// comments, the preamble) replaced by what a reader sees there: nothing, a placeholder word, a
// paragraph break or an accented letter. Every reading-text character maps back to a source
// range, so results land on the source words.

const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const os = require('os');
const project = require('./project');
const { mathSpans } = require('./math');

const LATEX = [{ language: 'latex' }, { language: 'tex' }];
const isTex = (doc) => doc && (doc.languageId === 'latex' || doc.languageId === 'tex');
const config = () => vscode.workspace.getConfiguration('texPreview');

// ---------------------------------------------------------------------------
// Reading text

/** Commands whose arguments aren't prose: the command and all its arguments are skipped. */
const SKIP_ARGS = new Set(
  'label ref eqref cref Cref autoref pageref nameref vref labelcref cpageref Cpageref subref nocite includegraphics input include subfile includeonly bibliography bibliographystyle addbibresource printbibliography usepackage RequirePackage documentclass url hspace vspace setlength addtolength setcounter addtocounter newcommand renewcommand providecommand DeclareMathOperator newenvironment renewenvironment newtheorem theoremstyle graphicspath hypersetup definecolor color pagestyle thispagestyle pagenumbering geometry usetikzlibrary tikzset pgfplotsset captionsetup setlist lstset lstinputlisting includepdf numberwithin crefname Crefname newlength settowidth input ensuremath'.split(' ')
);
/** Commands whose first argument isn't prose but whose later ones are (\textcolor{red}{text}). */
const FIRST_SKIP = new Set('textcolor colorbox fcolorbox href foreignlanguage'.split(' '));
/** Commands that start a block of their own: headings, items, captions, footnotes. */
const BLOCK = new Set('part chapter section subsection subsubsection paragraph subparagraph caption footnote item title author date abstract'.split(' '));
/** Commands that print text. */
const TEXT_CMDS = { LaTeX: 'LaTeX', TeX: 'TeX', LaTeXe: 'LaTeX', ldots: '…', dots: '…', textellipsis: '…', ss: 'ß', o: 'ø', O: 'Ø', ae: 'æ', AE: 'Æ', oe: 'œ', OE: 'Œ', aa: 'å', AA: 'Å', l: 'ł', L: 'Ł', i: 'i', j: 'j', textendash: '–', textemdash: '—', S: '§', ie: 'i.e.', eg: 'e.g.', etal: 'et al.', par: '\n\n', newline: ' ', linebreak: ' ' };
const SYMBOLS = { '\\': ' ', '%': '%', '&': '&', $: '$', '#': '#', _: '_', '{': '{', '}': '}', ' ': ' ', '\n': ' ', ',': ' ', ';': ' ', ':': ' ', '>': ' ', '!': '', '@': '', '-': '', '/': '' };
/** Environments with no prose inside. */
const NON_PROSE_ENV = /^(verbatim|Verbatim|BVerbatim|lstlisting|minted|comment|filecontents|tikzpicture|tikzcd|pgfpicture|axis|forest|thebibliography|lilypond|asy)\*?$/;
/** Environments whose \begin takes non-prose arguments after the name. */
const ARG_ENV = /^(tabular|tabularx|tabulary|array|longtable|minipage|multicols|wrapfigure|wraptable|tabu|supertabular|xtabular|subfigure)\*?$/;
const CITE_LIKE = /cite|ref$/i;

/** End of the [..] group opening at s[j], or -1. */
function bracket(s, j) {
  if (s[j] !== '[') return -1;
  let depth = 0;
  for (let k = j; k < s.length && k < j + 2000; k++) {
    const ch = s[k];
    if (ch === '\\') k++;
    else if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') {
      if (--depth === 0) return ch === ']' ? k + 1 : -1;
    } else if (ch === '\n' && /^[ \t]*\n/.test(s.slice(k + 1, k + 80))) return -1;
  }
  return -1;
}

/** End of the {..} group opening at s[j], or -1. */
function brace(s, j) {
  const g = s[j] === '{' ? project.group(s, j) : null;
  return g ? g.end : -1;
}

/** Index after the spaces (not a blank line) from j. */
function spaces(s, j) {
  let k = j;
  while (k < s.length && (s[k] === ' ' || s[k] === '\t' || (s[k] === '\n' && !/^[ \t]*\n/.test(s.slice(k + 1, k + 80))))) k++;
  return k;
}

/**
 * The reading text of LaTeX source: {text, from, to}, where reading-text character k comes from
 * source offsets [from[k], to[k]).
 */
function readingText(src) {
  const s = project.stripComments(src);
  const n = s.length;
  const owner = new Int32Array(n).fill(-1);
  const ranges = [];
  const closeAs = new Map(); // offset of a closing brace -> what it reads as
  const add = (start, end, as) => {
    if (end <= start) return;
    const id = ranges.push(as) - 1;
    for (let k = start; k < end && k < n; k++) if (owner[k] === -1) owner[k] = id;
  };

  // Comments
  for (let k = 0; k < n; k++) {
    if (s[k] !== src[k]) {
      let e = k;
      while (e < n && s[e] !== src[e]) e++;
      add(k, e, '');
      k = e;
    }
  }
  // The preamble and anything after \end{document}
  if (/\\documentclass\b/.test(s)) {
    const b = s.indexOf('\\begin{document}');
    if (b >= 0) add(0, b + '\\begin{document}'.length, '');
  }
  const e = s.indexOf('\\end{document}');
  if (e >= 0) add(e, n, '');
  // Math
  for (const m of mathSpans(s)) add(m.start, m.end, m.display ? ' X ' : 'X');

  const CMD = /\\(?:([a-zA-Z@]+)(\*?)|([^a-zA-Z@]))/y;
  for (let i = 0; i < n; ) {
    if (owner[i] !== -1) {
      i++;
      continue;
    }
    const ch = s[i];
    if (ch === '\\') {
      CMD.lastIndex = i;
      const m = CMD.exec(s);
      if (!m) {
        i++;
        continue;
      }
      let j = i + m[0].length;
      const name = m[1];
      const accent = name ? (/^[cvuH]$/.test(name) ? name : null) : m[3] in project.ACCENTS ? m[3] : null;
      if (accent) {
        // \"o, \'{e}, \"\i, \H{o}, \c c (a letter-named accent needs braces or a space)
        const a = (name ? /^(?:\{\s*(\\[ij]|[a-zA-Z])\s*\}|\s+(\\[ij](?![a-zA-Z])|[a-zA-Z]))/ : /^(?:\{\s*(\\[ij]|[a-zA-Z])\s*\}|(\\[ij](?![a-zA-Z])|[a-zA-Z]))/).exec(s.slice(j, j + 12));
        if (a) {
          const letter = (a[1] || a[2]).replace(/^\\/, '');
          add(i, j + a[0].length, (letter + project.ACCENTS[accent]).normalize('NFC'));
          i = j + a[0].length;
          continue;
        }
      }
      if (!name) {
        if (m[3] === '\\' && bracket(s, j) > 0) j = bracket(s, j); // \\[2pt]
        add(i, j, SYMBOLS[m[3]] ?? '');
        i = j;
        continue;
      }
      if (name === 'begin' || name === 'end') {
        const k = spaces(s, j);
        const g = brace(s, k);
        const env = g > 0 ? s.slice(k + 1, g - 1).trim() : '';
        if (g < 0) {
          add(i, j, '\n\n');
          i = j;
          continue;
        }
        j = g;
        if (name === 'begin' && NON_PROSE_ENV.test(env)) {
          const close = s.indexOf(`\\end{${env}}`, j);
          j = close < 0 ? n : close + `\\end{${env}}`.length;
        } else if (name === 'begin') {
          for (;;) {
            const k2 = spaces(s, j);
            const end = s[k2] === '[' ? bracket(s, k2) : ARG_ENV.test(env) && s[k2] === '{' ? brace(s, k2) : -1;
            if (end < 0) break;
            j = end;
          }
        }
        add(i, j, '\n\n');
        i = j;
        continue;
      }
      if (SKIP_ARGS.has(name) || /cite/i.test(name)) {
        for (;;) {
          const k = spaces(s, j);
          const end = s[k] === '[' ? bracket(s, k) : s[k] === '{' ? brace(s, k) : -1;
          if (end < 0) break;
          j = end;
        }
        add(i, j, CITE_LIKE.test(name) ? 'X' : '');
        i = j;
        continue;
      }
      if (FIRST_SKIP.has(name)) {
        for (let k = spaces(s, j), end; (end = bracket(s, k)) > 0; k = spaces(s, end)) j = end;
        const k = spaces(s, j);
        const end = brace(s, k);
        if (end > 0) j = end;
        add(i, j, '');
        i = j;
        continue;
      }
      // Optional arguments belong to the command.
      for (let k = j, end; (end = bracket(s, k)) > 0; k = end) j = end;
      if (BLOCK.has(name)) {
        const k = spaces(s, j);
        const end = brace(s, k);
        if (end > 0) {
          closeAs.set(end - 1, '\n\n');
          j = k + 1;
        }
        add(i, j, '\n\n');
        i = j;
        continue;
      }
      if (name in TEXT_CMDS) {
        if (s.startsWith('{}', j)) j += 2;
        add(i, j, TEXT_CMDS[name]);
        i = j;
        continue;
      }
      add(i, j, '');
      i = j;
    } else if (ch === '{' || ch === '}') {
      add(i, i + 1, ch === '}' ? closeAs.get(i) ?? '' : '');
      i++;
    } else if (ch === '~' || ch === '&') {
      add(i, i + 1, ' ');
      i++;
    } else if ((ch === '`' && s[i + 1] === '`') || (ch === "'" && s[i + 1] === "'")) {
      add(i, i + 2, '"');
      i += 2;
    } else if (ch === '-' && s[i + 1] === '-') {
      const len = s[i + 2] === '-' ? 3 : 2;
      add(i, i + len, len === 3 ? '—' : '–');
      i += len;
    } else i++;
  }

  let text = '';
  const from = [];
  const to = [];
  for (let i = 0; i < n; ) {
    const o = owner[i];
    if (o === -1) {
      text += src[i];
      from.push(i);
      to.push(i + 1);
      i++;
      continue;
    }
    let j = i;
    while (j < n && owner[j] === o) j++;
    const as = ranges[o];
    text += as;
    for (let k = 0; k < as.length; k++) {
      from.push(i);
      to.push(j);
    }
    i = j;
  }
  return { text, from, to };
}

const readings = new WeakMap(); // TextDocument -> { version, r }
function reading(doc) {
  const c = readings.get(doc);
  if (c && c.version === doc.version) return c.r;
  const r = readingText(doc.getText());
  readings.set(doc, { version: doc.version, r });
  return r;
}

/** Source range of reading-text characters [a, b). */
function sourceRange(doc, r, a, b) {
  return new vscode.Range(doc.positionAt(r.from[a]), doc.positionAt(r.to[Math.max(a, b - 1)]));
}

/** Paragraphs of the reading text that have words in them: [{start, end, text}]. */
function paragraphs(text) {
  const out = [];
  const re = /\n[ \t]*\n\s*/g;
  let start = 0;
  for (let m; ; start = re.lastIndex) {
    m = re.exec(text);
    const end = m ? m.index : text.length;
    const t = text.slice(start, end);
    const lead = t.length - t.trimStart().length;
    const body = t.trim();
    if (/\p{L}{2}/u.test(body)) out.push({ start: start + lead, end: start + lead + body.length, text: body });
    if (!m) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Spelling

const BUNDLED = { en_us: 'dictionary-en', en: 'dictionary-en', en_gb: 'dictionary-en-gb' };
const HUNSPELL_DIRS = [
  path.join(os.homedir(), 'Library', 'Spelling'),
  '/Library/Spelling',
  '/opt/homebrew/share/hunspell',
  '/usr/local/share/hunspell',
  '/usr/share/hunspell',
  '/usr/share/myspell',
  '/usr/share/myspell/dicts',
];

/** {aff, dic} paths for a language like en-GB / de_DE, or a path to a .dic file; null if none. */
function dictionaryFiles(lang) {
  if (/\.dic$/i.test(lang) && fs.existsSync(lang)) return { dic: lang, aff: lang.replace(/\.dic$/i, '.aff') };
  const code = lang.replace('-', '_');
  const pkg = BUNDLED[code.toLowerCase()];
  if (pkg) {
    const dir = path.join(__dirname, 'node_modules', pkg);
    return { aff: path.join(dir, 'index.aff'), dic: path.join(dir, 'index.dic') };
  }
  for (const dir of HUNSPELL_DIRS) {
    const dic = path.join(dir, `${code}.dic`);
    if (fs.existsSync(dic)) return { dic, aff: path.join(dir, `${code}.aff`) };
  }
  return null;
}

const dictionaries = new Map(); // language -> { spell, cache } | null
function dictionary(lang) {
  if (dictionaries.has(lang)) return dictionaries.get(lang);
  let d = null;
  const files = dictionaryFiles(lang);
  if (files) {
    try {
      d = { spell: require('nspell')({ aff: fs.readFileSync(files.aff), dic: fs.readFileSync(files.dic) }), cache: new Map() };
    } catch (e) {
      vscode.window.showWarningMessage(`TeX spell check: couldn't load the ${lang} dictionary (${e.message}).`);
    }
  } else {
    vscode.window.showWarningMessage(`TeX spell check: no Hunspell dictionary for "${lang}". Use en-US, en-GB, a name like de_DE installed in a Hunspell folder, or the path of a .dic file.`);
  }
  dictionaries.set(lang, d);
  return d;
}

/** `% !TeX spellcheck = en_GB` near the top of the file, else the setting. */
function languageOf(doc) {
  const head = doc.getText(new vscode.Range(0, 0, Math.min(doc.lineCount, 30), 0));
  const m = /^\s*%\s*!\s*TeX\s+spellcheck\s*=\s*(\S+)/im.exec(head);
  return m ? m[1] : config().get('spellcheck.language') || 'en-US';
}

/** Words accepted in user and workspace settings, lower-cased. */
function userWords() {
  const i = config().inspect('spellcheck.words') || {};
  return new Set([...(i.globalValue || []), ...(i.workspaceValue || []), ...(i.workspaceFolderValue || [])].map((w) => w.toLowerCase()));
}

/** Author and editor names in the project's bibliography, lower-cased. */
function bibWords(doc) {
  const out = new Set();
  if (doc.uri.scheme !== 'file') return out;
  try {
    for (const e of project.project(doc.uri.fsPath).entries()) {
      for (const f of e.fields || []) {
        if (f.name === 'author' || f.name === 'editor') for (const w of f.value.split(/[^\p{L}'’]+/u)) if (w.length > 1) out.add(w.toLowerCase());
      }
    }
  } catch {
    /* no project */
  }
  return out;
}

const WORD = /\p{L}[\p{L}\p{M}]*(?:['’]\p{L}+)*/gu;
const SKIP_SPANS = /\b(?:https?:\/\/|www\.)\S+|\S+@\S+\.\w+/g;

/** Misspelled words: [{a, b, word}] with reading-text offsets. */
function misspellings(text, dict, known) {
  const skip = [];
  for (const m of text.matchAll(SKIP_SPANS)) skip.push([m.index, m.index + m[0].length]);
  const out = [];
  for (const m of text.matchAll(WORD)) {
    const word = m[0].replace(/’/g, "'");
    if (word.length < 2 || /^\p{Lu}+s?$/u.test(word) || /\p{Ll}\p{Lu}/u.test(word)) continue; // acronyms, camelCase
    if (/\d/.test(text[m.index - 1] || '') || /\d/.test(text[m.index + m[0].length] || '')) continue;
    if (skip.some(([a, b]) => m.index >= a && m.index < b)) continue;
    if (!isCorrect(word, dict, known)) out.push({ a: m.index, b: m.index + m[0].length, word });
    if (out.length >= 1000) break;
  }
  return out;
}

function isCorrect(word, dict, known) {
  const base = word.replace(/'s$/i, '');
  if (known.has(word.toLowerCase()) || known.has(base.toLowerCase())) return true;
  let ok = dict.cache.get(word);
  if (ok === undefined) {
    const plain = word.normalize('NFD').replace(/\p{M}/gu, ''); // naïve, if the dictionary only has naive
    ok = dict.spell.correct(word) || (base !== word && dict.spell.correct(base)) || (plain !== word && dict.spell.correct(plain));
    dict.cache.set(word, ok);
  }
  return ok;
}

/** Up to five corrections; swapped neighbouring letters (teh → the) first, which nspell ranks low. */
function suggestions(dict, word) {
  const swaps = [];
  for (let k = 0; k < word.length - 1; k++) {
    const w = word.slice(0, k) + word[k + 1] + word[k] + word.slice(k + 2);
    if (w !== word && dict.spell.correct(w) && !swaps.includes(w)) swaps.push(w);
  }
  return [...new Set([...swaps, ...dict.spell.suggest(word)])].slice(0, 5);
}

// ---------------------------------------------------------------------------
// Grammar (LanguageTool)

const PUBLIC_SERVER = 'https://api.languagetool.org';
const PREMIUM_SERVER = 'https://api.languagetoolplus.com';
const ltCache = new Map(); // language + paragraph text -> matches relative to the paragraph
let ltQueue = Promise.resolve();
let ltLast = 0;
let ltPausedUntil = 0;
let secrets;
const warned = new Set();
const warnOnce = (key, msg) => {
  if (warned.has(key)) return;
  warned.add(key);
  vscode.window.showWarningMessage(msg);
};

function ltLanguage(lang) {
  const code = path.basename(lang).replace(/\.dic$/i, '').replace('_', '-');
  return /^[a-z]{2,3}(-[A-Za-z]{2,})?$/.test(code) ? code : 'auto';
}

async function ltServer() {
  const key = await secrets.get('texPreview.grammar.apiKey');
  const user = config().get('grammar.username');
  let server = (config().get('grammar.server') || PUBLIC_SERVER).replace(/\/+$/, '');
  if (key && user && server === PUBLIC_SERVER) server = PREMIUM_SERVER;
  return { server, auth: key && user ? { username: user, apiKey: key } : {}, public: server === PUBLIC_SERVER };
}

/** One /v2/check request, queued so the public API's rate limit (20 a minute) holds. */
function ltCheck(text, language) {
  const run = async () => {
    const { server, auth, public: pub } = await ltServer();
    const wait = Math.max(ltPausedUntil - Date.now(), pub ? ltLast + 3500 - Date.now() : 0);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    ltLast = Date.now();
    const res = await fetch(`${server}/v2/check`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({ text, language, ...auth }),
      signal: AbortSignal.timeout(30000),
    });
    if (res.status === 429) {
      ltPausedUntil = Date.now() + 60000;
      throw new Error('LanguageTool rate limit reached; pausing grammar checks for a minute');
    }
    if (!res.ok) throw new Error(`LanguageTool ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return (await res.json()).matches || [];
  };
  const p = ltQueue.then(run, run);
  ltQueue = p.catch(() => {});
  return p;
}

/** Checks the paragraphs of `doc` not checked before, publishing as results arrive. */
async function checkGrammar(doc, publish) {
  const r = reading(doc);
  const lang = ltLanguage(languageOf(doc));
  const todo = paragraphs(r.text).filter((p) => !ltCache.has(lang + '\0' + p.text));
  const { public: pub } = await ltServer();
  const max = pub ? 15000 : 60000;
  while (todo.length) {
    const batch = [];
    let size = 0;
    while (todo.length && (!batch.length || size + todo[0].text.length + 2 <= max)) {
      const p = todo.shift();
      batch.push({ ...p, base: size });
      size += p.text.length + 2;
    }
    const text = batch.map((p) => p.text).join('\n\n');
    let matches;
    try {
      matches = await ltCheck(text.slice(0, Math.max(max, batch[0].text.length)), lang);
    } catch (e) {
      warnOnce(e.message.slice(0, 40), `TeX grammar check: ${e.message}`);
      return;
    }
    for (const p of batch) {
      const mine = matches.filter((m) => m.offset >= p.base && m.offset + m.length <= p.base + p.text.length).map((m) => ({ ...m, offset: m.offset - p.base }));
      ltCache.set(lang + '\0' + p.text, mine);
      if (ltCache.size > 5000) ltCache.delete(ltCache.keys().next().value);
    }
    publish(doc);
    if (doc.isClosed) return;
  }
}

// ---------------------------------------------------------------------------
// Diagnostics and quick fixes

let spellDiags;
let grammarDiags;
const spellFound = new Map(); // uri -> [{range, word}]
const grammarFound = new Map(); // uri -> [{range, match}]

function spellCheck(doc) {
  if (!config().get('spellcheck.enabled')) {
    spellDiags.delete(doc.uri);
    spellFound.delete(doc.uri.toString());
    updateContext();
    return;
  }
  const dict = dictionary(languageOf(doc));
  if (!dict) return;
  const r = reading(doc);
  const known = new Set([...userWords(), ...bibWords(doc)]);
  const found = misspellings(r.text, dict, known).map((m) => ({ range: sourceRange(doc, r, m.a, m.b), word: m.word }));
  spellFound.set(doc.uri.toString(), found);
  updateContext();
  const lang = languageOf(doc);
  spellDiags.set(
    doc.uri,
    found.map((f) => {
      const d = new vscode.Diagnostic(f.range, `"${f.word}" is not in the ${lang} dictionary`, vscode.DiagnosticSeverity.Information);
      d.source = 'Spelling';
      return d;
    })
  );
}

/** LanguageTool's own dictionary spell checkers, left out since Hunspell checks spelling. (Other
 * rules marked "misspelling", like "faster then", are grammar and are kept.) */
const SPELLER = /^(MORFOLOGIK_RULE|HUNSPELL_RULE|HUNSPELL_NO_SUGGEST_RULE|[A-Z_]*SPELLER_RULE)/;

function publishGrammar(doc) {
  if (doc.isClosed) return;
  const r = reading(doc);
  const lang = ltLanguage(languageOf(doc));
  const disabled = new Set(config().get('grammar.disabledRules') || []);
  const found = [];
  for (const p of paragraphs(r.text)) {
    for (const m of ltCache.get(lang + '\0' + p.text) || []) {
      if (SPELLER.test(m.rule?.id || '') || disabled.has(m.rule?.id)) continue;
      found.push({ range: sourceRange(doc, r, p.start + m.offset, p.start + m.offset + m.length), match: m });
    }
  }
  grammarFound.set(doc.uri.toString(), found);
  updateContext();
  grammarDiags.set(
    doc.uri,
    found.map(({ range, match }) => {
      const sev = match.rule?.issueType === 'style' || match.rule?.issueType === 'typographical' ? vscode.DiagnosticSeverity.Hint : vscode.DiagnosticSeverity.Information;
      const d = new vscode.Diagnostic(range, match.message, sev);
      d.source = 'LanguageTool';
      d.code = match.rule?.id;
      return d;
    })
  );
}

function grammarCheck(doc) {
  if (!config().get('grammar.enabled')) {
    grammarDiags.delete(doc.uri);
    grammarFound.delete(doc.uri.toString());
    updateContext();
    return;
  }
  publishGrammar(doc);
  // Only what's on screen goes to the server, to keep within the free API's limits.
  if (vscode.window.visibleTextEditors.some((e) => e.document === doc)) checkGrammar(doc, publishGrammar);
}

// Their own kinds, so the right-click "Spelling and Grammar Suggestions" can show just these.
const PROOFING = vscode.CodeActionKind.QuickFix.append('proofing');
const SPELLING = PROOFING.append('spelling');
const GRAMMAR = PROOFING.append('grammar');

const sameRange = (a, b) => a.start.isEqual(b.start) && a.end.isEqual(b.end);
const MARKUP = /[\\{}$%]/;

class ProofingActions {
  provideCodeActions(doc, range, ctx) {
    const out = [];
    const key = doc.uri.toString();
    for (const d of ctx.diagnostics) {
      if (d.source === 'Spelling') {
        const f = (spellFound.get(key) || []).find((x) => sameRange(x.range, d.range));
        if (!f) continue;
        const dict = dictionary(languageOf(doc));
        if (dict && !MARKUP.test(doc.getText(d.range))) {
          const sugg = suggestions(dict, f.word);
          sugg.forEach((s, i) => {
            const a = new vscode.CodeAction(`Change to "${s}"`, SPELLING);
            a.edit = new vscode.WorkspaceEdit();
            a.edit.replace(doc.uri, d.range, s);
            a.diagnostics = [d];
            a.isPreferred = i === 0;
            out.push(a);
          });
        }
        const add = (title, target) => {
          const a = new vscode.CodeAction(title, SPELLING);
          a.command = { command: 'texPreview.spellcheck.addWord', title, arguments: [f.word, target] };
          a.diagnostics = [d];
          out.push(a);
        };
        add(`Add "${f.word}" to user dictionary`, 'user');
        if (vscode.workspace.workspaceFolders) add(`Add "${f.word}" to workspace dictionary`, 'workspace');
      } else if (d.source === 'LanguageTool') {
        const f = (grammarFound.get(key) || []).find((x) => sameRange(x.range, d.range) && x.match.message === d.message);
        if (!f) continue;
        if (!MARKUP.test(doc.getText(d.range))) {
          (f.match.replacements || []).slice(0, 5).forEach((rep, i) => {
            const a = new vscode.CodeAction(rep.value ? `Change to "${rep.value}"` : 'Delete', GRAMMAR);
            a.edit = new vscode.WorkspaceEdit();
            a.edit.replace(doc.uri, d.range, rep.value);
            a.diagnostics = [d];
            a.isPreferred = i === 0;
            out.push(a);
          });
        }
        if (f.match.rule?.id) {
          const title = `Disable grammar rule: ${f.match.rule.description || f.match.rule.id}`;
          const a = new vscode.CodeAction(title, GRAMMAR);
          a.command = { command: 'texPreview.grammar.disableRule', title, arguments: [f.match.rule.id] };
          a.diagnostics = [d];
          out.push(a);
        }
      }
    }
    return out;
  }
}

/**
 * texPreview.hasProofing: the active file has spelling or grammar issues, which shows the
 * right-click entry. (A per-word key would race the menu: it opens before the cursor moves.)
 */
let hasProofing = false;
function updateContext() {
  const key = vscode.window.activeTextEditor?.document.uri.toString();
  const now = !!key && ((spellFound.get(key) || []).length > 0 || (grammarFound.get(key) || []).length > 0);
  if (now !== hasProofing) vscode.commands.executeCommand('setContext', 'texPreview.hasProofing', (hasProofing = now));
}

/** VS Code's quick-fix menu at the cursor, with only spelling and grammar fixes. */
function showSuggestions() {
  return vscode.commands.executeCommand('editor.action.codeAction', { kind: PROOFING.value, apply: 'never' });
}

/** Where a setting is set: the workspace if it overrides it there, else the user settings. */
function targetOf(key) {
  const i = config().inspect(key) || {};
  return i.workspaceFolderValue !== undefined || i.workspaceValue !== undefined ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
}

async function toggleSpelling() {
  await config().update('spellcheck.enabled', !config().get('spellcheck.enabled'), targetOf('spellcheck.enabled'));
  vscode.window.setStatusBarMessage(`Spell check ${config().get('spellcheck.enabled') ? 'on' : 'off'}`, 3000);
}

async function toggleGrammar(context) {
  const on = !config().get('grammar.enabled');
  const server = (config().get('grammar.server') || PUBLIC_SERVER).replace(/\/+$/, '');
  if (on && server === PUBLIC_SERVER && !context.globalState.get('texPreview.grammar.consent')) {
    const local = 'Use a Local Server…';
    const pick = await vscode.window.showInformationMessage(
      'Grammar checks send the text of the .tex files you have open to LanguageTool (api.languagetool.org). Their free service is limited to about 20 checks a minute. To keep your text on this machine, run a LanguageTool server locally instead.',
      { modal: true },
      'Use LanguageTool Online',
      local
    );
    if (!pick) return;
    if (pick === local) {
      const url = await vscode.window.showInputBox({ title: 'LanguageTool server', prompt: 'Start one with: docker run -p 8010:8010 erikvl87/languagetool', value: 'http://localhost:8010', ignoreFocusOut: true });
      if (!url) return;
      await config().update('grammar.server', url, vscode.ConfigurationTarget.Global);
    } else await context.globalState.update('texPreview.grammar.consent', true);
  }
  await config().update('grammar.enabled', on, targetOf('grammar.enabled'));
  vscode.window.setStatusBarMessage(`Grammar check ${on ? 'on: paragraphs are checked as you type' : 'off'}`, 4000);
}

/** Picks the spelling (and grammar) language from the bundled and installed dictionaries. */
async function chooseLanguage() {
  const current = config().get('spellcheck.language') || 'en-US';
  const items = [
    { label: 'en-US', description: 'English (US), bundled' },
    { label: 'en-GB', description: 'English (UK), bundled' },
  ];
  for (const dir of HUNSPELL_DIRS) {
    let names = [];
    try {
      names = fs.readdirSync(dir).filter((n) => /\.dic$/i.test(n));
    } catch {
      continue;
    }
    for (const n of names) {
      const code = n.replace(/\.dic$/i, '');
      if (!items.some((i) => i.label.replace('-', '_').toLowerCase() === code.toLowerCase())) items.push({ label: code, description: `installed in ${dir}` });
    }
  }
  items.push({ label: '$(folder-opened) Other .dic file…', other: true, description: 'any Hunspell dictionary, e.g. from LibreOffice' });
  for (const i of items) if (i.label === current) i.description = `${i.description} (current)`;
  const pick = await vscode.window.showQuickPick(items, { title: 'Spelling and grammar language', placeHolder: 'A file can also choose its own with % !TeX spellcheck = en_GB' });
  if (!pick) return;
  let value = pick.label;
  if (pick.other) {
    const f = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { 'Hunspell dictionary': ['dic'] }, title: 'Hunspell .dic file (the .aff file must be next to it)' });
    if (!f) return;
    value = f[0].fsPath;
  }
  dictionaries.delete(value);
  await config().update('spellcheck.language', value, targetOf('spellcheck.language'));
}

async function addWord(word, target) {
  const global = target !== 'workspace';
  const cur = config().inspect('spellcheck.words') || {};
  const list = (global ? cur.globalValue : cur.workspaceValue) || [];
  if (!list.includes(word)) await config().update('spellcheck.words', [...list, word].sort(), global ? vscode.ConfigurationTarget.Global : vscode.ConfigurationTarget.Workspace);
}

async function disableRule(id) {
  const list = config().get('grammar.disabledRules') || [];
  if (!list.includes(id)) await config().update('grammar.disabledRules', [...list, id], vscode.ConfigurationTarget.Global);
}

function activate(context) {
  secrets = context.secrets;
  spellDiags = vscode.languages.createDiagnosticCollection('tex-spelling');
  grammarDiags = vscode.languages.createDiagnosticCollection('tex-grammar');
  const timers = new Map();
  const schedule = (doc, kind, delay) => {
    if (!isTex(doc) || (doc.uri.scheme !== 'file' && doc.uri.scheme !== 'untitled')) return;
    const k = kind + doc.uri.toString();
    clearTimeout(timers.get(k));
    timers.set(
      k,
      setTimeout(() => {
        timers.delete(k);
        if (!doc.isClosed) (kind === 's' ? spellCheck : grammarCheck)(doc);
      }, delay)
    );
  };
  const both = (doc, spell, grammar) => {
    schedule(doc, 's', spell);
    schedule(doc, 'g', grammar);
  };
  const all = () => vscode.workspace.textDocuments.forEach((d) => both(d, 0, 0));

  context.subscriptions.push(
    spellDiags,
    grammarDiags,
    vscode.languages.registerCodeActionsProvider(LATEX, new ProofingActions(), { providedCodeActionKinds: [SPELLING, GRAMMAR] }),
    vscode.commands.registerCommand('texPreview.spellcheck.addWord', addWord),
    vscode.commands.registerCommand('texPreview.proofing.suggest', showSuggestions),
    vscode.commands.registerCommand('texPreview.spellcheck.toggle', toggleSpelling),
    vscode.commands.registerCommand('texPreview.grammar.toggle', () => toggleGrammar(context)),
    vscode.commands.registerCommand('texPreview.spellcheck.chooseLanguage', chooseLanguage),
    vscode.window.onDidChangeActiveTextEditor(updateContext),
    vscode.commands.registerCommand('texPreview.grammar.disableRule', disableRule),
    vscode.commands.registerCommand('texPreview.grammar.setApiKey', async () => {
      const key = await vscode.window.showInputBox({ title: 'LanguageTool Premium API key', prompt: 'Stored in VS Code secret storage. Also set texPreview.grammar.username. Leave empty to remove.', password: true, ignoreFocusOut: true });
      if (key === undefined) return;
      if (key) await secrets.store('texPreview.grammar.apiKey', key);
      else await secrets.delete('texPreview.grammar.apiKey');
      all();
    }),
    vscode.workspace.onDidOpenTextDocument((d) => both(d, 300, 1000)),
    vscode.workspace.onDidChangeTextDocument((e) => e.contentChanges.length && both(e.document, 400, 2000)),
    vscode.workspace.onDidCloseTextDocument((d) => {
      spellDiags.delete(d.uri);
      grammarDiags.delete(d.uri);
      spellFound.delete(d.uri.toString());
      grammarFound.delete(d.uri.toString());
    }),
    vscode.window.onDidChangeVisibleTextEditors((eds) => eds.forEach((e) => schedule(e.document, 'g', 500))),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('texPreview.spellcheck') || e.affectsConfiguration('texPreview.grammar')) all();
    }),
    { dispose: () => timers.forEach(clearTimeout) }
  );
  // Loading a dictionary takes a moment, so leave it until activation is done.
  vscode.workspace.textDocuments.forEach((d) => both(d, 1500, 2500));
}

module.exports = { activate, readingText, paragraphs, misspellings, dictionary, ltLanguage };
