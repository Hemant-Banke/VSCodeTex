'use strict';

// Finding and running external programs (TeX, chktex, latexindent, Ghostscript, docker…).

const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

function searchPath() {
  const cfg = vscode.workspace.getConfiguration('texPreview');
  const extra = cfg.get('extraPath') || [];
  const home = os.homedir();
  const defaults =
    process.platform === 'win32'
      ? []
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
  // Also pick up any TeX Live install under /usr/local/texlive/<year>/bin/<arch>.
  try {
    const tl = '/usr/local/texlive';
    for (const year of fs.readdirSync(tl).sort().reverse()) {
      const binRoot = path.join(tl, year, 'bin');
      if (!fs.existsSync(binRoot)) continue;
      for (const arch of fs.readdirSync(binRoot)) defaults.push(path.join(binRoot, arch));
    }
  } catch {
    /* no TeX Live there */
  }
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

module.exports = { searchPath, which, exec };
