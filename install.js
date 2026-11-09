'use strict';

// One-click Tectonic: downloads a pinned release into the extension's storage, so a first-time
// user can build without installing a TeX distribution. Tectonic fetches the packages a
// document needs on its first build. Every download is checked against its published SHA-256.

const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { exec, which, setManagedBin } = require('./tools');

const VERSION = '0.17.0';
const BASE = `https://github.com/tectonic-typesetting/tectonic/releases/download/tectonic%40${VERSION}/`;
// From the GitHub release's asset digests.
const ASSETS = {
  'darwin-arm64': ['tectonic-0.17.0-aarch64-apple-darwin.tar.gz', 'a3f1cac7c5678f01661a92212f58480ae3b0634115d880dbc59e2953ded45667'],
  'darwin-x64': ['tectonic-0.17.0-x86_64-apple-darwin.tar.gz', '7c90ef5b6ddb1eb1937e4337add5237b79338e4b9676459fa91187d24d6cdf80'],
  'linux-x64': ['tectonic-0.17.0-x86_64-unknown-linux-musl.tar.gz', '8533d07f9ccbd7a65824b9e0459041bca34af1eb33daba48f59215593753a3b7'],
  'linux-arm64': ['tectonic-0.17.0-aarch64-unknown-linux-musl.tar.gz', 'b10954a95404f3ab2328d2fa59a5ebab8e657f893fab096f98be8db7c0c979b8'],
  'linux-arm': ['tectonic-0.17.0-arm-unknown-linux-musleabihf.tar.gz', '882f5213599931992dfb9f7e1157d3015fd9abd505c68c693b3d6dc20967f7eb'],
  'win32-x64': ['tectonic-0.17.0-x86_64-pc-windows-msvc.zip', 'f61ce51f0b0ade1015b7de7ef368541c5424e9756ecbd0d7af97d6d48030845f'],
  // Windows on Arm runs the x64 build.
  'win32-arm64': ['tectonic-0.17.0-x86_64-pc-windows-msvc.zip', 'f61ce51f0b0ade1015b7de7ef368541c5424e9756ecbd0d7af97d6d48030845f'],
};

let binDir;
let installing = null;

function activate(context) {
  binDir = path.join(context.globalStorageUri.fsPath, 'tectonic', VERSION);
  setManagedBin(binDir);
  context.subscriptions.push(
    vscode.commands.registerCommand('texPreview.installTectonic', () => install()),
    vscode.commands.registerCommand('texPreview.checkCompiler', () => checkCompiler(true))
  );
  updateContext();
}

/** Which compiler a build would use, or null. */
function findCompiler() {
  const engine = vscode.workspace.getConfiguration('texPreview').get('engine') || 'auto';
  const names = engine === 'auto' ? ['latexmk', 'tectonic', 'pdflatex'] : [engine];
  for (const n of names) {
    const bin = which(n);
    if (bin) return { name: n, bin };
  }
  return null;
}

function updateContext() {
  vscode.commands.executeCommand('setContext', 'texPreview.hasCompiler', !!findCompiler());
}

/** Tells the person which compiler builds will use, or offers to install one. */
async function checkCompiler(verbose) {
  const found = findCompiler();
  updateContext();
  if (found) {
    if (verbose) vscode.window.showInformationMessage(`TeX: builds will use ${found.name} (${found.bin}).`);
    return true;
  }
  return offerInstall('No LaTeX compiler was found.');
}

/** "No compiler" notification with the one-click install. Resolves true once one is installed. */
async function offerInstall(reason) {
  const pick = await vscode.window.showWarningMessage(
    `${reason} Install Tectonic, a small self-contained LaTeX engine (about 20 MB; it downloads the packages a document needs on its first build)? Or install TeX Live / MacTeX / MiKTeX yourself.`,
    'Install Tectonic',
    'How to Install TeX'
  );
  if (pick === 'Install Tectonic') return !!(await install());
  if (pick === 'How to Install TeX') vscode.env.openExternal(vscode.Uri.parse('https://www.latex-project.org/get/'));
  return false;
}

async function download(url) {
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(300000) });
  if (!res.ok) throw new Error(`download failed (${res.status})`);
  return Buffer.from(await res.arrayBuffer());
}

/** Downloads and unpacks Tectonic; returns the binary's path, or null. */
function install() {
  if (installing) return installing;
  installing = doInstall().finally(() => (installing = null));
  return installing;
}

async function doInstall() {
  const exe = path.join(binDir, process.platform === 'win32' ? 'tectonic.exe' : 'tectonic');
  if (fs.existsSync(exe)) {
    updateContext();
    vscode.window.showInformationMessage('Tectonic is already installed for TeX Side Preview.');
    return exe;
  }
  const asset = ASSETS[`${process.platform}-${process.arch}`];
  if (!asset) {
    vscode.window.showErrorMessage(`TeX: there's no Tectonic build for ${process.platform}-${process.arch}. Install TeX Live or MiKTeX instead.`, 'How to Install TeX').then((p) => p && vscode.env.openExternal(vscode.Uri.parse('https://www.latex-project.org/get/')));
    return null;
  }
  const [name, sha256] = asset;
  try {
    return await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Installing Tectonic ${VERSION}…` }, async (progress) => {
      progress.report({ message: 'downloading' });
      const buf = await download(BASE + name);
      const got = crypto.createHash('sha256').update(buf).digest('hex');
      if (got !== sha256) throw new Error('the download did not match its published checksum, so it was not installed');
      progress.report({ message: 'unpacking' });
      fs.mkdirSync(binDir, { recursive: true });
      const archive = path.join(binDir, name);
      fs.writeFileSync(archive, buf);
      // bsdtar (macOS, Windows 10+) and GNU tar (Linux) both unpack these.
      let r = await exec('tar', [name.endsWith('.zip') ? '-xf' : '-xzf', archive, '-C', binDir]);
      if (r.code !== 0 && process.platform === 'win32') {
        r = await exec('powershell.exe', ['-NoProfile', '-Command', `Expand-Archive -Force -LiteralPath '${archive}' -DestinationPath '${binDir}'`]);
      }
      fs.rmSync(archive, { force: true });
      if (r.code !== 0 || !fs.existsSync(exe)) throw new Error(`couldn't unpack it (${(r.stderr || '').trim().slice(0, 200)})`);
      if (process.platform !== 'win32') fs.chmodSync(exe, 0o755);
      updateContext();
      return exe;
    }).then((bin) => {
      vscode.window.showInformationMessage('Tectonic is installed. The first build downloads the packages your document uses, so it takes a little longer.');
      return bin;
    });
  } catch (e) {
    fs.rmSync(binDir, { recursive: true, force: true });
    vscode.window.showErrorMessage(`TeX: couldn't install Tectonic: ${e.message}.`, 'How to Install TeX').then((p) => p && vscode.env.openExternal(vscode.Uri.parse('https://www.latex-project.org/get/')));
    return null;
  }
}

module.exports = { activate, install, offerInstall, checkCompiler, findCompiler, VERSION };
