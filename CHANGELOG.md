# Changelog

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
