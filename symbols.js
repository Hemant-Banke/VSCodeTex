'use strict';

// The symbol catalogue behind the Symbols palette, TeX: Insert Symbol…, completions and hovers.
// Each item: { tex, glyph, name, math, pkg }. `tex` is a snippet written with plain TeX
// backslashes ($1, ${1:x} placeholders allowed).

/** "cmd glyph cmd glyph …" → items (all plain math symbols). */
function pairs(spec, extra = {}) {
  const parts = spec.trim().split(/\s+/);
  const out = [];
  for (let i = 0; i < parts.length; i += 2) out.push({ tex: '\\' + parts[i], glyph: parts[i + 1], name: parts[i], math: true, ...extra });
  return out;
}

const s = (tex, glyph, name, opts = {}) => ({ tex, glyph, name, math: true, ...opts });
const t = (tex, glyph, name, opts = {}) => ({ tex, glyph, name, math: false, ...opts });

const CATEGORIES = [
  {
    name: 'Greek',
    items: pairs(
      'alpha α beta β gamma γ delta δ epsilon ϵ varepsilon ε zeta ζ eta η theta θ vartheta ϑ iota ι kappa κ lambda λ mu μ nu ν xi ξ pi π varpi ϖ rho ρ varrho ϱ sigma σ varsigma ς tau τ upsilon υ phi ϕ varphi φ chi χ psi ψ omega ω ' +
        'Gamma Γ Delta Δ Theta Θ Lambda Λ Xi Ξ Pi Π Sigma Σ Upsilon Υ Phi Φ Psi Ψ Omega Ω'
    ),
  },
  {
    name: 'Structures',
    items: [
      s('\\frac{$1}{$2}', 'a⁄b', 'fraction frac'),
      s('\\dfrac{$1}{$2}', 'a⁄b', 'display fraction dfrac', { pkg: 'amsmath' }),
      s('\\sqrt{$1}', '√x', 'square root sqrt'),
      s('\\sqrt[$1]{$2}', 'ⁿ√x', 'nth root sqrt'),
      s('^{$1}', 'xⁿ', 'superscript power'),
      s('_{$1}', 'xₙ', 'subscript index'),
      s('\\binom{$1}{$2}', '(ⁿₖ)', 'binomial binom', { pkg: 'amsmath' }),
      s('\\sum_{$1}^{$2}', '∑ⁿᵢ', 'sum with limits'),
      s('\\prod_{$1}^{$2}', '∏ⁿᵢ', 'product with limits'),
      s('\\int_{$1}^{$2}', '∫ᵇₐ', 'integral with limits'),
      s('\\lim_{${1:n \\to \\infty}}', 'lim', 'limit lim'),
      s('\\left( $1 \\right)', '( )', 'parentheses left right'),
      s('\\left[ $1 \\right]', '[ ]', 'brackets left right'),
      s('\\left\\{ $1 \\right\\}', '{ }', 'braces left right'),
      s('\\left| $1 \\right|', '| |', 'absolute value left right'),
      s('\\left\\| $1 \\right\\|', '‖ ‖', 'norm left right'),
      s('\\left\\langle $1 \\right\\rangle', '⟨ ⟩', 'angle brackets'),
      s('\\lfloor $1 \\rfloor', '⌊ ⌋', 'floor'),
      s('\\lceil $1 \\rceil', '⌈ ⌉', 'ceiling'),
      s('\\text{$1}', 'Tt', 'text in math', { pkg: 'amsmath' }),
      s('\\operatorname{$1}', 'op', 'operator name', { pkg: 'amsmath' }),
      s('\\overset{$1}{$2}', 'x̊', 'overset'),
      s('\\underset{$1}{$2}', 'x̥', 'underset'),
      s('\\boxed{$1}', '▭', 'boxed', { pkg: 'amsmath' }),
      s('\\begin{pmatrix}\n\t$1 & $2 \\\\\n\t$3 & $4\n\\end{pmatrix}', '(⋱)', 'matrix pmatrix', { pkg: 'amsmath', display: true }),
      s('\\begin{bmatrix}\n\t$1 & $2 \\\\\n\t$3 & $4\n\\end{bmatrix}', '[⋱]', 'matrix bmatrix', { pkg: 'amsmath', display: true }),
      s('\\begin{vmatrix}\n\t$1 & $2 \\\\\n\t$3 & $4\n\\end{vmatrix}', '|⋱|', 'determinant vmatrix', { pkg: 'amsmath', display: true }),
      s('\\begin{cases}\n\t$1 & \\text{if } $2 \\\\\n\t$3 & \\text{otherwise}\n\\end{cases}', '{⋮', 'cases piecewise', { pkg: 'amsmath', display: true }),
      s('\\begin{aligned}\n\t$1 &= $2 \\\\\n\t&= $3\n\\end{aligned}', '=⋮', 'aligned', { pkg: 'amsmath', display: true }),
    ],
  },
  {
    name: 'Accents',
    items: [
      s('\\hat{$1}', 'â', 'hat'),
      s('\\widehat{$1}', 'âb', 'widehat'),
      s('\\bar{$1}', 'ā', 'bar'),
      s('\\overline{$1}', 'āb', 'overline'),
      s('\\tilde{$1}', 'ã', 'tilde'),
      s('\\widetilde{$1}', 'ãb', 'widetilde'),
      s('\\vec{$1}', 'a⃗', 'vector arrow vec'),
      s('\\overrightarrow{$1}', 'AB⃗', 'overrightarrow'),
      s('\\dot{$1}', 'ȧ', 'dot'),
      s('\\ddot{$1}', 'ä', 'ddot'),
      s('\\check{$1}', 'ǎ', 'check'),
      s('\\breve{$1}', 'ă', 'breve'),
      s('\\acute{$1}', 'á', 'acute'),
      s('\\grave{$1}', 'à', 'grave'),
      s('\\underline{$1}', 'a̲', 'underline'),
      s('\\underbrace{$1}_{$2}', '⏟', 'underbrace'),
      s('\\overbrace{$1}^{$2}', '⏞', 'overbrace'),
    ],
  },
  {
    name: 'Fonts',
    items: [
      s('\\mathbb{$1}', 'ℝ', 'blackboard bold mathbb', { pkg: 'amssymb' }),
      s('\\mathcal{$1}', '𝒜', 'calligraphic mathcal'),
      s('\\mathscr{$1}', '𝒮', 'script mathscr', { pkg: 'mathrsfs' }),
      s('\\mathfrak{$1}', '𝔄', 'fraktur mathfrak', { pkg: 'amssymb' }),
      s('\\mathbf{$1}', '𝐀', 'bold mathbf'),
      s('\\boldsymbol{$1}', '𝜶', 'bold symbol boldsymbol', { pkg: 'amsmath' }),
      s('\\mathrm{$1}', 'A', 'roman upright mathrm'),
      s('\\mathit{$1}', '𝐴', 'italic mathit'),
      s('\\mathsf{$1}', '𝖠', 'sans serif mathsf'),
      s('\\mathtt{$1}', '𝙰', 'typewriter mathtt'),
      t('\\textbf{$1}', '𝐁', 'bold textbf'),
      t('\\textit{$1}', '𝐼', 'italic textit'),
      t('\\emph{$1}', '𝘌', 'emphasis emph'),
      t('\\underline{$1}', 'U̲', 'underline'),
      t('\\texttt{$1}', '𝚃', 'typewriter texttt'),
      t('\\textsc{$1}', 'Sᴄ', 'small caps textsc'),
      t('\\textsf{$1}', '𝖲', 'sans serif textsf'),
    ],
  },
  {
    name: 'Relations',
    items: [
      ...pairs(
        'leq ≤ geq ≥ neq ≠ approx ≈ equiv ≡ sim ∼ simeq ≃ cong ≅ propto ∝ ll ≪ gg ≫ prec ≺ succ ≻ preceq ⪯ succeq ⪰ ' +
          'subset ⊂ supset ⊃ subseteq ⊆ supseteq ⊇ in ∈ ni ∋ notin ∉ mid ∣ parallel ∥ perp ⊥ vdash ⊢ dashv ⊣ models ⊨ asymp ≍ doteq ≐'
      ),
      ...pairs('leqslant ⩽ geqslant ⩾ lesssim ≲ gtrsim ≳ triangleq ≜ nsubseteq ⊈ subsetneq ⊊', { pkg: 'amssymb' }),
      s('\\coloneqq', '≔', 'colon equals coloneqq', { pkg: 'mathtools' }),
    ],
  },
  {
    name: 'Operators',
    items: [
      ...pairs(
        'pm ± mp ∓ times × div ÷ cdot ⋅ ast ∗ star ⋆ circ ∘ bullet ∙ oplus ⊕ ominus ⊖ otimes ⊗ odot ⊙ ' +
          'cup ∪ cap ∩ setminus ∖ wedge ∧ vee ∨ sqcup ⊔ sqcap ⊓ dagger † ' +
          'sum ∑ prod ∏ coprod ∐ int ∫ oint ∮ bigcup ⋃ bigcap ⋂ bigoplus ⨁ bigotimes ⨂ bigvee ⋁ bigwedge ⋀'
      ),
      ...pairs('iint ∬ iiint ∭', { pkg: 'amsmath' }),
      ...pairs('log log ln ln exp exp sin sin cos cos tan tan arcsin asin arccos acos arctan atan sinh sinh cosh cosh tanh tanh det det dim dim ker ker deg deg gcd gcd max max min min sup sup inf inf arg arg Pr Pr'),
    ],
  },
  {
    name: 'Arrows',
    items: [
      ...pairs(
        'to → rightarrow → leftarrow ← leftrightarrow ↔ Rightarrow ⇒ Leftarrow ⇐ Leftrightarrow ⇔ longrightarrow ⟶ longleftarrow ⟵ Longrightarrow ⟹ Longleftrightarrow ⟺ ' +
          'mapsto ↦ longmapsto ⟼ uparrow ↑ downarrow ↓ updownarrow ↕ Uparrow ⇑ Downarrow ⇓ hookrightarrow ↪ hookleftarrow ↩ ' +
          'rightharpoonup ⇀ leftharpoonup ↼ rightleftharpoons ⇌ nearrow ↗ searrow ↘ swarrow ↙ nwarrow ↖ leadsto ⇝'
      ),
      ...pairs('implies ⟹ impliedby ⟸ iff ⟺', { pkg: 'amsmath' }),
      ...pairs('twoheadrightarrow ↠ rightrightarrows ⇉ circlearrowright ↻', { pkg: 'amssymb' }),
      s('\\xrightarrow{$1}', '→ˣ', 'arrow with label xrightarrow', { pkg: 'amsmath' }),
    ],
  },
  {
    name: 'Misc',
    items: [
      ...pairs(
        'infty ∞ partial ∂ nabla ∇ forall ∀ exists ∃ emptyset ∅ neg ¬ hbar ℏ ell ℓ Re ℜ Im ℑ aleph ℵ wp ℘ angle ∠ triangle △ prime ′ ' +
          'ldots … cdots ⋯ vdots ⋮ ddots ⋱ top ⊤ bot ⊥ flat ♭ sharp ♯ natural ♮ clubsuit ♣ heartsuit ♡ diamondsuit ♢ spadesuit ♠ ' +
          'langle ⟨ rangle ⟩ lfloor ⌊ rfloor ⌋ lceil ⌈ rceil ⌉ | ‖ backslash ∖'
      ),
      ...pairs('nexists ∄ varnothing ∅ square □ blacksquare ■ checkmark ✓ therefore ∴ because ∵ complement ∁ mho ℧', { pkg: 'amssymb' }),
      s('\\{', '{', 'left brace'),
      s('\\}', '}', 'right brace'),
      s('\\,', '␣', 'thin space'),
      s('\\quad', '␣␣', 'quad space'),
      s('\\qquad', '␣␣␣', 'qquad space'),
    ],
  },
  {
    name: 'Text',
    items: [
      t('\\footnote{$1}', '¹', 'footnote'),
      t('\\href{$1}{$2}', '🔗', 'hyperlink href', { pkg: 'hyperref' }),
      t('\\url{$1}', 'www', 'url', { pkg: 'hyperref' }),
      t("``$1''", '“ ”', 'quotes'),
      t('--', '–', 'en dash'),
      t('---', '—', 'em dash'),
      t('~', '⍽', 'non-breaking space'),
      t('\\ldots', '…', 'ellipsis ldots'),
      t('\\\\', '↵', 'line break'),
      t('\\S', '§', 'section sign'),
      t('\\P', '¶', 'paragraph sign'),
      t('\\dag', '†', 'dagger'),
      t('\\ddag', '‡', 'double dagger'),
      t('\\copyright', '©', 'copyright'),
      t('\\textregistered', '®', 'registered'),
      t('\\texttrademark', '™', 'trademark'),
      t('\\pounds', '£', 'pound sterling'),
      t('\\euro', '€', 'euro', { pkg: 'eurosym' }),
      t('\\textdegree', '°', 'degree', { pkg: 'textcomp' }),
      t('\\%', '%', 'percent'),
      t('\\&', '&', 'ampersand'),
      t('\\$', '$', 'dollar'),
      t('\\#', '#', 'hash'),
      t('\\_', '_', 'underscore'),
    ],
  },
  {
    name: 'Blocks',
    items: [
      t('\\begin{figure}[htbp]\n\t\\centering\n\t\\includegraphics[width=${1:0.8}\\linewidth]{$2}\n\t\\caption{$3}\n\t\\label{fig:$4}\n\\end{figure}', '🖼', 'figure', { block: true }),
      t('\\begin{table}[htbp]\n\t\\centering\n\t\\caption{$1}\n\t\\label{tab:$2}\n\t\\begin{tabular}{${3:l l}}\n\t\t\\toprule\n\t\t$4 \\\\\n\t\t\\midrule\n\t\t$5 \\\\\n\t\t\\bottomrule\n\t\\end{tabular}\n\\end{table}', '▦', 'table booktabs', { block: true, pkg: 'booktabs' }),
      t('\\begin{itemize}\n\t\\item $1\n\\end{itemize}', '•', 'bulleted list itemize', { block: true }),
      t('\\begin{enumerate}\n\t\\item $1\n\\end{enumerate}', '1.', 'numbered list enumerate', { block: true }),
      t('\\begin{equation}\n\t$1\n\t\\label{eq:$2}\n\\end{equation}', '(1)', 'numbered equation', { block: true }),
      t('\\begin{align}\n\t$1 &= $2 \\\\\n\t&= $3\n\\end{align}', '=⋮', 'aligned equations align', { block: true, pkg: 'amsmath' }),
      t('\\[\n\t$1\n\\]', '[x]', 'display math'),
      t('$$1$', '$x$', 'inline math'),
      t('\\begin{theorem}\n\t$1\n\\end{theorem}', 'Thm', 'theorem', { block: true }),
      t('\\begin{proof}\n\t$1\n\\end{proof}', '∎', 'proof', { block: true, pkg: 'amsthm' }),
      t('\\begin{minipage}{${1:0.48}\\linewidth}\n\t$2\n\\end{minipage}', '▯▯', 'minipage', { block: true }),
      t('\\begin{frame}{$1}\n\t$2\n\\end{frame}', '▭', 'beamer frame slide', { block: true }),
      t('\\section{$1}\n\\label{sec:$2}', '§', 'section with label'),
      t('\\cite{$1}', '[1]', 'citation cite'),
      t('\\ref{$1}', '→1', 'reference ref'),
      t('\\label{$1}', '🏷', 'label'),
    ],
  },
];

const ALL = CATEGORIES.flatMap((c) => c.items.map((it) => ({ ...it, category: c.name })));

/** Plain symbol commands (\alpha, \leq, …) by name, for completions and hovers. */
const BY_COMMAND = new Map();
for (const it of ALL) {
  const m = it.tex.match(/^\\([a-zA-Z]+)(.*)$/s);
  if (m && !BY_COMMAND.has(m[1])) BY_COMMAND.set(m[1], { ...it, args: m[2] });
}

module.exports = { CATEGORIES, ALL, BY_COMMAND };
