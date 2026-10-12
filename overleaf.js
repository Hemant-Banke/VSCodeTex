'use strict';

// Two-way Overleaf sync over Overleaf's Git integration (git.overleaf.com, premium feature).
// Saves are committed and pushed; remote changes are fetched on a timer / window focus and
// merged in. The Git auth token lives in VS Code's SecretStorage and is handed to git through
// GIT_CONFIG_* environment variables, so it never lands in .git/config or a process's argv.

const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

const TOKEN_KEY = 'texPreview.overleaf.gitToken';
const OVERLEAF_HOST = 'git.overleaf.com';
const PROJECT_ID = /([0-9a-f]{24})/i;

let ctx;
let output;
let statusItem;
let onFilesChanged = () => {};
/** @type {Map<string, Repo>} keyed by repo top-level path */
const repos = new Map();
let pollTimer;

// ---------------------------------------------------------------------------- git plumbing

class GitError extends Error {
  constructor(args, code, out) {
    super(`git ${args[0]} failed (${code}): ${out.trim().split('\n').slice(-3).join(' ')}`);
    this.out = out;
    this.authFailed = /Authentication failed|HTTP 401|403|could not read (Username|Password)|unable to get password|terminal prompts disabled/i.test(out);
  }
}

function gitEnv(token) {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', LC_ALL: 'C' };
  // Never pop up credential prompts (VS Code's own git askpass included); a failure is reported instead.
  for (const k of Object.keys(env)) if (/^(GIT_ASKPASS|SSH_ASKPASS|VSCODE_GIT_)/.test(k)) delete env[k];
  const cfg = [];
  if (token) {
    const basic = Buffer.from(`git:${token}`).toString('base64');
    cfg.push([`http.https://${OVERLEAF_HOST}/.extraHeader`, `Authorization: Basic ${basic}`]);
    // We supply the credentials; don't let a rejected token fall through to the keychain/GUI helpers.
    cfg.push(['credential.helper', '']);
    cfg.push(['credential.interactive', 'never']);
  }
  cfg.forEach(([k, v], i) => {
    env[`GIT_CONFIG_KEY_${i}`] = k;
    env[`GIT_CONFIG_VALUE_${i}`] = v;
  });
  env.GIT_CONFIG_COUNT = String(cfg.length);
  return env;
}

function git(cwd, args, { token, allowFail = false, log = true, env, timeout = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    if (log) output.appendLine(`[overleaf] git ${args.join(' ')}`);
    const proc = spawn('git', args, { cwd, env: { ...gitEnv(token), ...env } });
    // A stalled network call must not wedge the sync queue.
    let out = '';
    const timer = setTimeout(() => {
      out += `\n(timed out after ${timeout / 1000}s)`;
      proc.kill();
    }, timeout);
    proc.stdout.on('data', (d) => (out += d));
    proc.stderr.on('data', (d) => (out += d));
    proc.on('error', (e) => reject(new GitError(args, -1, e.message)));
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0 && log) output.appendLine(out.trim());
      if (code === 0 || allowFail) resolve({ code, out: out.trim(), raw: out });
      else reject(new GitError(args, code, out));
    });
  });
}

async function getToken(prompt) {
  let token = await ctx.secrets.get(TOKEN_KEY);
  if (!token && prompt) token = await askToken();
  return token;
}

async function askToken(reason) {
  const pick = await vscode.window.showInputBox({
    title: 'Overleaf Git token',
    prompt:
      (reason ? reason + ' ' : '') +
      'Create one at overleaf.com → Account Settings → Git Integration → "Create token". It is stored in VS Code\'s secret storage.',
    password: true,
    ignoreFocusOut: true,
    placeHolder: 'olp_…',
  });
  if (!pick) return undefined;
  await ctx.secrets.store(TOKEN_KEY, pick.trim());
  return pick.trim();
}

function cfg() {
  return vscode.workspace.getConfiguration('texPreview.overleaf');
}

// ---------------------------------------------------------------------------- repo sync

class Repo {
  constructor(root, remote, branch, url) {
    this.root = root;
    this.remote = remote;
    this.branch = branch;
    this.url = url;
    const m = url.match(PROJECT_ID);
    this.projectId = m ? m[1] : null;
    this.chain = Promise.resolve();
    this.state = 'idle'; // idle | syncing | synced | conflict | waiting | error | paused
    this.message = '';
    this.lastSync = null;
    this.pushTimer = null;
  }

