'use strict';

// TeX: New LaTeX Project… — starter projects that build out of the box with TeX Live, MiKTeX or
// Tectonic. Each template is a map of relative path → file contents; main.tex is opened.

const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const os = require('os');

const r = String.raw;

const REFS = r`@article{knuth1984,
  author  = {Donald E. Knuth},
  title   = {Literate Programming},
  journal = {The Computer Journal},
  volume  = {27},
  number  = {2},
  pages   = {97--111},
  year    = {1984},
  doi     = {10.1093/comjnl/27.2.97},
}

@book{lamport1994,
  author    = {Leslie Lamport},
  title     = {{\LaTeX}: A Document Preparation System},
  edition   = {2},
  publisher = {Addison-Wesley},
  year      = {1994},
}
`;

const TEMPLATES = [
  {
    id: 'article',
    label: '$(file-text) Article',
    detail: 'A paper or report: sections, math, a figure and a bibliography',
    files: {
      'main.tex': r`\documentclass[11pt]{article}

\usepackage[margin=1in]{geometry}
\usepackage{amsmath, amssymb, amsthm}
\usepackage{graphicx}
\usepackage{booktabs}
\usepackage[numbers]{natbib}
\usepackage{hyperref}

\newtheorem{theorem}{Theorem}

\title{Your Title}
\author{Your Name}
\date{\today}

\begin{document}

\maketitle

\begin{abstract}
One paragraph that says what you did and why it matters.
\end{abstract}

\section{Introduction}
\label{sec:intro}

Start writing here. Cite related work like this \citep{knuth1984}, and refer to
Equation~\eqref{eq:euler} or Section~\ref{sec:method}.

\section{Method}
\label{sec:method}

\begin{equation}
  e^{i\pi} + 1 = 0
  \label{eq:euler}
\end{equation}

\begin{theorem}
  Every bounded monotone sequence of real numbers converges.
\end{theorem}

\begin{table}[htbp]
  \centering
  \begin{tabular}{lrr}
    \toprule
    Method & Accuracy & Time (s) \\
    \midrule
    Baseline & 0.81 & 12 \\
    Ours     & 0.87 & 9  \\
    \bottomrule
  \end{tabular}
  \caption{Results.}
  \label{tab:results}
\end{table}

\section{Conclusion}

Summarise the findings.

\bibliographystyle{plainnat}
\bibliography{refs}

\end{document}
`,
      'refs.bib': REFS,
    },
  },
  {
    id: 'thesis',
    label: '$(book) Thesis or dissertation',
    detail: 'Chapters in their own files, title page, contents, bibliography',
    files: {
      'main.tex': r`\documentclass[12pt, a4paper, oneside]{report}

\usepackage[margin=2.5cm]{geometry}
\usepackage{amsmath, amssymb, amsthm}
\usepackage{graphicx}
\usepackage{booktabs}
\usepackage[numbers]{natbib}
\usepackage{hyperref}

\graphicspath{{figures/}}

\begin{document}

\begin{titlepage}
  \centering
  \vspace*{3cm}
  {\Huge\bfseries Thesis Title\par}
  \vspace{2cm}
  {\Large Your Name\par}
  \vspace{1cm}
  A thesis submitted for the degree of\\Doctor of Philosophy\par
  \vfill
  {\large University Name\\\today\par}
\end{titlepage}

\begin{abstract}
  Summarise the thesis in one page.
\end{abstract}

\tableofcontents

\include{chapters/introduction}
\include{chapters/background}

\bibliographystyle{plainnat}
\bibliography{refs}

\end{document}
`,
      'chapters/introduction.tex': r`\chapter{Introduction}
\label{ch:intro}

Each chapter lives in its own file. Save any file and the whole thesis rebuilds;
double-click the PDF to jump back here. Chapter~\ref{ch:background} reviews prior work.
`,
      'chapters/background.tex': r`\chapter{Background}
\label{ch:background}

Literate programming \citep{knuth1984} and \LaTeX{} \citep{lamport1994}.
`,
      'figures/.gitkeep': '',
      'refs.bib': REFS,
    },
  },
  {
    id: 'beamer',
    label: '$(preview) Presentation (Beamer)',
    detail: 'Slides with sections, columns, math and a final slide',
    files: {
      'main.tex': r`\documentclass{beamer}

\usetheme{Madrid}
\usepackage{amsmath}
\usepackage{graphicx}

\title{Talk Title}
\author{Your Name}
\institute{Your Institution}
\date{\today}

\begin{document}

\begin{frame}
  \titlepage
\end{frame}

\begin{frame}{Outline}
  \tableofcontents
\end{frame}

\section{Motivation}

\begin{frame}{Why this matters}
  \begin{itemize}
    \item<1-> First point
    \item<2-> Second point appears on the next click
  \end{itemize}
\end{frame}

\section{Results}

\begin{frame}{Two columns}
  \begin{columns}
    \column{0.5\textwidth}
    Text on the left.
    \column{0.5\textwidth}
    \[
      \int_0^1 x^2 \, dx = \frac{1}{3}
    \]
  \end{columns}
\end{frame}

\begin{frame}
  \centering\Large Thank you! Questions?
\end{frame}

\end{document}
`,
    },
  },
  {
    id: 'cv',
    label: '$(person) CV / résumé',
    detail: 'One page, clean sections, no extra packages to install',
    files: {
      'main.tex': r`\documentclass[10pt]{article}

\usepackage[margin=0.8in]{geometry}
\usepackage{enumitem}
\usepackage[hidelinks]{hyperref}

\pagestyle{empty}
\setlength{\parindent}{0pt}
\setlist[itemize]{leftmargin=*, itemsep=1pt, topsep=2pt}

\newcommand{\cvsection}[1]{\vspace{10pt}{\large\bfseries #1}\par\vspace{2pt}\hrule\vspace{6pt}}
\newcommand{\cventry}[4]{\textbf{#1} \hfill #2\par\textit{#3}\par\vspace{2pt}#4\vspace{6pt}}

\begin{document}

{\LARGE\bfseries Your Name}\par
\vspace{4pt}
City, Country \quad\textbullet\quad \href{mailto:you@example.com}{you@example.com} \quad\textbullet\quad \href{https://example.com}{example.com}

\cvsection{Education}
\cventry{PhD in Your Field}{2021--present}{University Name}{}
\cventry{BSc in Your Field}{2017--2021}{University Name}{First-class honours.}

\cvsection{Experience}
\cventry{Research Intern}{Summer 2023}{Company or Lab}{
\begin{itemize}
  \item What you built, and its measurable result.
  \item Another achievement.
\end{itemize}}

\cvsection{Publications}
\begin{itemize}
  \item Your Name and Co-author. \textit{Paper Title}. Venue, 2024.
\end{itemize}

\cvsection{Skills}
Python, \LaTeX, data analysis.

\end{document}
`,
    },
  },
  {
    id: 'homework',
    label: '$(checklist) Homework / problem set',
    detail: 'Numbered problems and solutions with math',
    files: {
      'main.tex': r`\documentclass[11pt]{article}

\usepackage[margin=1in]{geometry}
\usepackage{amsmath, amssymb, amsthm}

\newtheorem{problem}{Problem}
\newenvironment{solution}{\begin{proof}[Solution]}{\end{proof}}

\title{Course Name --- Homework 1}
\author{Your Name}
\date{\today}

\begin{document}
\maketitle

\begin{problem}
  Show that $\sum_{k=1}^{n} k = \frac{n(n+1)}{2}$.
\end{problem}

\begin{solution}
  By induction on $n$. For $n = 1$ both sides equal $1$. If it holds for $n$, then
  \[
    \sum_{k=1}^{n+1} k = \frac{n(n+1)}{2} + (n+1) = \frac{(n+1)(n+2)}{2}.
  \]
\end{solution}

\begin{problem}
  Next problem.
\end{problem}

\begin{solution}
  Your answer.
\end{solution}

\end{document}
`,
    },
  },
  {
    id: 'letter',
    label: '$(mail) Letter',
    detail: 'Cover letter or formal letter',
    files: {
      'main.tex': r`\documentclass[11pt]{letter}

\usepackage[margin=1in]{geometry}

\signature{Your Name}
\address{Your Street \\ City, Postcode \\ you@example.com}

\begin{document}

\begin{letter}{Hiring Committee \\ Organisation \\ Street \\ City}

\opening{Dear Hiring Committee,}

I am writing to apply for the position of \ldots

\closing{Yours sincerely,}

\end{letter}

\end{document}
`,
    },
  },
  {
    id: 'ieee',
    label: '$(mortar-board) IEEE conference paper',
    detail: 'IEEEtran, two columns',
    files: {
      'main.tex': r`\documentclass[conference]{IEEEtran}

\usepackage{amsmath, amssymb}
\usepackage{graphicx}
\usepackage{cite}

\begin{document}

\title{Paper Title}

\author{\IEEEauthorblockN{Your Name}
\IEEEauthorblockA{Department, University\\
City, Country\\
you@example.com}}

\maketitle

\begin{abstract}
Abstract of up to about 200 words.
\end{abstract}

\begin{IEEEkeywords}
keyword one, keyword two
\end{IEEEkeywords}

\section{Introduction}
Background and contributions \cite{knuth1984}.

\section{Method}
\begin{equation}
  y = f(x) + \varepsilon
  \label{eq:model}
\end{equation}

\section{Conclusion}
Summary.

\bibliographystyle{IEEEtran}
\bibliography{refs}

\end{document}
`,
      'refs.bib': REFS,
    },
  },
  {
    id: 'acm',
    label: '$(mortar-board) ACM conference paper',
    detail: 'acmart, sigconf format',
    files: {
      'main.tex': r`\documentclass[sigconf]{acmart}

\setcopyright{none}
\settopmatter{printacmref=false}

\begin{document}

\title{Paper Title}

\author{Your Name}
\affiliation{%
  \institution{University Name}
  \city{City}
  \country{Country}}
\email{you@example.com}

\begin{abstract}
Abstract.
\end{abstract}

\keywords{keyword one, keyword two}

\maketitle

\section{Introduction}
Background and contributions \cite{knuth1984}.

\section{Conclusion}
Summary.

\bibliographystyle{ACM-Reference-Format}
\bibliography{refs}

\end{document}
`,
      'refs.bib': REFS,
    },
  },
];

