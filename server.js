'use strict';

// Serves the preview to a web browser: the same viewer as the panel, talking to the extension
// over Server-Sent Events (extension → page) and POST (page → extension). It listens on
// 127.0.0.1 only and every preview gets an unguessable token in its URL.

const vscode = require('vscode');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const TYPES = { '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.bcmap': 'application/octet-stream', '.pfb': 'application/octet-stream', '.ttf': 'font/ttf' };

class BrowserServer {
  constructor(extensionPath) {
    this.root = extensionPath;
    this.previews = new Map(); // token -> Preview
    this.server = null;
    this.port = 0;
  }

  async url(preview) {
    if (!preview.browserToken) {
      preview.browserToken = crypto.randomBytes(18).toString('base64url');
      this.previews.set(preview.browserToken, preview);
    }
    await this.listen();
    const local = vscode.Uri.parse(`http://127.0.0.1:${this.port}/${preview.browserToken}/`);
    return vscode.env.asExternalUri(local); // forwarded when VS Code runs remotely
  }

  forget(preview) {
    if (preview.browserToken) this.previews.delete(preview.browserToken);
  }

  listen() {
    if (this.server) return Promise.resolve();
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => this.handle(req, res).catch(() => res.end()));
      this.server.on('error', reject);
      this.server.listen(0, '127.0.0.1', () => {
        this.port = this.server.address().port;
        resolve();
      });
    });
  }

  dispose() {
    if (this.server) this.server.close();
  }

  async handle(req, res) {
    const url = new URL(req.url, 'http://127.0.0.1');
    const [, token, ...rest] = url.pathname.split('/');
    const preview = this.previews.get(token);
    if (!preview) return notFound(res);
    const route = rest.join('/');

    if (route === '') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(preview.html(browserAssets()));
    }
    if (route === 'events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write(': connected\n\n');
      preview.addClient(url.searchParams.get('id') || '', res);
      req.on('close', () => preview.removeClient(url.searchParams.get('id') || ''));
      return;
    }
    if (route === 'msg' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      res.end();
      try {
        const msg = JSON.parse(body);
        preview.onMessage(msg, msg._client);
      } catch {
        /* ignore malformed */
      }
      return;
    }
    // Static files: the viewer, and pdf.js with its fonts and cmaps.
    let file = null;
    if (route.startsWith('media/')) file = path.join(this.root, 'media', path.basename(route));
    else if (route.startsWith('pdfjs/')) file = path.join(this.root, 'node_modules', 'pdfjs-dist', path.normalize(route.slice(6)));
    const allowed = path.join(this.root, 'node_modules', 'pdfjs-dist') + path.sep;
    if (!file || (!file.startsWith(allowed) && !file.startsWith(path.join(this.root, 'media') + path.sep))) return notFound(res);
    fs.readFile(file, (err, buf) => {
      if (err) return notFound(res);
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
      res.end(buf);
    });
  }
}

function notFound(res) {
  res.writeHead(404);
  res.end();
}

/** URLs and glue for the viewer page when served to a browser. */
function browserAssets() {
  return {
    browser: true,
    csp: null,
    media: (f) => `media/${f}`,
    pdfjs: (f) => `pdfjs/build/${f}`,
    assets: 'pdfjs',
    // Stand-in for the webview API: state in localStorage, messages over HTTP.
    shim: `
      (function () {
        const id = Math.random().toString(36).slice(2);
        const queue = [];
        window.acquireVsCodeApi = () => ({
          postMessage: (m) => fetch('msg', { method: 'POST', body: JSON.stringify(Object.assign({ _client: id }, m)) }),
          getState: () => { try { return JSON.parse(localStorage.getItem('texPreview:' + location.pathname)); } catch (e) { return null; } },
          setState: (s) => { try { localStorage.setItem('texPreview:' + location.pathname, JSON.stringify(s)); } catch (e) {} },
        });
        const es = new EventSource('events?id=' + id);
        es.onmessage = (e) => window.dispatchEvent(new MessageEvent('message', { data: JSON.parse(e.data) }));
        es.onerror = () => { document.title = 'Disconnected — ' + document.title.replace(/^Disconnected — /, ''); };
      })();`,
  };
}

module.exports = { BrowserServer };
