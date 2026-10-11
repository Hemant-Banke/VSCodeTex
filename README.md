# TeX Side Preview

Overleaf-style LaTeX editing in VS Code: the source is on the left and the PDF on the right. **Save the file and the preview re-renders.**

## Usage

1. Open a `.tex` file.
2. Open the preview in any of these ways:
   * the preview button in the editor title bar
   * right-click the `.tex` file in the Explorer → **Open TeX Preview to the Side**
   * right-click in the editor or on its tab
   * **⌘⌥V** / **Ctrl+Alt+V**
3. Edit, then save (**⌘S**). The PDF recompiles and refreshes in place, keeping your scroll position.

* **Double-click in the PDF** jumps the editor to that spot in the source and selects the word you clicked (SyncTeX).
* **⌘⌥J / Ctrl+Alt+J** (or right-click → *Jump to Location in PDF*) goes the other way: it scrolls the PDF to the cursor's line, then highlights that line for a couple of seconds.
* Select and copy text in the PDF as usual (drag, then **⌘C / Ctrl+C**).
* Links in the PDF work: `\ref`, `\cite`, table-of-contents and footnote links scroll within the PDF, and URLs open in your browser.

* **⌘↵ / Ctrl+Enter** in the editor saves and recompiles.
* Errors show at the top of the preview; click one to jump to the line. They also show in the Problems panel.
* When a compile fails, the preview keeps the last good PDF.
* Zoom with the **− / Fit / +** buttons or ⌘/Ctrl + mouse wheel.
* Multi-file projects: put `% !TEX root = main.tex` at the top of included files. Saving any `.tex/.bib/.sty/.cls` file under the root's folder recompiles the root.

## Overleaf sync (two-way, over Git)

This needs an Overleaf plan with **Git integration** (premium or institutional).

1. On overleaf.com go to **Account Settings → Git Integration → Create token**.
2. In VS Code run **Overleaf: Clone Project…** (⌘⇧P). Paste the project URL (e.g. `https://www.overleaf.com/project/65f0…`), then your token, then pick a folder.
3. Open the cloned folder. From then on syncing happens automatically:
   * **Your saves are pushed** about 2 seconds after you save. Creating, deleting and renaming files in the Explorer also sync.
   * **Overleaf changes are pulled** every 60 seconds, and whenever the VS Code window regains focus. Open editors update, and the preview recompiles.
   * **If a file has unsaved edits** and Overleaf changed that same file, the pull waits until you save, so nothing changes under your cursor.
   * **If both sides changed the same lines**, the conflict opens in VS Code's merge editor and the status bar shows *Overleaf: conflict*. Resolve it and save, and syncing continues.

The **Overleaf** item in the status bar shows the sync state. Click it to *Sync Now*, *Pause/Resume*, *Open Project on Overleaf*, change the token, or view the sync log.

Notes:
* The token is kept in VS Code's secret storage and handed to git through environment variables, never written to `.git/config`.
* Build output (`.texbuild/`) is excluded through `.git/info/exclude`, so it never reaches Overleaf and the project's own files stay untouched.
* A folder you cloned yourself (`git clone https://git.overleaf.com/<id>`) is detected and synced too.

## Requirements

You need a LaTeX compiler. The extension uses the first one it finds:

| Compiler | Install (macOS) | Notes |
|---|---|---|
| `latexmk` | `brew install --cask mactex-no-gui` | Full TeX Live. Fastest incremental builds; handles BibTeX/Biber. |
| `tectonic` | `brew install tectonic` | Small single binary that downloads packages on first use. |
| `pdflatex` | (part of TeX Live / MiKTeX) | Fallback. Runs BibTeX and reruns as needed. |

It also searches `/Library/TeX/texbin`, `/opt/homebrew/bin`, `/usr/local/texlive/*/bin/*` and others, so it still works when VS Code is launched from the Dock.

## Settings

| Setting | Default | |
|---|---|---|
| `texPreview.engine` | `auto` | `latexmk`, `tectonic`, `pdflatex`, `xelatex`, `lualatex` |
| `texPreview.latexmkEngine` | `pdf` | `pdf`, `xelatex`, `lualatex` (when using latexmk) |
| `texPreview.outDir` | `.texbuild` | Where the PDF and aux files go, relative to the root `.tex` |
| `texPreview.compileOnSave` | `true` | |
| `texPreview.extraPath` | `[]` | Extra folders to search for TeX binaries |
| `texPreview.overleaf.autoSync` | `true` | Two-way sync for Overleaf Git clones |
| `texPreview.overleaf.pullInterval` | `60` | Seconds between checks for Overleaf changes (min 15) |
| `texPreview.overleaf.pushDelay` | `2` | Seconds after a save before pushing |

## Building from source

```sh
npm install
npx @vscode/vsce package     # -> tex-side-preview-<version>.vsix
code --install-extension tex-side-preview-<version>.vsix
```

Or open this folder in VS Code and press **F5** to start an Extension Development Host.
