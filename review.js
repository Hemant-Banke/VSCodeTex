'use strict';

// Comments and tracked changes for LaTeX files, without touching the LaTeX.
//
// Review data lives in `.texreview/` at the workspace root, one append-only log per person
// (`<name>-<hash>.jsonl`). Because nobody writes anyone else's file, logs never conflict when
// they travel through Git or the Overleaf sync; everyone's view is all logs replayed in time order.
//
// Comments and changes are anchored by the text they cover plus a little context on each side,
// not by line numbers, so they stay attached while collaborators edit elsewhere.
//
// Tracked changes follow Overleaf's model: the file always holds the proposed text. Insertions
// are highlighted; deleted text is shown as struck-through ghost text. Accept keeps the text,
// Reject puts the original back.

const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { exec, which } = require('./tools');

const DIR = '.texreview';
const CTX = 40; // characters of context stored on each side of an anchor
const isTex = (doc) => doc && doc.uri.scheme === 'file' && (doc.languageId === 'latex' || doc.languageId === 'tex');

let context;
let onLogWritten = () => {};
let me = null; // { name, email, key }
const stores = new Map(); // workspace root -> Store
const docs = new Map(); // document uri string -> DocState
let controller;
let statusItem;
let insertDeco;
let deleteDeco;

// ---------------------------------------------------------------------------
// Identity

async function identity(cwd) {
  const cfgName = vscode.workspace.getConfiguration('texPreview.review').get('author') || '';
  if (me && me.setting === cfgName) return me;
  let name = cfgName || '';
  let email = '';
  const git = which('git');
  if (git) {
    if (!name) name = (await exec(git, ['config', 'user.name'], { cwd })).stdout.trim();
    email = (await exec(git, ['config', 'user.email'], { cwd })).stdout.trim();
  }
  if (!name) name = os.userInfo().username;
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'me';
  const hash = crypto.createHash('sha1').update(email || name).digest('hex').slice(0, 6);
  me = { name, email, key: `${slug}-${hash}`, setting: cfgName };
  return me;
}

const newId = () => crypto.randomBytes(6).toString('base64url');

// ---------------------------------------------------------------------------
// Anchors: find text again after the document has changed

function lineOffset(text, line) {
  let off = 0;
  for (let i = 0; i < line && off >= 0; i++) off = text.indexOf('\n', off) + 1 || -1;
  return off < 0 ? text.length : off;
}

function makeAnchor(text, start, end) {
  return {
    prefix: text.slice(Math.max(0, start - CTX), start),
    quote: text.slice(start, end),
    suffix: text.slice(end, end + CTX),
    line: text.slice(0, start).split('\n').length - 1,
  };
}

/** Length of the common run at the end of a and the start of b's mirror (context similarity). */
function commonSuffix(a, b) {
  let n = 0;
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
  return n;
}
function commonPrefix(a, b) {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n;
}

/** Start offset of the anchor in `text`, or -1. Prefers exact context, then the best partial match nearest the old line. */
function locate(text, anchor) {
  const { prefix = '', quote = '', suffix = '', line = 0 } = anchor;
  const near = lineOffset(text, line);
  const all = (needle, limit = 200) => {
    const out = [];
    if (!needle) return out;
    for (let i = text.indexOf(needle); i >= 0 && out.length < limit; i = text.indexOf(needle, i + 1)) out.push(i);
    return out;
  };
  const closest = (list) => list.sort((x, y) => Math.abs(x - near) - Math.abs(y - near))[0];

  const exact = all(prefix + quote + suffix);
  if (exact.length) return closest(exact) + prefix.length;

  if (quote.length >= 2) {
    let best = -1;
    let bestScore = -1;
    const occurrences = all(quote);
    for (const i of occurrences) {
      const score = commonSuffix(text.slice(Math.max(0, i - CTX), i), prefix) + commonPrefix(text.slice(i + quote.length, i + quote.length + CTX), suffix);
      const tie = bestScore === score && Math.abs(i - near) < Math.abs(best - near);
      if (score > bestScore || tie) {
        best = i;
        bestScore = score;
      }
    }
    // Without enough matching context this could be some other occurrence of the same words;
    // better to report the anchor as lost than to attach it to the wrong place.
    if (best >= 0 && (bestScore >= 10 || (occurrences.length === 1 && quote.length >= 8))) return best;
    return -1;
  }

  // Empty quote (a pure deletion): the junction of the surrounding text.
  const left = prefix.slice(-16);
  const right = suffix.slice(0, 16);
  if (!left && !right) return -1;
  const j = all(left + right);
  return j.length ? closest(j) + left.length : -1;
}

// ---------------------------------------------------------------------------
// The log of review events for one workspace root

class Store {
  constructor(root) {
    this.root = root;
    this.dir = path.join(root, DIR);
    this.threads = new Map();
    this.changes = new Map();
    this.seq = 0;
    this.load();
  }