  get name() {
    return path.basename(this.root);
  }

  contains(file) {
    const rel = path.relative(this.root, file);
    return rel && !rel.startsWith('..') && !path.isAbsolute(rel) && !rel.split(path.sep).includes('.git');
  }

  /** Serialise every git operation on this repo. */
  enqueue(fn) {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => {});
    return next;
  }

  setState(state, message = '') {
    this.state = state;
    this.message = message;
    if (state === 'synced') this.lastSync = new Date();
    renderStatus();
  }

  schedulePush() {
    clearTimeout(this.pushTimer);
    const delay = Math.max(0, Number(cfg().get('pushDelay')) || 0) * 1000;
    this.pushTimer = setTimeout(() => this.sync('save'), delay);
  }

  sync(reason) {
    return this.enqueue(() => this.doSync(reason, 0));
  }

  async doSync(reason, attempt) {
    if (this.paused) return;
    const token = this.url.includes(OVERLEAF_HOST) ? await getToken(false) : undefined;
    const run = (args, opts = {}) => git(this.root, args, { token, env: this.identity, ...opts });
    const upstream = `${this.remote}/${this.branch}`;
    this.setState('syncing', reason === 'poll' ? 'Checking Overleaf…' : 'Syncing…');

    try {
      // 1. Finish a merge the user has resolved, or keep waiting for them.
      if (fs.existsSync(path.join(this.root, '.git', 'MERGE_HEAD'))) {
        const unmerged = (await run(['diff', '--name-only', '--diff-filter=U'])).out.split('\n').filter(Boolean);
        const stillConflicted = unmerged.filter((f) => hasConflictMarkers(path.join(this.root, f)));
        if (stillConflicted.length) {
          this.setState('conflict', `Resolve conflicts in ${stillConflicted.join(', ')} and save`);
          return;
        }
        await run(['add', '-A']);
        await run(['commit', '--no-edit']);
      }

      // 2. Commit local edits.
      const status = (await run(['status', '--porcelain'], { log: false })).raw;
      if (status.trim()) {
        // Porcelain lines are "XY path" (or "XY old -> new"); the leading status column can be a space.
        const files = status
          .split('\n')
          .filter((l) => l.length > 3)
          .map((l) => path.basename(l.slice(3).replace(/^.* -> /, '').replace(/^"|"$/g, '')));
        const msg = `Update ${files.slice(0, 3).join(', ')}${files.length > 3 ? ` and ${files.length - 3} more` : ''} (from VS Code)`;
        await run(['add', '-A']);
        await run(['commit', '-q', '-m', msg]);
      }

      // 3. Bring in Overleaf's changes.
      await run(['fetch', '-q', this.remote, this.branch]);
      const count = async (range) => Number((await run(['rev-list', '--count', range], { log: false })).out) || 0;
      if ((await count(`HEAD..${upstream}`)) > 0) {
        const incoming = (await run(['diff', '--name-only', `HEAD...${upstream}`], { log: false })).out.split('\n').filter(Boolean);
        const dirty = vscode.workspace.textDocuments
          .filter((d) => d.isDirty && d.uri.scheme === 'file')
          .map((d) => path.relative(this.root, d.uri.fsPath).split(path.sep).join('/'))
          .filter((f) => incoming.includes(f));
        if (dirty.length) {
          // Merging would rewrite files with unsaved edits underneath the editor; wait for a save.
          this.setState('waiting', `Overleaf has changes to ${dirty.join(', ')}: save to merge them`);
          return;
        }
        const before = (await run(['rev-parse', 'HEAD'], { log: false })).out;
        const merge = await run(['merge', '--no-edit', '-q', upstream], { allowFail: true });
        if (merge.code !== 0) {
          const conflicted = (await run(['diff', '--name-only', '--diff-filter=U'])).out.split('\n').filter(Boolean);
          if (!conflicted.length) throw new GitError(['merge'], merge.code, merge.out);
          this.setState('conflict', `Resolve conflicts in ${conflicted.join(', ')} and save`);
          notifyConflict(this, conflicted);
          return;
        }
        const changed = (await run(['diff', '--name-only', before, 'HEAD'], { log: false })).out.split('\n').filter(Boolean);
        if (changed.length) {
          output.appendLine(`[overleaf] pulled: ${changed.join(', ')}`);
          onFilesChanged(changed.map((f) => path.join(this.root, f)));
        }
      }

      // 4. Push ours.
      if ((await count(`${upstream}..HEAD`)) > 0) {
        const push = await run(['push', '-q', this.remote, `HEAD:${this.branch}`], { allowFail: true });
        if (push.code !== 0) {
          if (/rejected|non-fast-forward|fetch first/i.test(push.out) && attempt < 2) {
            return this.doSync(reason, attempt + 1); // someone pushed in between; merge again
          }
          throw new GitError(['push'], push.code, push.out);
        }
      }
      this.setState('synced');
    } catch (e) {
      output.appendLine(`[overleaf] ${e.message}`);
      if (e.authFailed) {
        this.setState('error', 'Authentication failed: set your Overleaf Git token');
        const choice = await vscode.window.showErrorMessage(
          'Overleaf rejected the Git token.',
          'Set Token',
          'Show Log'
        );
        if (choice === 'Set Token' && (await askToken())) this.sync('manual');
        if (choice === 'Show Log') output.show(true);
      } else {
        this.setState('error', e.message);
      }
    }
  }
}

