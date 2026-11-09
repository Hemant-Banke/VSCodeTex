'use strict';

// A one-time "rate this extension" request, only after real use: enough successful builds over a
// few days. "Later" asks once more much later; "Rate" or "Don't Ask Again" never asks again.

const vscode = require('vscode');

const ID = 'HemantBanke.tex-side-preview';
const KEY = 'texPreview.rating';
const FIRST_ASK = { builds: 20, days: 3 };
const SECOND_ASK = { builds: 60, days: 21 }; // after "Later"
const DAY = 86400000;

let ctx;
let askedThisSession = false;

function activate(context) {
  ctx = context;
  if (!state().firstUse) save({ firstUse: Date.now() });
  context.subscriptions.push(vscode.commands.registerCommand('texPreview.rate', () => openRating()));
}

function state() {
  return ctx ? ctx.globalState.get(KEY, {}) : {};
}

function save(patch) {
  return ctx.globalState.update(KEY, { ...state(), ...patch });
}

/** Marketplace in VS Code; Open VSX in editors that install from it (Cursor, VSCodium, Windsurf…). */
function ratingUrl() {
  const marketplace = /visual studio code/i.test(vscode.env.appName || '');
  return marketplace
    ? `https://marketplace.visualstudio.com/items?itemName=${ID}&ssr=false#review-details`
    : `https://open-vsx.org/extension/${ID.replace('.', '/')}/reviews`;
}

function openRating() {
  save({ done: true });
  return vscode.env.openExternal(vscode.Uri.parse(ratingUrl()));
}

/** Call after each successful build. */
function builtOk() {
  if (!ctx) return;
  const s = state();
  if (s.done) return;
  const builds = (s.builds || 0) + 1;
  save({ builds });
  if (askedThisSession) return;
  const bar = s.laterAt ? SECOND_ASK : FIRST_ASK;
  const since = s.laterAt || s.firstUse || Date.now();
  const sinceBuilds = builds - (s.laterBuilds || 0);
  if (sinceBuilds < bar.builds || Date.now() - since < bar.days * DAY) return;
  askedThisSession = true;
  ask(builds);
}

async function ask(builds) {
  const pick = await vscode.window.showInformationMessage(
    `You've built ${builds} PDFs with TeX Side Preview. If it's useful, a quick rating helps other LaTeX writers find it.`,
    'Rate It',
    'Later',
    "Don't Ask Again"
  );
  if (pick === 'Rate It') return openRating();
  if (pick === "Don't Ask Again") return save({ done: true });
  // "Later" or dismissed: one more ask, much later; after that, never.
  if (state().laterAt) return save({ done: true });
  return save({ laterAt: Date.now(), laterBuilds: builds });
}

module.exports = { activate, builtOk, ratingUrl };
