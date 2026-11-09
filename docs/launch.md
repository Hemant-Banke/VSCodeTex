# Launch kit (drafts, not published)

Post after the next release is live on both the Marketplace and Open VSX. Space the posts over
a week rather than one day, and reply to every comment in the first few hours.

## The demo GIF

`docs/images/demo.gif` is at the top of the README: typing a sentence, ⌃L ⇧C with an arXiv
link, saving so the PDF rebuilds with the new reference, then ⌥⌘J to the highlighted line.

For a longer launch video (30–60 s, for Reddit, X or YouTube), also show: **TeX: New LaTeX
Project…** → *Thesis*; pasting a screenshot of an equation and choosing *Convert image to LaTeX
with AI*; double-clicking the PDF to jump to the source; and a tracked change being accepted.

## Show HN

**Title:** Show HN: Overleaf-style LaTeX in VS Code and Cursor, with live PDF, SyncTeX and AI

**Text:**
I write papers in VS Code but missed Overleaf's side-by-side PDF and review tools, so I built an
extension for that. Save and the PDF updates beside the source; double-click the PDF to jump to
the source line. It also does comments and tracked changes stored as plain files next to the
project (so they sync through Git or Overleaf), two-way sync with Overleaf projects, citations
from a DOI/arXiv id/Zotero, pasting screenshots as figures, and optional AI rewriting/review that
arrives as tracked changes (Copilot, your Claude or ChatGPT subscription, or a local model via
Ollama). If you have no TeX installed, it can install Tectonic for you in one click.

It's MIT-licensed, runs locally, and nothing leaves your machine unless you turn on the AI or
LanguageTool features. Feedback very welcome, especially from people coming from LaTeX Workshop
or Overleaf.

Marketplace: https://marketplace.visualstudio.com/items?itemName=HemantBanke.tex-side-preview
Open VSX: https://open-vsx.org/extension/HemantBanke/tex-side-preview
Source: https://github.com/Hemant-Banke/VSCodeTex

## r/LaTeX

**Title:** I made a free VS Code / Cursor extension that feels like Overleaf: live PDF, SyncTeX, comments and tracked changes, Overleaf sync

**Body:** (GIF first) Same as the HN text, shorter, plus: "Works with TeX Live, MiKTeX, MacTeX or
Tectonic; thesis/Beamer/IEEE/ACM templates included. What's missing for your workflow?"

## r/vscode

**Title:** LaTeX in VS Code with a live side-by-side PDF, Overleaf sync and Copilot agent tools

Lead with the agent angle: "Copilot agent mode can now compile your paper, read the errors with
file and line, and fix them; it can also look up your labels and add references by DOI."

## Short post (Bluesky / Mastodon / X / LinkedIn)

Writing a paper or thesis in VS Code or Cursor? TeX Side Preview gives you Overleaf's side-by-side
PDF, double-click-to-source, comments and tracked changes, two-way Overleaf sync, citations from a
DOI, and AI help that arrives as tracked changes. Free and open source. [GIF] [link]

Tags: #LaTeX #AcademicTwitter #PhDChat #VSCode

## Other places

- Open a PR adding it to awesome lists: `egeerardyn/awesome-LaTeX`, `viatsko/awesome-vscode`.
- Answer existing questions where it genuinely fits ("Overleaf alternative offline", "LaTeX in
  Cursor", "SyncTeX VS Code") on TeX.StackExchange, Stack Overflow and Reddit, disclosing that you
  wrote it.
- University LaTeX guides and thesis-template repos often list editors; ask to be included.
- Ask colleagues and early users who actually use it for honest ratings; reply to every review.