// Chinese templates: ctex classes, XeLaTeX (set by the % !TEX program line) and GB/T 7714-2015
// references, which Chinese journals and theses require. ctex picks fonts that exist on the
// computer it builds on (fontset is left unset on purpose).
const ZH_REFS = r`@article{wang2020,
  author  = {王小明 and 李华},
  title   = {深度学习在图像识别中的应用},
  journal = {计算机学报},
  volume  = {43},
  number  = {5},
  pages   = {1--10},
  year    = {2020},
}

@article{knuth1984,
  author  = {Donald E. Knuth},
  title   = {Literate Programming},
  journal = {The Computer Journal},
  volume  = {27},
  number  = {2},
  pages   = {97--111},
  year    = {1984},
  doi     = {10.1093/comjnl/27.2.97},
}
`;

const ZH_TEMPLATES = [
  {
    id: 'zh-article',
    label: '$(file-text) Chinese article · 中文论文',
    detail: 'ctexart, XeLaTeX, GB/T 7714 references',
    files: {
      'main.tex': r`% !TEX program = xelatex
\documentclass[UTF8, a4paper, zihao=-4]{ctexart}

\usepackage[margin=2.5cm]{geometry}
\usepackage{amsmath, amssymb, amsthm}
\usepackage{graphicx}
\usepackage{booktabs}
\usepackage{gbt7714}
\usepackage{hyperref}

\newtheorem{theorem}{定理}
\bibliographystyle{gbt7714-numerical}

\title{论文题目}
\author{作者姓名\\ 单位名称}
\date{\today}

\begin{document}

\maketitle

\begin{abstract}
摘要内容。简要说明研究目的、方法、结果和结论。

\textbf{关键词：}关键词一；关键词二；关键词三
\end{abstract}

\section{引言}
研究背景与主要贡献\cite{wang2020,knuth1984}。

\section{方法}
模型如式~\eqref{eq:model} 所示：
\begin{equation}
  y = f(x) + \varepsilon
  \label{eq:model}
\end{equation}

\begin{theorem}
定理内容。
\end{theorem}

\section{实验}
\begin{table}[htbp]
  \centering
  \caption{实验结果}
  \begin{tabular}{lcc}
    \toprule
    方法 & 准确率 & 时间 \\
    \midrule
    基线 & 0.85 & 1.2 \\
    本文 & 0.92 & 1.0 \\
    \bottomrule
  \end{tabular}
\end{table}

\section{结论}
总结全文。

\bibliography{refs}

\end{document}
`,
      'refs.bib': ZH_REFS,
    },
  },
  {
    id: 'zh-thesis',
    label: '$(book) Chinese thesis · 中文学位论文',
    detail: 'ctexbook, chapters in their own files, 摘要 / Abstract, 目录, GB/T 7714, 致谢',
    files: {
      'main.tex': r`% !TEX program = xelatex
\documentclass[UTF8, a4paper, oneside, zihao=-4]{ctexbook}

\usepackage[margin=2.5cm]{geometry}
\usepackage{amsmath, amssymb, amsthm}
\usepackage{graphicx}
\usepackage{booktabs}
\usepackage{gbt7714}
\usepackage{hyperref}

\graphicspath{{figures/}}
\bibliographystyle{gbt7714-numerical}

\begin{document}

\frontmatter
\begin{titlepage}
  \centering
  \vspace*{3cm}
  {\zihao{2}\heiti 论文题目\par}
  \vspace{2cm}
  {\zihao{4} 作者姓名\par}
  \vspace{0.5cm}
  {\zihao{4} 指导教师：教师姓名\par}
  \vfill
  {\zihao{4} 学院名称\par}
  {\zihao{4} \today\par}
\end{titlepage}

\include{chapters/abstract}
\tableofcontents

\mainmatter
\include{chapters/introduction}
\include{chapters/method}
\include{chapters/conclusion}

\backmatter
\cleardoublepage
\phantomsection
\addcontentsline{toc}{chapter}{参考文献}
\bibliography{refs}
\include{chapters/acknowledgements}

\end{document}
`,
      'chapters/abstract.tex': r`\chapter{摘要}
摘要内容。

\textbf{关键词：}关键词一；关键词二

\chapter*{Abstract}
\addcontentsline{toc}{chapter}{Abstract}
The abstract in English.

\textbf{Keywords:} keyword one; keyword two
`,
      'chapters/introduction.tex': r`\chapter{绪论}
\label{chap:intro}

\section{研究背景}
研究背景\cite{wang2020}。

\section{本文结构}
第~\ref{chap:method}~章介绍方法，第~\ref{chap:conclusion}~章总结全文。
`,
      'chapters/method.tex': r`\chapter{研究方法}
\label{chap:method}

模型定义如下\cite{knuth1984}：
\begin{equation}
  y = f(x) + \varepsilon
\end{equation}
`,
      'chapters/conclusion.tex': r`\chapter{总结与展望}
\label{chap:conclusion}

全文总结。
`,
      'chapters/acknowledgements.tex': r`\chapter{致谢}
感谢导师的悉心指导。
`,
      'refs.bib': ZH_REFS,
      'figures/.gitkeep': '',
    },
  },
  {
    id: 'zh-beamer',
    label: '$(device-desktop) Chinese slides · 中文幻灯片',
    detail: 'ctexbeamer, XeLaTeX, 16:9',
    files: {
      'main.tex': r`% !TEX program = xelatex
\documentclass[aspectratio=169, UTF8]{ctexbeamer}

\usetheme{Madrid}

\title{报告题目}
\author{报告人}
\institute{单位名称}
\date{\today}

\begin{document}

\begin{frame}
  \titlepage
\end{frame}

\begin{frame}{目录}
  \tableofcontents
\end{frame}

\section{研究背景}
\begin{frame}{研究背景}
  \begin{itemize}
    \item 第一点
    \item 第二点
  \end{itemize}
\end{frame}

\section{方法}
\begin{frame}{方法}
  \begin{block}{核心公式}
    \[ y = f(x) + \varepsilon \]
  \end{block}
\end{frame}

\section{总结}
\begin{frame}{总结}
  谢谢！
\end{frame}

\end{document}
`,
    },
  },
  {
    id: 'zh-cv',
    label: '$(person) Chinese CV · 中文简历',
    detail: 'One page, ctexart, XeLaTeX',
    files: {
      'main.tex': r`% !TEX program = xelatex
\documentclass[UTF8, zihao=5]{ctexart}

\usepackage[margin=1.8cm]{geometry}
\usepackage{enumitem}
\usepackage[hidelinks]{hyperref}

\pagestyle{empty}
\setlength{\parindent}{0pt}
\setlist[itemize]{leftmargin=*, itemsep=1pt, topsep=2pt}
\ctexset{section/format = \large\bfseries\raggedright}

\newcommand{\cvsection}[1]{\vspace{8pt}{\large\heiti #1}\par\vspace{2pt}\hrule\vspace{6pt}}
\newcommand{\cventry}[4]{\textbf{#1} \hfill #2\par\textit{#3}\par\vspace{2pt}#4\vspace{6pt}}

\begin{document}

{\zihao{2}\heiti 姓名}\par\vspace{4pt}
电话：138-0000-0000 \quad 邮箱：\href{mailto:you@example.com}{you@example.com} \quad 主页：\url{https://example.com}

\cvsection{教育背景}
\cventry{某某大学}{2020 -- 2024}{计算机科学与技术 \quad 工学学士}{GPA：3.8/4.0}

\cvsection{项目经历}
\cventry{项目名称}{2023}{负责人}{%
\begin{itemize}
  \item 项目内容与个人贡献。
  \item 取得的成果。
\end{itemize}}

\cvsection{专业技能}
\begin{itemize}
  \item 编程语言：Python、C++
  \item 语言能力：英语（CET-6）
\end{itemize}

\end{document}
`,
    },
  },
];