function hasConflictMarkers(file) {
  try {
    return /^<{7} |^>{7} /m.test(fs.readFileSync(file, 'utf8'));
  } catch {
    return false;
  }
}

async function notifyConflict(repo, files) {
  const choice = await vscode.window.showWarningMessage(
    `Overleaf sync: your edits and Overleaf's both changed ${files.join(', ')}. Resolve the conflict and save to finish syncing.`,
    'Open File'
  );
  if (choice === 'Open File') {
    await vscode.window.showTextDocument(vscode.Uri.file(path.join(repo.root, files[0])));
  }
}

// ---------------------------------------------------------------------------- discovery

async function discover() {
  const folders = vscode.workspace.workspaceFolders || [];
  const found = new Set();
  for (const f of folders) {
    if (f.uri.scheme !== 'file') continue;
    const top = await git(f.uri.fsPath, ['rev-parse', '--show-toplevel'], { allowFail: true, log: false }).catch(() => null);
    if (!top || top.code !== 0) continue;
    const root = top.out;
    if (found.has(root)) continue;

    const remotes = (await git(root, ['remote', '-v'], { log: false })).out;
    const flagged = (await git(root, ['config', '--get', 'texpreview.overleaf'], { allowFail: true, log: false })).out === 'true';
    let remote = null;
    let url = null;
    for (const line of remotes.split('\n')) {
      const m = line.match(/^(\S+)\s+(\S+)\s+\(fetch\)/);
      if (m && (m[2].includes(OVERLEAF_HOST) || (flagged && !remote))) {
        remote = m[1];
        url = m[2];
        if (m[2].includes(OVERLEAF_HOST)) break;
      }
    }
    if (!remote) continue;
    found.add(root);
    if (repos.has(root)) continue;

    const branch =
      (await git(root, ['rev-parse', '--abbrev-ref', 'HEAD'], { allowFail: true, log: false })).out || 'master';
    const repo = new Repo(root, remote, branch === 'HEAD' ? 'master' : branch, url);
    // Overleaf ignores commit authors, but git refuses to commit without one.
    const hasIdentity = async (k) => (await git(root, ['config', '--get', k], { allowFail: true, log: false })).out;
    if (!(await hasIdentity('user.name')) || !(await hasIdentity('user.email'))) {
      const name = os.userInfo().username || 'VS Code';
      const email = `${name}@users.noreply.overleaf`;
      repo.identity = { GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email };
    }
    repos.set(root, repo);
    writeExcludes(root);
    output.appendLine(`[overleaf] syncing ${root} with ${url} (${repo.remote}/${repo.branch})`);
    if (cfg().get('autoSync')) repo.sync('startup');
  }
  for (const root of [...repos.keys()]) if (!found.has(root)) repos.delete(root);
  renderStatus();
  restartPolling();
}

/** Keep build output out of the Overleaf project without touching the project's own files. */
function writeExcludes(root) {
  const file = path.join(root, '.git', 'info', 'exclude');
  const outDir = vscode.workspace.getConfiguration('texPreview').get('outDir') || '.texbuild';
  const wanted = ['.DS_Store'];
  if (outDir && outDir !== '.') wanted.push(`${outDir.replace(/^\.\//, '').replace(/\/$/, '')}/`);
  else wanted.push('*.aux', '*.log', '*.synctex.gz', '*.fdb_latexmk', '*.fls', '*.out', '*.toc', '*.blg', '*.xdv');
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const have = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    const missing = wanted.filter((w) => !have.split('\n').includes(w));
    if (missing.length) {
      fs.appendFileSync(file, `${have && !have.endsWith('\n') ? '\n' : ''}# added by TeX Side Preview\n${missing.join('\n')}\n`);
    }
  } catch (e) {
    output.appendLine(`[overleaf] could not update ${file}: ${e.message}`);
  }
}