  rel(file) {
    return path.relative(this.root, file).split(path.sep).join('/');
  }

  load() {
    const events = [];
    let files = [];
    try {
      files = fs.readdirSync(this.dir).filter((f) => f.endsWith('.jsonl'));
    } catch {
      /* no review data yet */
    }
    for (const f of files) {
      for (const line of fs.readFileSync(path.join(this.dir, f), 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          events.push(JSON.parse(line));
        } catch {
          /* a half-written or merged line; skip it */
        }
      }
    }
    events.sort((a, b) => a.t - b.t || String(a.by).localeCompare(String(b.by)) || (a.n || 0) - (b.n || 0));

    const threads = new Map();
    const changes = new Map();
    const findComment = (id) => {
      for (const th of threads.values()) {
        const c = th.comments.find((x) => x.id === id);
        if (c) return { th, c };
      }
      return null;
    };
    for (const ev of events) {
      switch (ev.type) {
        case 'comment':
          threads.set(ev.id, { id: ev.id, file: ev.file, anchor: ev.anchor, resolved: false, comments: [{ id: ev.cid || ev.id, by: ev.by, author: ev.author, body: ev.body, t: ev.t }] });
          break;
        case 'reply': {
          const th = threads.get(ev.thread);
          if (th) th.comments.push({ id: ev.id, by: ev.by, author: ev.author, body: ev.body, t: ev.t });
          break;
        }
        case 'edit': {
          const hit = findComment(ev.target);
          if (hit) {
            hit.c.body = ev.body;
            hit.c.edited = ev.t;
          }
          break;
        }
        case 'delete-comment': {
          const hit = findComment(ev.target);
          if (hit) {
            hit.th.comments = hit.th.comments.filter((c) => c !== hit.c);
            if (!hit.th.comments.length) threads.delete(hit.th.id);
          }
          break;
        }
        case 'resolve':
        case 'reopen': {
          const th = threads.get(ev.thread);
          if (th) th.resolved = ev.type === 'resolve';
          break;
        }
        case 'anchor': {
          const th = threads.get(ev.thread);
          if (th) th.anchor = ev.anchor;
          break;
        }
        case 'delete-thread':
          threads.delete(ev.thread);
          break;
        case 'change':
          if (ev.removed) changes.delete(ev.id);
          else changes.set(ev.id, { id: ev.id, file: ev.file, author: ev.author, owner: ev.owner || ev.by, by: ev.by, t: ev.t, created: changes.get(ev.id)?.created || ev.t, kind: ev.kind, text: ev.text, old: ev.old, anchor: ev.anchor });
          break;
      }
    }
    this.threads = threads;
    this.changes = changes;
  }

  /** Appends events to this person's log, then lets the Overleaf sync pick it up. */
  append(events) {
    if (!events.length) return;
    fs.mkdirSync(this.dir, { recursive: true });
    const file = path.join(this.dir, `${me.key}.jsonl`);
    const t = Date.now();
    const lines = events.map((e) => JSON.stringify({ t, n: this.seq++, by: me.key, ...e })).join('\n') + '\n';
    fs.appendFileSync(file, lines);
    this.load();
    onLogWritten([vscode.Uri.file(file)]);
  }
}

function storeFor(uri) {
  const ws = vscode.workspace.getWorkspaceFolder(uri);
  const root = ws ? ws.uri.fsPath : path.dirname(uri.fsPath);
  let store = stores.get(root);
  if (!store) stores.set(root, (store = new Store(root)));
  return store;
}

// ---------------------------------------------------------------------------
// Tracked changes in an open document

/** Live positions of the changes in one document, updated edit by edit. */
class DocState {
  constructor(doc) {
    this.doc = doc;
    this.store = storeFor(doc.uri);
    this.rel = this.store.rel(doc.uri.fsPath);
    this.text = doc.getText();
    this.suppress = 0;
    this.touched = new Set(); // change ids to write on the next flush
    this.removed = new Set();
    this.resolve();
  }

  /** Places the stored changes for this file in the current text. */
  resolve() {
    this.changes = [];
    this.missing = [];
    for (const c of this.store.changes.values()) {
      if (c.file !== this.rel) continue;
      const s = locate(this.text, { ...c.anchor, quote: c.text });
      if (s < 0) this.missing.push(c);
      else this.changes.push({ id: c.id, author: c.author, owner: c.owner, by: c.by, t: c.t, created: c.created, s, e: s + c.text.length, old: c.old });
    }
    this.changes.sort((a, b) => a.s - b.s);
  }

