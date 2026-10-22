'use strict';

// Review with AI: the model reads a passage, a section or the file and leaves comment threads on
// what it would change, each with an optional suggested replacement. Like GitHub Copilot's review
// comments: Apply makes the change (as a tracked change), Discard drops it, Keep as Comment turns
// it into an ordinary review comment that collaborators see. AI comments themselves stay on this
// machine: they are not written to .texreview.

const vscode = require('vscode');
const path = require('path');
const ai = require('./ai');
const review = require('./review');
const { sections } = require('./structure');

const isTex = (doc) => doc && (doc.languageId === 'latex' || doc.languageId === 'tex');
let controller;
let icon;
const threads = new Set(); // our vscode.CommentThreads, each with .item = {quote, comment, suggestion, hint, doc}

const FOCUS = [
  { label: '$(checklist) Everything', detail: 'Correctness, clarity, language, notation and LaTeX', focus: 'Look for anything worth changing: errors in reasoning or mathematics, unclear or ambiguous sentences, grammar and style, inconsistent notation or terminology, and LaTeX problems.' },
  { label: '$(book) Language and style', detail: 'Grammar, clarity, concision, tone', focus: 'Focus on language: grammar, clarity, concision, flow and academic tone.' },
  { label: '$(symbol-operator) Mathematics and notation', detail: 'Correctness, consistency of symbols, definitions before use', focus: 'Focus on the mathematics: errors, missing assumptions, symbols used before they are defined, and inconsistent notation.' },
  { label: '$(list-tree) Structure and argument', detail: 'Logic, missing steps, ordering, unsupported claims', focus: 'Focus on the argument: gaps in logic, missing steps, unsupported claims, and ordering of ideas.' },
  { label: '$(code) LaTeX', detail: 'Markup, references, spacing, environments', focus: 'Focus on LaTeX: wrong or fragile markup, missing ~ before \\ref and \\cite, misuse of environments, spacing and typography.' },
  { label: '$(edit) Custom focus…', custom: true },
];

/** The section around `pos` (its heading up to the next heading of the same or higher level). */
function sectionAt(doc, pos) {
  const text = doc.getText();
  const off = doc.offsetAt(pos);
  const hs = sections(text).filter((h) => !h.appendix);
  const i = hs.map((h) => h.start <= off).lastIndexOf(true);
  if (i < 0) return null;
  const h = hs[i];
  const next = hs.slice(i + 1).find((x) => x.level <= h.level);
  let end = next ? next.start : text.indexOf('\\end{document}');
  if (end < 0) end = text.length;
  return { range: new vscode.Range(doc.positionAt(h.start), doc.positionAt(end)), title: h.title };
}

/** Where `quote` is in `text`, nearest to `hint`: [start, end] or null. Whitespace may differ. */
function locate(text, quote, hint = 0) {
  const hits = [];
  for (let i = text.indexOf(quote); i >= 0 && quote; i = text.indexOf(quote, i + 1)) hits.push([i, i + quote.length]);
  if (!hits.length) {
    const words = quote.trim().split(/\s+/).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    if (!words[0]) return null;
    const re = new RegExp(words.join('\\s+'), 'g');
    for (let m; (m = re.exec(text)); ) hits.push([m.index, m.index + m[0].length]);
  }
  hits.sort((a, b) => Math.abs(a[0] - hint) - Math.abs(b[0] - hint));
  return hits[0] || null;
}

function parse(reply) {
  const body = (/<review>([\s\S]*?)<\/review>/.exec(reply) || [])[1] ?? reply;
  const json = (/\[[\s\S]*\]/.exec(body) || [])[0];
  if (!json) return null;
  try {
    const items = JSON.parse(json);
    return Array.isArray(items) ? items.filter((x) => x && typeof x.quote === 'string' && typeof x.comment === 'string') : null;
  } catch {
    return null;
  }
}

const label = (q) => {
  const s = q.replace(/\s+/g, ' ').trim().replace(/</g, '‹').replace(/>/g, '›').replace(/&/g, '＆');
  return `“${s.length > 48 ? s.slice(0, 47) + '…' : s}”`;
};

