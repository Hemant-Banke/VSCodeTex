# Changelog

## 1.2.1
- README: new introduction with a quick start, features grouped into Preview, Writing and Working together, and an updated overview screenshot.
- New Marketplace description.

## 1.2.0
- **Comments and tracked changes**, without changing your LaTeX: comment threads with replies, editing and resolve in VS Code's Comments UI; Track Changes records your edits as suggestions that anyone can accept or reject. Review data lives in `.texreview/` (one file per person, so it never conflicts) and is shared through the Overleaf or Git sync.
- Right-click menu shows only what applies where you click: Accept/Reject on a tracked change, Add Comment on a selection, heading and environment actions where they make sense.
- Toggle `\[ \]` and `equation*` no longer converts numbered equations (which would drop their number and label).
- An empty comment draft shows a single discard button.

## 1.1.0
- **Suggestions:** `\cite` keys (from `.bib` files or `thebibliography`), `\ref` labels with their printed numbers, commands and your own macros, environments (with the matching `\end`), file paths, packages, `@` Greek/math shortcuts, and `BEQ` / `FIT`-style shortcuts.
- **Hover previews:** rendered math (with your macros), citation details, referenced equations and captions, figure thumbnails (including PDF figures), package documentation links, and command descriptions.
- **Outline, breadcrumbs and Go to Symbol** for sections, figures, tables and frames; **folding** of sections, environments, comments and regions; **Expand Selection** through math and environments; linked editing of `\begin`/`\end` names.
- **Editing commands** (⌃L / Alt+L, then a key): bold, italic, emphasis, typewriter, underline (press again to remove; math variants inside math), surround with a command or environment, close the current environment, toggle `\[ \]` and `equation*`, jump between `\begin` and `\end`.
- `\item` lists continue when you press Enter, and an empty `\item` ends the list.
- **Format Document** for `.tex` (latexindent, or built-in re-indenting) and `.bib`.
- Duplicate-label warnings, and optional ChkTeX linting (`texPreview.chktex`).
- **TeX: Count Words**, **TeX: Stop Compiling** and **TeX: Clean Auxiliary Files**.
- The main file is found automatically, without a `% !TEX root` comment.
- Custom build command (`texPreview.buildCommand`), Docker builds (`texPreview.docker.image`), and `.rnw` / `.jnw` documents.
- Dark PDF mode (◐ in the preview, or `texPreview.invertPdf`).
- **Live preview in a web browser** (↗ in the preview), with SyncTeX both ways.
- **Sections** menu in the preview; the Outline numbers headings as the PDF does (including appendices) and lists theorems, the abstract and references.
- **Symbols palette** in the bottom panel and **TeX: Insert Symbol…**, with about 300 symbols, structures and blocks; symbol glyphs in suggestions and hovers.
- Word count in the status bar, with characters, formulas and a per-file breakdown.
- More editing keys: small caps, footnote, inline math, toggle `*`, promote/demote headings; a **LaTeX** submenu in the editor's right-click menu; the **TeX** status bar menu.
- External PDF viewer with forward search (`texPreview.externalViewer.*`).
- Runs on the remote side in Remote SSH, WSL and Dev Containers.

## 1.0.0
First public release on the VS Code Marketplace and Open VSX.

## 0.4.1
- Jumping to the PDF from a line inside display math now highlights the whole formula.
- Each compile error is listed once (previously it could appear twice, from the log and from the compiler's output).
- README with screenshots of every feature.

## 0.4.0
- **Two-way Overleaf sync** over Overleaf's Git integration: saves are pushed, Overleaf changes are pulled every minute and when the window regains focus, unsaved edits are protected, and conflicts open in VS Code's merge editor.
- **Overleaf: Clone Project…** command; the Git token is kept in VS Code's secret storage.

## 0.3.0
- Select and copy text in the PDF.
- Jumping to the PDF highlights the target line only once scrolling has finished, and keeps the highlight visible for about 2 seconds.
- New extension icon.

## 0.2.0
- Double-click the PDF to jump to the source (SyncTeX), selecting the clicked word.
- **Jump to Location in PDF** (⌥⌘J / Ctrl+Alt+J).
- Clickable links in the PDF: internal references scroll, URLs open in the browser.
- Open the preview from the Explorer, editor and tab right-click menus.

## 0.1.0
- First version: side-by-side PDF preview that recompiles on save, with latexmk, tectonic or pdflatex, and clickable errors.