  /**
   * Applies one edit (offset `a`, `len` characters replaced by `ins`) to the change list.
   * Tracked edits become (or extend) the current author's change; untracked ones only move
   * or trim existing changes.
   */
  apply(a, len, ins, tracked) {
    const T = this.text;
    const b = a + len;
    const delta = ins.length - len;
    const next = [];
    let mine = [];

    if (tracked) {
      mine = this.changes.filter((c) => c.owner === me.key && c.s <= b && c.e >= a);
      const lo = Math.min(a, ...mine.map((c) => c.s));
      const hi = Math.max(b, ...mine.map((c) => c.e));
      // Never merge across someone else's inserted text that this edit doesn't delete.
      const across = this.changes.some((c) => c.owner !== me.key && c.e > c.s && c.s < hi && c.e > lo && (c.s < a || c.e > b));
      if (across) mine = [];
    }
    const mineSet = new Set(mine);

    for (const c of this.changes) {
      if (mineSet.has(c)) continue;
      if (c.e <= a && !(c.e === a && c.s === a && len > 0)) {
        next.push(c); // entirely before the edit
      } else if (c.s >= b) {
        next.push({ ...c, s: c.s + delta, e: c.e + delta }); // entirely after
      } else {
        // Overlaps the edit: keep what survives of its inserted text, on each side.
        const left = Math.max(0, Math.min(c.e, a) - c.s);
        const right = Math.max(0, c.e - Math.max(c.s, b));
        this.touched.add(c.id);
        if (!ins || (left === 0 && !c.old)) {
          // Nothing new lands inside it: it just loses the deleted characters.
          const s = c.s <= a ? c.s : a + ins.length;
          if (left + right || c.old) next.push({ ...c, s, e: s + left + right });
          else this.removed.add(c.id);
          continue;
        }
        if (left || c.old) next.push({ ...c, s: c.s, e: c.s + left });
        if (right) {
          const s = a + ins.length;
          const part = { ...c, id: left || c.old ? newId() : c.id, old: left || c.old ? '' : c.old, s, e: s + right };
          this.touched.add(part.id);
          next.push(part);
        }
        if (!left && !right && !c.old) this.removed.add(c.id);
      }
    }

    if (tracked && (len || ins)) {
      // Walk the merged region: my earlier insertions survive unless deleted now; original
      // text deleted now joins the change's "old" text, in document order.
      const lo = Math.min(a, ...mine.map((c) => c.s));
      const hi = Math.max(b, ...mine.map((c) => c.e));
      let text = '';
      let old = '';
      const starts = new Map(mine.map((c) => [c.s, c]));
      for (let x = lo; x <= hi; x++) {
        const at = starts.get(x);
        if (at) old += at.old;
        if (x === a) text += ins;
        if (x === hi) break;
        const own = mine.find((c) => x >= c.s && x < c.e);
        const theirs = !own && this.changes.some((c) => c.owner !== me.key && x >= c.s && x < c.e);
        const deleted = x >= a && x < b;
        if (own && !deleted) text += T[x];
        else if (!own && !theirs && deleted) old += T[x]; // original text: becomes a deletion
        // (someone else's inserted text that is deleted now is simply gone, as on Overleaf)
      }
      const keep = mine[0];
      for (const c of mine.slice(1)) this.removed.add(c.id);
      if (text === old) {
        if (keep) this.removed.add(keep.id);
      } else {
        const c = { id: keep ? keep.id : newId(), author: me.name, owner: me.key, by: me.key, t: Date.now(), created: keep ? keep.created : Date.now(), s: lo, e: lo + text.length, old };
        this.touched.add(c.id);
        this.removed.delete(c.id);
        next.push(c);
      }
    } else {
      for (const c of mine) next.push(c);
    }

    this.text = T.slice(0, a) + ins + T.slice(b);
    this.changes = next.filter((c) => c.e > c.s || c.old).sort((x, y) => x.s - y.s);
    for (const c of this.changes) this.removed.delete(c.id);
  }

  /** Writes changed and removed changes to the log. */
  flush() {
    const events = [];
    for (const id of this.removed) events.push({ type: 'change', id, file: this.rel, removed: true, why: 'edited' });
    for (const id of this.touched) {
      const c = this.changes.find((x) => x.id === id);
      if (!c || this.removed.has(id)) continue;
      const anchor = makeAnchor(this.text, c.s, c.e);
      events.push({ type: 'change', id, file: this.rel, author: c.author, owner: c.owner, kind: c.old ? (c.e > c.s ? 'replace' : 'delete') : 'insert', text: anchor.quote, old: c.old, anchor: { prefix: anchor.prefix, suffix: anchor.suffix, line: anchor.line } });
    }
    this.touched.clear();
    this.removed.clear();
    if (events.length) this.store.append(events);
  }

  rangeOf(c) {
    return new vscode.Range(this.doc.positionAt(c.s), this.doc.positionAt(c.e));
  }

  changeAt(pos) {
    const off = this.doc.offsetAt(pos);
    return this.changes.find((c) => (off >= c.s && off <= c.e) || (c.s === c.e && Math.abs(off - c.s) <= 1));
  }
}