const OPEN_KEY = 'texPreview.openOnStart';

/** Asks for a template and a place, writes the project and opens it with its preview. */
async function newProject(context) {
  const items = [...TEMPLATES, { label: 'Chinese · 中文', kind: vscode.QuickPickItemKind.Separator }, ...ZH_TEMPLATES];
  const tpl = await vscode.window.showQuickPick(items, { title: 'New LaTeX project (1/2): template', matchOnDetail: true });
  if (!tpl) return;
  const ws = vscode.workspace.workspaceFolders?.[0];
  const parent = await vscode.window.showOpenDialog({
    title: 'New LaTeX project (2/2): where to create its folder',
    canSelectFiles: false,
    canSelectFolders: true,
    openLabel: 'Create Here',
    defaultUri: ws ? ws.uri : vscode.Uri.file(path.join(os.homedir(), 'Documents')),
  });
  if (!parent || !parent[0]) return;
  const name = await vscode.window.showInputBox({
    title: 'Project folder name',
    value: `my-${tpl.id}`,
    ignoreFocusOut: true,
    validateInput: (v) => (!v.trim() ? 'Required' : /[\\/:*?"<>|]/.test(v) ? 'Use a plain folder name' : fs.existsSync(path.join(parent[0].fsPath, v.trim())) ? 'That folder already exists' : null),
  });
  if (!name) return;
  const dir = path.join(parent[0].fsPath, name.trim());
  try {
    for (const [rel, text] of Object.entries(tpl.files)) {
      const file = path.join(dir, ...rel.split('/'));
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text);
    }
  } catch (e) {
    return vscode.window.showErrorMessage(`Couldn't create the project: ${e.message}`);
  }
  const main = path.join(dir, 'main.tex');
  const inWorkspace = (vscode.workspace.workspaceFolders || []).some((f) => !path.relative(f.uri.fsPath, dir).startsWith('..'));
  if (inWorkspace) return openWithPreview(main);
  const choice = await vscode.window.showInformationMessage(`Created ${name.trim()}.`, 'Open', 'Open in New Window', 'Add to Workspace');
  if (!choice) return;
  if (choice === 'Add to Workspace') {
    vscode.workspace.updateWorkspaceFolders((vscode.workspace.workspaceFolders || []).length, 0, { uri: vscode.Uri.file(dir) });
    return openWithPreview(main);
  }
  // Opening a folder restarts the extension host; open main.tex with its preview once it's back.
  await context.globalState.update(OPEN_KEY, main);
  await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(dir), choice === 'Open in New Window');
}

async function openWithPreview(file) {
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
  await vscode.window.showTextDocument(doc, { preview: false });
  await vscode.commands.executeCommand('texPreview.open', doc.uri);
}

function activate(context) {
  context.subscriptions.push(vscode.commands.registerCommand('texPreview.newProject', () => newProject(context)));
  // A project created just before its folder was opened.
  const pending = context.globalState.get(OPEN_KEY);
  if (pending) {
    const here = (vscode.workspace.workspaceFolders || []).some((f) => !path.relative(f.uri.fsPath, pending).startsWith('..'));
    if (here && fs.existsSync(pending)) {
      context.globalState.update(OPEN_KEY, undefined);
      setTimeout(() => openWithPreview(pending).catch(() => {}), 500);
    }
  }
}

module.exports = { activate, TEMPLATES, ZH_TEMPLATES };
