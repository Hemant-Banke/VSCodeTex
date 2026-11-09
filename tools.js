'use strict';

// Finding and running external programs (TeX, chktex, latexindent, Ghostscript, docker…).

const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

let managedBin = null; // Tectonic installed by the extension (install.js)

function setManagedBin(dir) {
  managedBin = dir;
}

function searchPath() {
  const cfg = vscode.workspace.getConfiguration('texPreview');
  const extra = cfg.get('extraPath') || [];
  const home = os.homedir();
  const env = process.env;
  const defaults =
    process.platform === 'win32'
      ? [
          // MiKTeX (per-user and all-users installs); TeX Live is found below.
          env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs', 'MiKTeX', 'miktex', 'bin', 'x64'),
          env.ProgramFiles && path.join(env.ProgramFiles, 'MiKTeX', 'miktex', 'bin', 'x64'),
          env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs', 'Tectonic'),
          env.USERPROFILE && path.join(env.USERPROFILE, '.cargo', 'bin'),
        ].filter(Boolean)
      : [
          '/Library/TeX/texbin',
          '/opt/homebrew/bin',
          '/usr/local/bin',
          '/usr/texbin',
          '/usr/bin',
          path.join(home, '.local', 'bin'),
          path.join(home, '.cargo', 'bin'),
          path.join(home, 'bin'),
        ];
  // Also pick up any TeX Live install under <texlive>/<year>/bin/<arch>.
  const texlive = process.platform === 'win32' ? ['C:\\texlive', path.join(home, 'texlive')] : ['/usr/local/texlive', path.join(home, 'texlive')];
  for (const tl of texlive) {
    try {
      for (const year of fs.readdirSync(tl).filter((y) => /^\d{4}$/.test(y)).sort().reverse()) {
        const binRoot = path.join(tl, year, 'bin');
        if (!fs.existsSync(binRoot)) continue;
        for (const arch of fs.readdirSync(binRoot)) defaults.push(path.join(binRoot, arch));
      }
    } catch {
      /* no TeX Live there */
    }
  }
  // Last, so a TeX distribution the person installed wins.
  if (managedBin) defaults.push(managedBin);
  const parts = [...extra, ...(process.env.PATH || '').split(path.delimiter), ...defaults];
  return [...new Set(parts.filter(Boolean))].join(path.delimiter);
}

function which(cmd, PATH = searchPath()) {
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const dir of PATH.split(path.delimiter)) {
    for (const ext of exts) {
      const full = path.join(dir, cmd + ext);
      try {
        fs.accessSync(full, fs.constants.X_OK);
        if (fs.statSync(full).isFile()) return full;
      } catch {
        /* keep looking */
      }
    }
  }
  return null;
}

/** Runs a program to completion: {code, stdout, stderr}. Optional `input` goes to stdin. */
function exec(bin, args, { cwd, input, env } = {}) {
  return new Promise((resolve) => {
    const proc = spawn(bin, args, { cwd, env: env || { ...process.env, PATH: searchPath() } });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => (stdout += d));
    proc.stderr.on('data', (d) => (stderr += d));
    proc.on('error', (e) => resolve({ code: -1, stdout, stderr: e.message }));
    proc.on('close', (code) => resolve({ code, stdout, stderr }));
    if (input !== undefined) proc.stdin.end(input);
  });
}

module.exports = { searchPath, which, exec, setManagedBin };