function stateFor(doc) {
  if (!isTex(doc)) return null;
  const key = doc.uri.toString();
  let st = docs.get(key);
  if (!st || st.doc !== doc) docs.set(key, (st = new DocState(doc)));
  return st;
}

function tracking() {
  return context.workspaceState.get('texPreview.review.tracking', false);
}

let flushTimer;
function scheduleFlush() {
  clearTimeout(flushTimer);
  flushTimer = setTimeout(flushAll, 1200);
}
function flushAll() {
  clearTimeout(flushTimer);
  for (const st of docs.values()) if (st.touched.size || st.removed.size) st.flush();
}

function sameAsDisk(doc) {
  try {
    return fs.readFileSync(doc.uri.fsPath, 'utf8') === doc.getText();
  } catch {
    return false;
  }
}

function onChange(e) {
  const st = docs.get(e.document.uri.toString());
  if (!st || !e.contentChanges.length) return;
  // A reload from disk (a pull from Overleaf, a checkout) is not an edit by this person:
  // re-place everything from the logs instead of recording it.
  // (VS Code still reports the first edit after a save as "not dirty", so compare with the disk.)
  if (!e.document.isDirty && !st.suppress && sameAsDisk(e.document)) {
    st.flush();
    st.text = e.document.getText();
    reloadSoon();
    return;
  }
  const tracked = tracking() && !st.suppress;
  for (const ch of [...e.contentChanges].sort((x, y) => y.rangeOffset - x.rangeOffset)) {
    st.apply(ch.rangeOffset, ch.rangeLength, ch.text, tracked);
  }
  if (st.text !== e.document.getText()) {
    st.text = e.document.getText(); // out of step (should not happen): re-place from scratch
    st.resolve();
  }
  if (st.touched.size || st.removed.size) scheduleFlush();
  decorate();
}

// ---------------------------------------------------------------------------
// Accept / reject

async function accept(ids, st) {
  st = st || docs.get(vscode.window.activeTextEditor?.document.uri.toString());
  if (!st) return;
  flushAll();
  const list = ids.map((id) => st.changes.find((c) => c.id === id)).filter(Boolean);
  st.changes = st.changes.filter((c) => !list.includes(c));
  st.store.append(list.map((c) => ({ type: 'change', id: c.id, file: st.rel, removed: true, why: 'accepted' })));
  decorate();
}

async function reject(ids, st) {
  st = st || docs.get(vscode.window.activeTextEditor?.document.uri.toString());
  if (!st) return;
  flushAll();
  const list = ids.map((id) => st.changes.find((c) => c.id === id)).filter(Boolean);
  if (!list.length) return;
  const edit = new vscode.WorkspaceEdit();
  for (const c of list) edit.replace(st.doc.uri, st.rangeOf(c), c.old);
  st.suppress++;
  try {
    await vscode.workspace.applyEdit(edit);
  } finally {
    st.suppress--;
  }
  // The reverted text is no longer a change.
  const gone = new Set(list.map((c) => c.id));
  st.changes = st.changes.filter((c) => !gone.has(c.id));
  for (const id of gone) {
    st.touched.delete(id);
    st.removed.delete(id);
  }
  st.store.append(list.map((c) => ({ type: 'change', id: c.id, file: st.rel, removed: true, why: 'rejected' })));
  await st.doc.save();
  decorate();
}

function activeState() {
  const ed = vscode.window.activeTextEditor;
  return ed ? stateFor(ed.document) : null;
}

function changeIdsAtCursor() {
  const ed = vscode.window.activeTextEditor;
  const st = ed && stateFor(ed.document);
  if (!st) return [];
  return [...new Set(ed.selections.flatMap((sel) => st.changes.filter((c) => (sel.isEmpty ? st.changeAt(sel.active) === c : c.s < st.doc.offsetAt(sel.end) && c.e > st.doc.offsetAt(sel.start))).map((c) => c.id)))];
}