function restartPolling() {
  clearInterval(pollTimer);
  if (!repos.size || !cfg().get('autoSync')) return;
  const secs = Math.max(15, Number(cfg().get('pullInterval')) || 60);
  pollTimer = setInterval(() => pollAll(), secs * 1000);
}

function pollAll() {
  if (!cfg().get('autoSync')) return;
  for (const repo of repos.values()) {
    // Don't stack polls behind a slow sync.
    if (repo.state !== 'syncing' && repo.state !== 'conflict') repo.sync('poll');
  }
}

// ---------------------------------------------------------------------------- status bar & commands

function renderStatus() {
  if (!repos.size) {
    statusItem.hide();
    return;
  }
  const list = [...repos.values()];
  const worst =
    list.find((r) => r.state === 'conflict') ||
    list.find((r) => r.state === 'error') ||
    list.find((r) => r.state === 'waiting') ||
    list.find((r) => r.state === 'syncing') ||
    list[0];
  const paused = list.every((r) => r.paused) || !cfg().get('autoSync');
  const icon = paused
    ? '$(debug-pause)'
    : { syncing: '$(sync~spin)', conflict: '$(warning)', error: '$(error)', waiting: '$(clock)' }[worst.state] || '$(cloud)';
  const label = paused ? 'Overleaf: paused' : worst.state === 'synced' || worst.state === 'idle' ? 'Overleaf' : `Overleaf: ${worst.state}`;
  statusItem.text = `${icon} ${label}`;
  statusItem.tooltip = list
    .map((r) => {
      const when = r.lastSync ? `last synced ${r.lastSync.toLocaleTimeString()}` : 'not synced yet';
      return `${r.name}: ${r.message || r.state} (${when})`;
    })
    .join('\n') + '\n\nClick for Overleaf actions';
  statusItem.backgroundColor =
    worst.state === 'conflict' || worst.state === 'error'
      ? new vscode.ThemeColor('statusBarItem.warningBackground')
      : undefined;
  statusItem.show();
}

function pickRepo() {
  const list = [...repos.values()];
  if (list.length <= 1) return Promise.resolve(list[0]);
  return vscode.window
    .showQuickPick(list.map((r) => ({ label: r.name, description: r.root, repo: r })), { title: 'Overleaf project' })
    .then((p) => p && p.repo);
}

async function showMenu() {
  const repo = await pickRepo();
  if (!repo) return;
  const items = [
    { label: '$(sync) Sync Now', run: () => repo.sync('manual') },
    {
      label: repo.paused ? '$(play) Resume Auto-Sync' : '$(debug-pause) Pause Auto-Sync',
      run: () => {
        repo.paused = !repo.paused;
        if (!repo.paused) repo.sync('manual');
        renderStatus();
      },
    },
    repo.projectId && {
      label: '$(globe) Open Project on Overleaf',
      run: () => vscode.env.openExternal(vscode.Uri.parse(`https://www.overleaf.com/project/${repo.projectId}`)),
    },
    { label: '$(key) Set Overleaf Git Token…', run: () => askToken() },
    { label: '$(output) Show Sync Log', run: () => output.show(true) },
  ].filter(Boolean);
  const pick = await vscode.window.showQuickPick(items, {
    title: `Overleaf: ${repo.name}`,
    placeHolder: repo.message || (repo.lastSync ? `Last synced ${repo.lastSync.toLocaleTimeString()}` : ''),
  });
  if (pick) pick.run();
}

