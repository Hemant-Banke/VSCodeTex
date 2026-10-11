/* global pdfjsLib, acquireVsCodeApi */
(function () {
  'use strict';

  const vscode = acquireVsCodeApi();
  const state = Object.assign({ zoom: 'fit', scrollTop: 0 }, vscode.getState() || {});

  const viewer = document.getElementById('viewer');
  const statusEl = document.getElementById('status');
  const statusText = document.getElementById('status-text');
  const errorsEl = document.getElementById('errors');
  const pagesEl = document.getElementById('pages');
  const zoomLabel = document.getElementById('zoom-label');

  const GAP = 12; // px between pages
  const PAD = 16; // px side padding inside the viewer
  const ZOOMS = [0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];

  let pdfDoc = null;
  let pageSizes = []; // unscaled [w, h] at scale 1
  let pageEls = [];
  let observer = null;
  let renderToken = 0;
  let curScale = 1;

  // The worker is loaded through a blob: URL; webview-resource URLs can't be used as a Worker origin.
  const workerReady = fetch(window.PDF_WORKER_URL)
    .then((r) => r.text())
    .then((src) => {
      pdfjsLib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(
        new Blob([src], { type: 'text/javascript' })
      );
    });

  // ---------------------------------------------------------------- status UI

  function setStatus(msg) {
    statusEl.className = 'status ' + msg.state;
    statusText.textContent = msg.message || '';
    statusText.title = msg.message || '';
    errorsEl.innerHTML = '';
    const errs = msg.errors || [];
    if (msg.state === 'error' && (errs.length || msg.missingEngine)) {
      if (msg.missingEngine) {
        const div = document.createElement('div');
        div.className = 'hint';
        div.innerHTML =
          '<strong>Install a TeX distribution</strong>, then hit Recompile:<br>' +
          '• macOS: <code>brew install --cask mactex-no-gui</code> (full) or <code>brew install tectonic</code> (small, downloads packages on demand)<br>' +
          '• Linux: <code>sudo apt install texlive-full latexmk</code><br>' +
          '• Windows: install MiKTeX or TeX Live<br>' +
          'Or set <code>texPreview.extraPath</code> if it is installed somewhere unusual.';
        errorsEl.appendChild(div);
      }
      for (const e of errs) {
        const row = document.createElement('button');
        row.className = 'error-row';
        const loc = document.createElement('span');
        loc.className = 'loc';
        loc.textContent = e.line ? `${e.rel}:${e.line}` : e.rel;
        const text = document.createElement('span');
        text.className = 'msg';
        text.textContent = e.message;
        row.append(loc, text);
        row.title = 'Go to source';
        row.addEventListener('click', () => vscode.postMessage({ type: 'reveal', file: e.file, line: e.line }));
        errorsEl.appendChild(row);
      }
      const logBtn = document.createElement('button');
      logBtn.className = 'link';
      logBtn.textContent = 'Show full log';
      logBtn.addEventListener('click', () => vscode.postMessage({ type: 'showLog' }));
      errorsEl.appendChild(logBtn);
      errorsEl.hidden = false;
    } else {
      errorsEl.hidden = true;
    }
  }

  // ---------------------------------------------------------------- rendering

  function currentScale() {
    if (state.zoom !== 'fit') return state.zoom;
    const maxW = Math.max(...pageSizes.map((s) => s[0]), 1);
    return Math.max(0.2, (viewer.clientWidth - PAD * 2) / maxW);
  }

  function updateZoomLabel() {
    zoomLabel.textContent = state.zoom === 'fit' ? 'Fit' : Math.round(state.zoom * 100) + '%';
  }

  async function loadPdf(base64) {
    await workerReady;
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const doc = await pdfjsLib.getDocument({
      data: bytes,
      isEvalSupported: false,
      cMapUrl: window.PDF_ASSETS + '/cmaps/',
      cMapPacked: true,
      standardFontDataUrl: window.PDF_ASSETS + '/standard_fonts/',
    }).promise;

    const sizes = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const vp = (await doc.getPage(i)).getViewport({ scale: 1 });
      sizes.push([vp.width, vp.height]);
    }
    const old = pdfDoc;
    pdfDoc = doc;
    pageSizes = sizes;
    await layout(old ? 'keep' : 'restore');
    if (old) old.destroy();
  }

  /**
   * Builds page placeholders at the current scale, renders the pages that will be visible,
   * then swaps them in so a recompile doesn't flash or lose the scroll position.
   */
  // mode: 'keep' (same scrollTop, after a recompile), 'ratio' (zoom/resize), 'restore' (first load)
  async function layout(mode) {
    if (!pdfDoc) return;
    const token = ++renderToken;
    const scale = currentScale();
    curScale = scale;
    const prevScroll = viewer.scrollTop;
    const prevHeight = viewer.scrollHeight || 1;

    const container = document.createElement('div');
    container.className = 'pages';
    container.style.setProperty('--scale-factor', String(scale)); // read by pdf.js's text layer
    const els = pageSizes.map(([w, h], i) => {
      const el = document.createElement('div');
      el.className = 'page';
      el.style.width = Math.floor(w * scale) + 'px';
      el.style.height = Math.floor(h * scale) + 'px';
      el.dataset.index = String(i);
      container.appendChild(el);
      return el;
    });

    // Work out which pages will be on screen after the swap, and render them first.
    const targetHeight = pageSizes.reduce((a, [, h]) => a + Math.floor(h * scale) + GAP, PAD);
    let top = prevScroll;
    if (mode === 'restore') top = (state.anchor || 0) * targetHeight;
    else if (mode === 'ratio') top = (prevScroll / prevHeight) * targetHeight;
    const bottom = top + viewer.clientHeight;
    const visible = [];
    let y = PAD;
    pageSizes.forEach(([, h], i) => {
      const ph = Math.floor(h * scale);
      if (y + ph >= top && y <= bottom) visible.push(i);
      y += ph + GAP;
    });
    await Promise.all(visible.map((i) => renderPage(els[i], i, scale, token)));
    if (token !== renderToken) return;

    viewer.replaceChildren(container);
    pageEls = els;
    viewer.scrollTop = top;
    pagesEl.textContent = `${pdfDoc.numPages} page${pdfDoc.numPages === 1 ? '' : 's'}`;
    updateZoomLabel();

    if (observer) observer.disconnect();
    observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting && !entry.target.dataset.rendered) {
            const i = Number(entry.target.dataset.index);
            renderPage(entry.target, i, scale, token);
          }
        }
      },
      { root: viewer, rootMargin: '600px 0px' }
    );
    els.forEach((el) => observer.observe(el));
  }

  async function renderPage(el, index, scale, token) {
    if (el.dataset.rendered) return;
    el.dataset.rendered = 'pending';
    try {
      const page = await pdfDoc.getPage(index + 1);
      if (token !== renderToken) return;
      const dpr = window.devicePixelRatio || 1;
      const vp = page.getViewport({ scale: scale * dpr });
      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(vp.width);
      canvas.height = Math.floor(vp.height);
      await page.render({ canvasContext: canvas.getContext('2d', { alpha: false }), viewport: vp }).promise;
      if (token !== renderToken) return;
      const cssViewport = page.getViewport({ scale });
      const [text, links] = await Promise.all([buildTextLayer(page, cssViewport), buildLinkLayer(page, cssViewport)]);
      if (token !== renderToken) return;
      // Replace only the rendered layers so overlays such as a SyncTeX highlight survive.
      el.querySelectorAll(':scope > canvas, :scope > .textLayer, :scope > .links').forEach((n) => n.remove());
      el.prepend(canvas, text, links);
      el.dataset.rendered = 'done';
    } catch (err) {
      delete el.dataset.rendered;
      if (!/destroyed|cancel/i.test(String(err))) console.error(err);
    }
  }

  // ---------------------------------------------------------------- text layer

  /** Transparent, positioned text over the canvas so the PDF can be selected and copied. */
  async function buildTextLayer(page, viewport) {
    const layer = document.createElement('div');
    layer.className = 'textLayer';
    await pdfjsLib.renderTextLayer({
      textContentSource: page.streamTextContent({ includeMarkedContent: true }),
      container: layer,
      viewport,
      textDivs: [],
    }).promise;
    // As in pdf.js's viewer: a filler that keeps drag-selections from jumping across the page.
    const end = document.createElement('div');
    end.className = 'endOfContent';
    layer.appendChild(end);
    layer.addEventListener('mousedown', () => end.classList.add('active'));
    return layer;
  }
  // Copy the PDF selection ourselves; the host's copy command may not reach the webview.
  document.addEventListener('keydown', (e) => {
    if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'c') return;
    const text = window.getSelection()?.toString();
    if (!text) return;
    e.preventDefault();
    const fallback = () => document.execCommand('copy');
    if (navigator.clipboard) navigator.clipboard.writeText(text).catch(fallback);
    else fallback();
  });
  document.addEventListener('mouseup', () => {
    document.querySelectorAll('.endOfContent.active').forEach((n) => n.classList.remove('active'));
  });

  // ---------------------------------------------------------------- links

  async function buildLinkLayer(page, viewport) {
    const layer = document.createElement('div');
    layer.className = 'links';
    for (const a of await page.getAnnotations({ intent: 'display' })) {
      if (a.subtype !== 'Link' || !a.rect) continue;
      const url = a.url || a.unsafeUrl;
      if (!url && !a.dest) continue;
      const [x1, y1, x2, y2] = viewport.convertToViewportRectangle(a.rect);
      const link = document.createElement('a');
      link.style.left = Math.min(x1, x2) + 'px';
      link.style.top = Math.min(y1, y2) + 'px';
      link.style.width = Math.abs(x2 - x1) + 'px';
      link.style.height = Math.abs(y2 - y1) + 'px';
      link.href = '#';
      link.title = url || 'Go to location';
      link.addEventListener('click', (e) => {
        e.preventDefault();
        if (url) vscode.postMessage({ type: 'openExternal', url });
        else goToDest(a.dest);
      });
      layer.appendChild(link);
    }
    return layer;
  }

  /** Scrolls to an internal PDF destination (named or explicit, as hyperref writes them). */
  async function goToDest(dest) {
    if (!pdfDoc) return;
    const explicit = typeof dest === 'string' ? await pdfDoc.getDestination(dest) : dest;
    if (!Array.isArray(explicit)) return;
    const ref = explicit[0];
    const pageIndex = typeof ref === 'object' && ref !== null ? await pdfDoc.getPageIndex(ref) : Number(ref);
    if (!(pageIndex >= 0)) return;
    const page = await pdfDoc.getPage(pageIndex + 1);
    const vp = page.getViewport({ scale: curScale });
    // XYZ: [ref, XYZ, left, top, zoom]; FitH/FitBH: [ref, FitH, top]; anything else → page top.
    const kind = explicit[1] && explicit[1].name;
    const top = kind === 'XYZ' ? explicit[3] : kind === 'FitH' || kind === 'FitBH' ? explicit[2] : null;
    const y = top == null ? 0 : vp.convertToViewportPoint(0, top)[1];
    scrollToPage(pageIndex, Math.max(0, y - 10));
  }

  function scrollToPage(pageIndex, yInPage) {
    const el = pageEls[pageIndex];
    if (!el) return;
    viewer.scrollTo({ top: el.offsetTop + yInPage, behavior: 'smooth' });
  }

  // ---------------------------------------------------------------- SyncTeX

  // Double-click → source. Coordinates go to the extension in PDF points from the page's top-left.
  viewer.addEventListener('dblclick', async (e) => {
    const el = e.target.closest('.page');
    if (!el || !pdfDoc || e.target.closest('.links a')) return;
    const rect = el.getBoundingClientRect();
    const index = Number(el.dataset.index);
    const x = (e.clientX - rect.left) / curScale;
    const y = (e.clientY - rect.top) / curScale;
    // The browser has already selected the double-clicked word in the text layer.
    const selected = (window.getSelection()?.toString() || '').trim();
    const word = /^[\p{L}\p{N}'-]+$/u.test(selected) ? selected : await wordAt(index, x, y).catch(() => '');
    vscode.postMessage({ type: 'inverse', page: index + 1, x, y, word });
  });

  /** The word printed under (x, y), from the page's text content. */
  async function wordAt(index, x, y) {
    const page = await pdfDoc.getPage(index + 1);
    const [vx, , , vy] = page.view;
    const px = x + vx;
    const py = vy - y; // PDF space is bottom-up
    const { items } = await page.getTextContent();
    for (const it of items) {
      if (!it.str || !it.width) continue;
      const [, , , , ex, fy] = it.transform;
      const h = it.height || Math.hypot(it.transform[2], it.transform[3]);
      if (px < ex || px > ex + it.width || py < fy - h * 0.3 || py > fy + h) continue;
      const idx = Math.min(it.str.length - 1, Math.floor(((px - ex) / it.width) * it.str.length));
      const isW = (ch) => /[\p{L}\p{N}'-]/u.test(ch);
      let a = idx;
      let b = idx;
      while (a > 0 && isW(it.str[a - 1])) a--;
      while (b < it.str.length && isW(it.str[b])) b++;
      return it.str.slice(a, b);
    }
    return '';
  }

  // Forward search target: flash a bar over the line.
  let syncSeq = 0;
  async function showLocation(loc) {
    const el = pageEls[loc.page - 1];
    if (!el) return;
    const seq = ++syncSeq;
    document.querySelectorAll('.sync-mark').forEach((m) => m.remove());

    const top = loc.y * curScale;
    const target = Math.max(0, el.offsetTop + top - viewer.clientHeight / 3);
    if (Math.abs(viewer.scrollTop - target) > 2) {
      viewer.scrollTo({ top: target, behavior: 'smooth' });
      await scrollSettled();
    }
    if (seq !== syncSeq || !el.isConnected) return;

    // Highlight only once the line is on screen, so it can't fade out mid-scroll.
    const mark = document.createElement('div');
    mark.className = 'sync-mark';
    mark.style.top = top - 2 + 'px';
    mark.style.height = loc.h * curScale + 4 + 'px';
    if (loc.w > 0) {
      mark.style.left = loc.x * curScale - 4 + 'px';
      mark.style.width = loc.w * curScale + 8 + 'px';
    }
    el.appendChild(mark);
    mark.addEventListener('animationend', () => mark.remove());
  }

  /** Resolves once the viewer has stopped scrolling (smooth scrolls take a few hundred ms). */
  function scrollSettled() {
    return new Promise((resolve) => {
      let last = viewer.scrollTop;
      let still = 0;
      const started = performance.now();
      const tick = () => {
        const now = viewer.scrollTop;
        still = now === last ? still + 1 : 0;
        last = now;
        if (still >= 5 || performance.now() - started > 2000) resolve();
        else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
  }

  // ---------------------------------------------------------------- zoom & events

  function setZoom(z) {
    state.zoom = z;
    saveState();
    layout('ratio');
  }

  document.getElementById('zoom-in').addEventListener('click', () => {
    const cur = currentScale();
    setZoom(ZOOMS.find((z) => z > cur + 0.01) || ZOOMS[ZOOMS.length - 1]);
  });
  document.getElementById('zoom-out').addEventListener('click', () => {
    const cur = currentScale();
    setZoom([...ZOOMS].reverse().find((z) => z < cur - 0.01) || ZOOMS[0]);
  });
  zoomLabel.addEventListener('click', () => setZoom('fit'));
  document.getElementById('recompile').addEventListener('click', () => vscode.postMessage({ type: 'recompile' }));

  // Ctrl/Cmd + wheel to zoom, like a PDF viewer.
  viewer.addEventListener(
    'wheel',
    (e) => {
      if (!(e.ctrlKey || e.metaKey) || !pdfDoc) return;
      e.preventDefault();
      const cur = currentScale();
      const next = Math.min(4, Math.max(0.25, cur * (e.deltaY < 0 ? 1.1 : 1 / 1.1)));
      state.zoom = Math.round(next * 100) / 100;
      updateZoomLabel();
      clearTimeout(wheelTimer);
      wheelTimer = setTimeout(() => setZoom(state.zoom), 120);
    },
    { passive: false }
  );
  let wheelTimer;

  let resizeTimer;
  let lastWidth = viewer.clientWidth;
  new ResizeObserver(() => {
    if (state.zoom !== 'fit' || viewer.clientWidth === lastWidth) return;
    lastWidth = viewer.clientWidth;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => layout('ratio'), 150);
  }).observe(viewer);

  let scrollTimer;
  viewer.addEventListener('scroll', () => {
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(saveState, 200);
  });

  function saveState() {
    state.anchor = viewer.scrollHeight ? viewer.scrollTop / viewer.scrollHeight : 0;
    vscode.setState(state);
  }

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (msg.type === 'pdf') {
      loadPdf(msg.data).catch((err) => {
        setStatus({ state: 'error', message: 'Could not display PDF: ' + err.message });
      });
    } else if (msg.type === 'scrollTo') {
      showLocation(msg);
    } else if (msg.type === 'status') {
      setStatus(msg);
    }
  });

  updateZoomLabel();
  vscode.postMessage({ type: 'ready' });
})();