function goToChange(dir) {
  const ed = vscode.window.activeTextEditor;
  const st = ed && stateFor(ed.document);
  if (!st || !st.changes.length) {
    vscode.window.setStatusBarMessage('No tracked changes in this file', 2000);
    return;
  }
  const off = st.doc.offsetAt(ed.selection.active);
  const sorted = [...st.changes].sort((x, y) => x.s - y.s);
  const c = dir > 0 ? sorted.find((x) => x.s > off) || sorted[0] : [...sorted].reverse().find((x) => x.s < off) || sorted[sorted.length - 1];
  const r = st.rangeOf(c);
  ed.selection = new vscode.Selection(r.start, r.end);
  ed.revealRange(r, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
}

// ---------------------------------------------------------------------------
// Decorations and hovers

const when = (t) => {
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(t).toLocaleDateString();
};
const oneLine = (s, n = 60) => {
  const t = s.replace(/\n/g, '⏎');
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
};

function decorate() {
  for (const ed of vscode.window.visibleTextEditors) {
    const st = isTex(ed.document) ? stateFor(ed.document) : null;
    if (!st) continue;
    const ins = [];
    const del = [];
    for (const c of st.changes) {
      const r = st.rangeOf(c);
      if (c.e > c.s) ins.push({ range: r });
      if (c.old) {
        del.push({ range: new vscode.Range(r.start, r.start), renderOptions: { before: { contentText: oneLine(c.old) } } });
      }
    }
    ed.setDecorations(insertDeco, ins);
    ed.setDecorations(deleteDeco, del);
  }
  renderStatus();
}

class ChangeHover {
  provideHover(doc, pos) {
    const st = stateFor(doc);
    const c = st && st.changeAt(pos);
    if (!c) return null;
    const arg = (cmd) => `command:${cmd}?${encodeURIComponent(JSON.stringify([[c.id]]))}`;
    const what = c.old && c.e > c.s ? 'replaced' : c.old ? 'deleted' : 'inserted';
    const md = new vscode.MarkdownString(
      `**${c.author}** ${what} · ${when(c.t)}` +
        (c.old ? `\n\nwas: ~~${oneLine(c.old, 200).replace(/[\\`*_~[\]]/g, '\\$&')}~~` : '') +
        `\n\n[$(check) Accept](${arg('texPreview.review.accept')}) &nbsp; [$(discard) Reject](${arg('texPreview.review.reject')})`
    );
    md.supportThemeIcons = true;
    md.isTrusted = { enabledCommands: ['texPreview.review.accept', 'texPreview.review.reject'] };
    return new vscode.Hover(md, st.rangeOf(c));
  }
}

class ChangeActions {
  provideCodeActions(doc, range) {
    const st = stateFor(doc);
    if (!st || !st.changes.length) return [];
    const hit = st.changes.filter((c) => c.s <= doc.offsetAt(range.end) && c.e >= doc.offsetAt(range.start));
    const act = (title, command, ids) => {
      const a = new vscode.CodeAction(title, vscode.CodeActionKind.QuickFix);
      a.command = { title, command, arguments: [ids] };
      return a;
    };
    const out = [];
    if (hit.length) {
      out.push(act(hit.length > 1 ? `Accept ${hit.length} changes` : 'Accept change', 'texPreview.review.accept', hit.map((c) => c.id)));
      out.push(act(hit.length > 1 ? `Reject ${hit.length} changes` : 'Reject change', 'texPreview.review.reject', hit.map((c) => c.id)));
    }
    out.push(act('Accept all changes in this file', 'texPreview.review.acceptAll'));
    out.push(act('Reject all changes in this file', 'texPreview.review.rejectAll'));
    return out;
  }
}

/** For the right-click menu: is there a tracked change under the cursor/selection, or in the file? */
function contextInfo(ed) {
  const st = ed && isTex(ed.document) ? stateFor(ed.document) : null;
  if (!st) return { onChange: false, hasChanges: false };
  return { onChange: changeIdsAtCursor().length > 0, hasChanges: st.changes.length > 0 };
}

function renderStatus() {
  vscode.commands.executeCommand('setContext', 'texPreview.tracking', tracking());
  const ed = vscode.window.activeTextEditor;
  if (!ed || !isTex(ed.document)) {
    statusItem.hide();
    return;
  }
  const st = stateFor(ed.document);
  const n = st ? st.changes.length : 0;
  const threads = st ? [...st.store.threads.values()].filter((t) => t.file === st.rel && !t.resolved).length : 0;
  const on = tracking();
  statusItem.text = `${on ? '$(record)' : '$(git-compare)'} ${on ? 'Tracking' : 'Review'}${n || threads ? ` ${[n && `${n} change${n === 1 ? '' : 's'}`, threads && `${threads} comment${threads === 1 ? '' : 's'}`].filter(Boolean).join(', ')}` : ''}`;
  statusItem.tooltip = `${on ? 'Track changes is ON: your edits are recorded as suggestions.' : 'Track changes is off.'}\nClick for review actions.`;
  statusItem.backgroundColor = on ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
  statusItem.show();
}

async function showMenu() {
  const st = activeState();
  const items = [
    { label: tracking() ? '$(circle-slash) Stop Tracking Changes' : '$(record) Track Changes', command: 'texPreview.review.toggleTracking' },
    { label: '$(comment) Add Comment', description: 'on the selection', command: 'texPreview.review.addComment' },
    { label: '$(comment-discussion) Show All Comments', command: 'texPreview.review.showComments' },
  ];
  if (st && st.changes.length) {
    items.push(
      { label: '', kind: vscode.QuickPickItemKind.Separator },
      { label: '$(check-all) Accept All Changes', description: `${st.changes.length} in this file`, command: 'texPreview.review.acceptAll' },
      { label: '$(discard) Reject All Changes', command: 'texPreview.review.rejectAll' },
      { label: 'Changes', kind: vscode.QuickPickItemKind.Separator },
      ...st.changes.map((c) => {
        const ins = st.text.slice(c.s, c.e);
        return {
          label: `${c.old && ins ? '$(replace)' : c.old ? '$(remove)' : '$(add)'} ${oneLine(ins || c.old, 50)}`,
          description: `${c.author} · ${when(c.t)}`,
          detail: c.old && ins ? `was: ${oneLine(c.old, 80)}` : undefined,
          change: c,
        };
      })
    );
  }
  if (st && st.missing.length) items.push({ label: `$(warning) ${st.missing.length} change${st.missing.length === 1 ? '' : 's'} whose text could not be found`, description: 'the surrounding text was edited' });
  const picked = await vscode.window.showQuickPick(items, { title: 'Review' });
  if (!picked) return;
  if (picked.command) vscode.commands.executeCommand(picked.command);
  else if (picked.change) {
    const ed = vscode.window.activeTextEditor;
    const r = st.rangeOf(picked.change);
    ed.selection = new vscode.Selection(r.start, r.end);
    ed.revealRange(r, vscode.TextEditorRevealType.InCenter);
  }
}

// ---------------------------------------------------------------------------
// Comments (VS Code's comment threads)

class ReviewComment {
  constructor(c, thread) {
    this.id = c.id;
    this.by = c.by;
    this.thread = thread;
    this.savedBody = c.body;
    this.body = new vscode.MarkdownString(c.body);
    this.mode = vscode.CommentMode.Preview;
    this.author = { name: c.author };
    this.timestamp = new Date(c.t);
    this.label = c.edited ? 'edited' : undefined;
    this.contextValue = me && c.by === me.key ? 'mine' : 'theirs';
  }
}

const vsThreads = new Map(); // review thread id -> vscode.CommentThread

function threadLabel(th) {
  // VS Code shows thread titles HTML-escaped, so keep <, > and & out of them.
  const q = th.anchor.quote.replace(/\s+/g, ' ').trim().replace(/</g, '‹').replace(/>/g, '›').replace(/&/g, '＆');
  return q ? `“${q.length > 48 ? q.slice(0, 47) + '…' : q}”` : 'Comment';
}

function textOf(store, rel) {
  const file = path.join(store.root, rel);
  const open = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === file);
  if (open) return { text: open.getText(), doc: open };
  try {
    return { text: fs.readFileSync(file, 'utf8') };
  } catch {
    return null;
  }
}

function rangeIn(text, s, e) {
  const pos = (off) => {
    const before = text.slice(0, off);
    const line = before.split('\n').length - 1;
    return new vscode.Position(line, off - (before.lastIndexOf('\n') + 1));
  };
  return new vscode.Range(pos(s), pos(e));
}

/** Creates, updates or removes VS Code comment threads to match the stores. */
function syncThreads(relocate = false) {
  const seen = new Set();
  for (const store of stores.values()) {
    for (const th of store.threads.values()) {
      seen.add(th.id);
      const src = textOf(store, th.file);
      if (!src) continue;
      let vt = vsThreads.get(th.id);
      if (!vt || relocate) {
        const s = locate(src.text, th.anchor);
        const range = s >= 0 ? rangeIn(src.text, s, s + th.anchor.quote.length) : rangeIn(src.text, lineOffset(src.text, th.anchor.line), lineOffset(src.text, th.anchor.line));
        if (!vt) {
          vt = controller.createCommentThread(vscode.Uri.file(path.join(store.root, th.file)), range, []);
          vt.reviewId = th.id;
          vt.store = store;
          vsThreads.set(th.id, vt);
        } else {
          vt.range = range;
        }
        vt.orphan = s < 0;
      }
      const editing = vt.comments.filter((c) => c.mode === vscode.CommentMode.Editing).map((c) => c.id);
      vt.comments = th.comments.map((c) => {
        const rc = new ReviewComment(c, vt);
        if (editing.includes(rc.id)) {
          rc.mode = vscode.CommentMode.Editing;
          rc.body = vt.comments.find((x) => x.id === rc.id).body;
        }
        return rc;
      });
      vt.label = threadLabel(th) + (vt.orphan ? ' (text changed)' : '');
      vt.state = th.resolved ? vscode.CommentThreadState.Resolved : vscode.CommentThreadState.Unresolved;
      vt.contextValue = th.resolved ? 'resolved' : 'open';
      vt.canReply = true;
    }
  }
  for (const [id, vt] of vsThreads) {
    if (!seen.has(id)) {
      vt.dispose();
      vsThreads.delete(id);
    }
  }
}

function anchorForThread(thread) {
  const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === thread.uri.toString());
  const text = doc ? doc.getText() : fs.readFileSync(thread.uri.fsPath, 'utf8');
  let range = thread.range;
  const offsetAt = (p) => (doc ? doc.offsetAt(p) : lineOffset(text, p.line) + p.character);
  let s = offsetAt(range.start);
  let e = offsetAt(range.end);
  // A whole-line comment (from the gutter "+"): anchor to the line's text.
  if (e <= s || (range.start.character === 0 && range.end.character === 0)) {
    const ls = lineOffset(text, range.start.line);
    let le = text.indexOf('\n', ls);
    if (le < 0) le = text.length;
    s = ls + (text.slice(ls, le).length - text.slice(ls, le).trimStart().length);
    e = le;
    while (e > s && /\s/.test(text[e - 1])) e--;
  }
  return makeAnchor(text, s, e);
}

async function createComment(reply) {
  const thread = reply.thread;
  await identity(path.dirname(thread.uri.fsPath));
  const store = storeFor(thread.uri);
  const anchor = anchorForThread(thread);
  const id = newId();
  store.append([{ type: 'comment', id, cid: newId(), file: store.rel(thread.uri.fsPath), anchor, author: me.name, body: reply.text }]);
  // The draft thread VS Code made becomes this comment's thread.
  thread.reviewId = id;
  thread.store = store;
  vsThreads.set(id, thread);
  syncThreads();
  decorate();
}

async function replyComment(reply) {
  const vt = reply.thread;
  if (!vt.reviewId) return createComment(reply);
  await identity(path.dirname(vt.uri.fsPath));
  vt.store.append([{ type: 'reply', id: newId(), thread: vt.reviewId, author: me.name, body: reply.text }]);
  syncThreads();
}

function setThreadState(vt, type) {
  if (!vt || !vt.reviewId) return;
  vt.store.append([{ type, thread: vt.reviewId, author: me.name }]);
  syncThreads();
  renderStatus();
}

function deleteThread(vt) {
  if (!vt) return;
  if (!vt.reviewId) {
    vt.dispose(); // an empty draft
    return;
  }
  vt.store.append([{ type: 'delete-thread', thread: vt.reviewId, author: me.name }]);
  syncThreads();
  renderStatus();
}

function editComment(c) {
  c.thread.comments = c.thread.comments.map((x) => {
    if (x.id === c.id) x.mode = vscode.CommentMode.Editing;
    return x;
  });
}

function saveComment(c) {
  const body = typeof c.body === 'string' ? c.body : c.body.value;
  c.thread.store.append([{ type: 'edit', target: c.id, body, author: me.name }]);
  syncThreads();
}

function cancelEdit(c) {
  c.thread.comments = c.thread.comments.map((x) => {
    if (x.id === c.id) {
      x.mode = vscode.CommentMode.Preview;
      x.body = new vscode.MarkdownString(x.savedBody);
    }
    return x;
  });
}

function deleteComment(c) {
  c.thread.store.append([{ type: 'delete-comment', target: c.id, author: me.name }]);
  syncThreads();
  renderStatus();
}

/** Keeps comment anchors fresh: if a commented passage was edited, record where it is now. */
function reanchor(doc) {
  const events = new Map();
  for (const vt of vsThreads.values()) {
    if (!vt.reviewId || vt.uri.toString() !== doc.uri.toString()) continue;
    const th = vt.store.threads.get(vt.reviewId);
    if (!th) continue;
    const quote = doc.getText(vt.range);
    if (quote && quote !== th.anchor.quote) {
      const a = makeAnchor(doc.getText(), doc.offsetAt(vt.range.start), doc.offsetAt(vt.range.end));
      if (!events.has(vt.store)) events.set(vt.store, []);
      events.get(vt.store).push({ type: 'anchor', thread: vt.reviewId, anchor: a, author: me.name });
    }
  }
  for (const [store, ev] of events) store.append(ev);
}

// ---------------------------------------------------------------------------
// Reloading when logs change (pulled from Overleaf, or written by another window)

let reloadTimer;
function reloadSoon() {
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(reloadAll, 300);
}

function reloadAll() {
  flushAll();
  for (const store of stores.values()) store.load();
  for (const st of docs.values()) {
    st.text = st.doc.getText();
    st.resolve();
  }
  syncThreads(true);
  decorate();
}

// ---------------------------------------------------------------------------

async function activate(ctx, opts = {}) {
  context = ctx;
  onLogWritten = opts.onLogWritten || onLogWritten;
  await identity(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath);
  insertDeco = vscode.window.createTextEditorDecorationType({
    backgroundColor: 'rgba(46, 160, 67, 0.18)',
    borderColor: 'rgba(46, 160, 67, 0.75)',
    borderStyle: 'none none solid none',
    borderWidth: '0 0 1.5px 0',
    overviewRulerColor: 'rgba(46, 160, 67, 0.9)',
    overviewRulerLane: vscode.OverviewRulerLane.Left,
  });
  deleteDeco = vscode.window.createTextEditorDecorationType({
    before: { color: 'rgba(248, 81, 73, 0.95)', backgroundColor: 'rgba(248, 81, 73, 0.12)', textDecoration: 'line-through', margin: '0 1px 0 0' },
    overviewRulerColor: 'rgba(248, 81, 73, 0.9)',
    overviewRulerLane: vscode.OverviewRulerLane.Left,
  });
  statusItem = vscode.window.createStatusBarItem('texPreview.review', vscode.StatusBarAlignment.Right, 109);
  statusItem.name = 'LaTeX Review';
  statusItem.command = 'texPreview.review.menu';

  controller = vscode.comments.createCommentController('texReview', 'LaTeX Review');
  controller.options = { prompt: 'Comment…', placeHolder: 'Add a comment (Markdown); collaborators see it after the next sync' };
  controller.commentingRangeProvider = {
    provideCommentingRanges: (doc) => (isTex(doc) ? [new vscode.Range(0, 0, Math.max(0, doc.lineCount - 1), 0)] : []),
  };

  const reg = (id, fn) => ctx.subscriptions.push(vscode.commands.registerCommand(id, fn));
  reg('texPreview.review.toggleTracking', async () => {
    const ed = vscode.window.activeTextEditor;
    await identity(ed ? path.dirname(ed.document.uri.fsPath) : undefined);
    await ctx.workspaceState.update('texPreview.review.tracking', !tracking());
    flushAll();
    renderStatus();
    vscode.window.setStatusBarMessage(tracking() ? `Track changes on: edits are recorded as suggestions by ${me.name}` : 'Track changes off', 3000);
  });
  reg('texPreview.review.accept', (ids) => accept(Array.isArray(ids) ? ids : changeIdsAtCursor()));
  reg('texPreview.review.reject', (ids) => reject(Array.isArray(ids) ? ids : changeIdsAtCursor()));
  reg('texPreview.review.acceptAll', () => {
    const st = activeState();
    return st ? accept(st.changes.map((c) => c.id), st) : undefined;
  });
  reg('texPreview.review.rejectAll', () => {
    const st = activeState();
    return st ? reject(st.changes.map((c) => c.id), st) : undefined;
  });
  reg('texPreview.review.nextChange', () => goToChange(1));
  reg('texPreview.review.previousChange', () => goToChange(-1));
  reg('texPreview.review.menu', showMenu);
  reg('texPreview.review.showComments', () => vscode.commands.executeCommand('workbench.panel.comments'));
  reg('texPreview.review.addComment', () => vscode.commands.executeCommand('workbench.action.addComment'));
  reg('texPreview.review.createComment', createComment);
  reg('texPreview.review.reply', replyComment);
  reg('texPreview.review.resolve', (vt) => setThreadState(vt, 'resolve'));
  reg('texPreview.review.reopen', (vt) => setThreadState(vt, 'reopen'));
  reg('texPreview.review.deleteThread', deleteThread);
  reg('texPreview.review.editComment', editComment);
  reg('texPreview.review.saveComment', saveComment);
  reg('texPreview.review.cancelEdit', cancelEdit);
  reg('texPreview.review.deleteComment', deleteComment);

  const watcher = vscode.workspace.createFileSystemWatcher(`**/${DIR}/*.jsonl`);
  ctx.subscriptions.push(
    controller,
    statusItem,
    insertDeco,
    deleteDeco,
    watcher,
    watcher.onDidChange(reloadSoon),
    watcher.onDidCreate(reloadSoon),
    watcher.onDidDelete(reloadSoon),
    vscode.languages.registerHoverProvider([{ language: 'latex' }, { language: 'tex' }], new ChangeHover()),
    vscode.languages.registerCodeActionsProvider([{ language: 'latex' }, { language: 'tex' }], new ChangeActions(), { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }),
    vscode.workspace.onDidChangeTextDocument(onChange),
    vscode.workspace.onDidOpenTextDocument((d) => {
      if (stateFor(d)) decorate();
    }),
    vscode.workspace.onDidCloseTextDocument((d) => {
      const st = docs.get(d.uri.toString());
      if (st) {
        st.flush();
        docs.delete(d.uri.toString());
      }
    }),
    vscode.workspace.onDidSaveTextDocument((d) => {
      if (!isTex(d) || !me) return;
      flushAll();
      reanchor(d);
    }),
    vscode.window.onDidChangeVisibleTextEditors(decorate),
    vscode.workspace.onDidChangeConfiguration(async (e) => {
      if (!e.affectsConfiguration('texPreview.review.author')) return;
      flushAll();
      me = null;
      await identity(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath);
      syncThreads();
    }),
    vscode.window.onDidChangeActiveTextEditor(() => renderStatus()),
    { dispose: flushAll }
  );

  for (const ws of vscode.workspace.workspaceFolders || []) storeFor(ws.uri);
  for (const d of vscode.workspace.textDocuments) stateFor(d);
  syncThreads();
  decorate();
}

module.exports = { activate, contextInfo, locate, makeAnchor, DocState, flushAll, _state: () => ({ docs, stores, vsThreads, me: () => me, setMe: (m) => (me = m) }) };