async function cloneProject() {
  const input = await vscode.window.showInputBox({
    title: 'Clone Overleaf project (1/3)',
    prompt: 'Paste the project URL from your browser, or its Git URL (Overleaf menu → Sync → Git)',
    placeHolder: 'https://www.overleaf.com/project/65f0c1…',
    ignoreFocusOut: true,
    validateInput: (v) => (PROJECT_ID.test(v) ? null : 'Could not find a project id (24 hex characters) in that'),
  });
  if (!input) return;
  const id = input.match(PROJECT_ID)[1].toLowerCase();
  const url = `https://${OVERLEAF_HOST}/${id}`;

  const token = await getToken(true);
  if (!token) return;

  const parent = await vscode.window.showOpenDialog({
    title: 'Clone Overleaf project (2/3): choose where to put it',
    canSelectFiles: false,
    canSelectFolders: true,
    openLabel: 'Clone here',
    defaultUri: vscode.Uri.file(path.join(os.homedir(), 'Documents')),
  });
  if (!parent || !parent[0]) return;
  const name = await vscode.window.showInputBox({
    title: 'Clone Overleaf project (3/3): folder name',
    value: `overleaf-${id.slice(-6)}`,
    ignoreFocusOut: true,
    validateInput: (v) =>
      !v.trim() ? 'Required' : fs.existsSync(path.join(parent[0].fsPath, v.trim())) ? 'That folder already exists' : null,
  });
  if (!name) return;
  const dest = path.join(parent[0].fsPath, name.trim());

  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Cloning Overleaf project…' },
      async () => {
        await git(parent[0].fsPath, ['clone', '-q', url, dest], { token });
        await git(dest, ['config', 'texpreview.overleaf', 'true']);
      }
    );
  } catch (e) {
    if (e.authFailed) {
      const again = await askToken('Overleaf rejected that token.');
      if (again) return cloneProject();
      return;
    }
    vscode.window.showErrorMessage(`Clone failed: ${e.message}`);
    return;
  }
  writeExcludes(dest);

  const choice = await vscode.window.showInformationMessage(
    `Cloned into ${dest}. Saves will sync to Overleaf automatically.`,
    'Open',
    'Open in New Window',
    'Add to Workspace'
  );
  const uri = vscode.Uri.file(dest);
  if (choice === 'Open') vscode.commands.executeCommand('vscode.openFolder', uri, false);
  else if (choice === 'Open in New Window') vscode.commands.executeCommand('vscode.openFolder', uri, true);
  else if (choice === 'Add to Workspace') {
    vscode.workspace.updateWorkspaceFolders((vscode.workspace.workspaceFolders || []).length, 0, { uri });
  }
}

// ---------------------------------------------------------------------------- activation

function activate(context, opts = {}) {
  ctx = context;
  onFilesChanged = opts.onFilesChanged || onFilesChanged;
  output = vscode.window.createOutputChannel('Overleaf Sync');
  statusItem = vscode.window.createStatusBarItem('texPreview.overleaf', vscode.StatusBarAlignment.Left, 99);
  statusItem.name = 'Overleaf Sync';
  statusItem.command = 'texPreview.overleaf.menu';

  context.subscriptions.push(
    output,
    statusItem,
    { dispose: () => clearInterval(pollTimer) },
    vscode.commands.registerCommand('texPreview.overleaf.clone', cloneProject),
    vscode.commands.registerCommand('texPreview.overleaf.menu', showMenu),
    vscode.commands.registerCommand('texPreview.overleaf.syncNow', async () => {
      if (!repos.size) await discover();
      const repo = await pickRepo();
      if (repo) repo.sync('manual');
      else vscode.window.showInformationMessage('No Overleaf project in this workspace. Use "Overleaf: Clone Project…" first.');
    }),
    vscode.commands.registerCommand('texPreview.overleaf.setToken', () => askToken()),
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (doc.uri.scheme !== 'file' || !cfg().get('autoSync')) return;
      for (const repo of repos.values()) if (repo.contains(doc.uri.fsPath)) repo.schedulePush();
    }),
    // New/deleted/renamed files from the Explorer should sync too, not only text saves.
    vscode.workspace.onDidCreateFiles((e) => scheduleFor(e.files)),
    vscode.workspace.onDidDeleteFiles((e) => scheduleFor(e.files)),
    vscode.workspace.onDidRenameFiles((e) => scheduleFor(e.files.map((f) => f.newUri))),
    vscode.window.onDidChangeWindowState((s) => {
      if (s.focused) pollAll();
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => discover()),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('texPreview.overleaf')) {
        restartPolling();
        renderStatus();
      }
    })
  );
  discover();
}

function scheduleFor(uris) {
  if (!cfg().get('autoSync')) return;
  for (const repo of repos.values()) if (uris.some((u) => u.scheme === 'file' && repo.contains(u.fsPath))) repo.schedulePush();
}

module.exports = { activate, scheduleFor };
