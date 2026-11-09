# A LaTeX compiler

TeX Side Preview builds with whichever of these it finds first:

| | |
|---|---|
| **latexmk** | Comes with TeX Live, MacTeX and MiKTeX. Runs BibTeX/Biber and reruns as needed. |
| **Tectonic** | One small program. Downloads only the packages a document uses, on its first build. |
| **pdflatex** | Any TeX distribution. |

**No TeX installed?** *Install Tectonic* on the left downloads it for this extension only (about 20 MB, checked against its published checksum). Nothing else on your system changes.

**Want the full distribution?**

- macOS: `brew install --cask mactex-no-gui`
- Windows: [MiKTeX](https://miktex.org/download) or [TeX Live](https://tug.org/texlive/windows.html)
- Linux: `sudo apt install texlive-full latexmk`

You can also build in Docker (`texPreview.docker.image`) or with your own command (`texPreview.buildCommand`).