function makeThread(doc, s, e, item, author, expanded) {
  const fence = '`'.repeat(Math.max(3, ...((item.suggestion || '').match(/`+/g) || []).map((b) => b.length + 1)));
  const md = new vscode.MarkdownString(item.comment + (item.suggestion ? `\n\n**Suggested change**\n\n${fence}latex\n${item.suggestion}\n${fence}` : ''));
  const comment = { body: md, mode: vscode.CommentMode.Preview, author: { name: author, iconPath: icon }, contextValue: 'ai' };
  const t = controller.createCommentThread(doc.uri, new vscode.Range(doc.positionAt(s), doc.positionAt(e)), [comment]);
  t.label = label(item.quote);
  t.canReply = false;
  t.contextValue = item.suggestion ? 'aiSuggestion' : 'aiNote';
  t.collapsibleState = expanded ? vscode.CommentThreadCollapsibleState.Expanded : vscode.CommentThreadCollapsibleState.Collapsed;
  t.item = { ...item, hint: s, doc };
  threads.add(t);
  return t;
}

/** `opts` (optional, e.g. from a keybinding): {scope: 'selection' | 'section' | 'file', focus: '…'}. */
async function reviewCommand(editor, opts = {}) {
  const doc = editor.document;
  let range = editor.selection.isEmpty ? null : editor.selection;
  let what = 'the selected passage';
  const sec0 = opts.scope === 'section' ? sectionAt(doc, editor.selection.active) : null;
  if (opts.scope === 'file') {
    range = new vscode.Range(0, 0, doc.lineCount, 0);
    what = 'the whole file';
  } else if (opts.scope === 'section' && sec0) {
    range = sec0.range;
    what = `the section “${sec0.title}”`;
  }
  if (!range) {
    const sec = sectionAt(doc, editor.selection.active);
    const items = [
      ...(sec ? [{ label: `$(symbol-namespace) This section`, description: sec.title, range: sec.range, what: `the section “${sec.title}”` }] : []),
      { label: '$(file) Whole file', description: path.basename(doc.uri.fsPath), range: new vscode.Range(0, 0, doc.lineCount, 0), what: 'the whole file' },
    ];
    const pick = items.length > 1 ? await vscode.window.showQuickPick(items, { title: 'Review with AI: what to review' }) : items[0];
    if (!pick) return;
    range = pick.range;
    what = pick.what;
  }
  const f = typeof opts.focus === 'string' ? { focus: opts.focus } : await vscode.window.showQuickPick(FOCUS, { title: 'Review with AI: what to look for', matchOnDetail: true });
  if (!f) return;
  const focus = f.custom ? await vscode.window.showInputBox({ title: 'Review with AI', prompt: 'What should the review look for?', placeHolder: 'e.g. claims that need a citation, overly long sentences' }) : f.focus;
  if (!focus) return;

  const text = doc.getText(range);
  const base = doc.offsetAt(range.start);
  const prompt = `Preamble of the document:\n<preamble>\n${ai.preamble(doc)}\n</preamble>\n\nReview ${what}:\n<passage>\n${text}\n</passage>\n\n${focus}\nBe selective: at most 12 comments, the most useful first; none if nothing needs changing. For each, quote the exact text it is about, copied character for character from the passage (keep quotes short, at most one sentence, and unique), explain the problem in one or two sentences, and give the replacement for the quoted text if you suggest one.\nReturn only a JSON array inside <review></review> tags:\n<review>[{"quote": "...", "comment": "...", "suggestion": "... or empty string"}]</review>`;
  const reply = await ai.complete('AI: reviewing…', ai.SYSTEM.replace('Put your output inside <latex></latex> tags, with nothing else outside the tags unless asked.', 'Follow the output format you are asked for.'), prompt);
  if (reply == null) return;
  const items = parse(reply);
  if (!items) return vscode.window.showErrorMessage('AI review: the model did not return comments in the expected format. Try again or choose another model.');
  if (doc.getText(range) !== text) return vscode.window.showWarningMessage('AI review: the text changed while the model was working; try again.');

  clear(doc.uri); // a new review of this file replaces the last one
  const author = `AI review · ${ai.providerName()}`;
  let placed = 0;
  let missed = 0;
  for (const it of items) {
    const at = locate(text, it.quote);
    if (!at) {
      missed++;
      continue;
    }
    makeThread(doc, base + at[0], base + at[1], { quote: text.slice(at[0], at[1]), comment: it.comment.trim(), suggestion: (it.suggestion || '').trim() }, author, placed === 0);
    placed++;
  }
  if (!placed) return vscode.window.showInformationMessage(items.length ? 'AI review: the comments did not match the text, so none were added.' : 'AI review: no comments; nothing to change.');
  const first = [...threads].filter((t) => t.uri.toString() === doc.uri.toString()).sort((a, b) => a.range.start.compareTo(b.range.start))[0];
  editor.revealRange(first.range, vscode.TextEditorRevealType.InCenter);
  vscode.window.showInformationMessage(`AI review: ${placed} comment${placed === 1 ? '' : 's'}${missed ? ` (${missed} couldn't be placed)` : ''}. Apply, keep or discard each from its title bar; all are in the Comments panel.`);
}

/** Opens the next AI comment in the file of `uri` after `pos`. */
function next(uri, pos) {
  const rest = [...threads].filter((x) => x.uri.toString() === uri.toString()).sort((a, b) => a.range.start.compareTo(b.range.start));
  const n = rest.find((x) => x.range.start.isAfterOrEqual(pos)) || rest[0];
  if (!n) return;
  n.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
  const ed = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === n.uri.toString());
  if (ed) ed.revealRange(n.range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
}

function drop(t) {
  const { uri, range } = t;
  threads.delete(t);
  t.dispose();
  next(uri, range.start);
}

/** Where the thread's quote is now (the text may have moved since the review). */
function currentRange(t) {
  const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === t.uri.toString());
  if (!doc) return null;
  const at = locate(doc.getText(), t.item.quote, doc.offsetAt(t.range.start));
  return at ? { doc, range: new vscode.Range(doc.positionAt(at[0]), doc.positionAt(at[1])) } : null;
}

async function apply(t) {
  if (!t?.item?.suggestion) return;
  const cur = currentRange(t);
  if (!cur) return vscode.window.showWarningMessage('AI review: the commented text has changed, so the suggestion can no longer be applied.');
  if (await ai.applyResult(cur.doc, cur.range, t.item.suggestion)) drop(t);
}

async function keep(t) {
  if (!t?.item) return;
  const cur = currentRange(t);
  if (!cur) return vscode.window.showWarningMessage('AI review: the commented text has changed; the comment can no longer be placed.');
  const body = `${t.item.comment}${t.item.suggestion ? `\n\nSuggested: \`${t.item.suggestion.replace(/`/g, "'")}\`` : ''}\n\n*(from AI review)*`;
  if (await review.addComment(cur.doc, cur.range, body)) drop(t);
}

function clear(uri) {
  for (const t of [...threads]) {
    if (uri && t.uri.toString() !== uri.toString()) continue;
    threads.delete(t);
    t.dispose();
  }
}

function activate(context) {
  icon = vscode.Uri.joinPath(context.extensionUri, 'media', 'ai-dark.svg');
  controller = vscode.comments.createCommentController('texAIReview', 'AI Review');
  context.subscriptions.push(
    controller,
    vscode.commands.registerCommand('texPreview.ai.review', (opts) => {
      const ed = vscode.window.activeTextEditor;
      if (ed && isTex(ed.document)) return reviewCommand(ed, opts && typeof opts === 'object' ? opts : {});
      vscode.window.showInformationMessage('AI: open a .tex file first.');
    }),
    vscode.commands.registerCommand('texPreview.ai.applySuggestion', apply),
    vscode.commands.registerCommand('texPreview.ai.keepComment', keep),
    vscode.commands.registerCommand('texPreview.ai.discardComment', (t) => t && drop(t)),
    vscode.commands.registerCommand('texPreview.ai.clearReview', () => clear(vscode.window.activeTextEditor?.document.uri)),
    { dispose: () => clear() }
  );
}

module.exports = { activate, locate, parse, _threads: () => threads };
