'use strict';

// Chinese (and other CJK) writing support. Everything here only acts on text that has CJK
// characters in it, so documents in other languages never see it.
//
// - Common wrong-character typos (错别字), the Chinese counterpart of a spelling dictionary:
//   Chinese has no spaces between words, so a Hunspell-style word list doesn't apply.
// - Typography checks LanguageTool doesn't make: half-width punctuation in Chinese text,
//   straight quotes, "..." for ……, doubled punctuation, stray spaces next to full-width marks.
// - Missing-font compile errors (SimSun on macOS, Songti SC on Windows…) explained, with fixes.

/** One CJK ideograph or kana (Hangul is left out: Korean uses Western punctuation and spaces). */
const CJK_SRC = '[\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}]';
const CJK = new RegExp(CJK_SRC, 'u');
const CJK_ALL = new RegExp(CJK_SRC, 'gu');
/** Characters counted one by one in a word count: CJK ideographs, kana and Hangul syllables. */
const CJK_COUNTED = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu;
/** A letter that isn't CJK (for word-based counting and spell checking). */
const NON_CJK_LETTER = '(?:(?![\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Hangul}])\\p{L})';

const hasCJK = (text) => CJK.test(text);
const cjkCount = (text) => (text.match(CJK_COUNTED) || []).length;

// ---------------------------------------------------------------------------
// Common typos (错别字): wrong → right. Only fixed phrases that are never correct as written,
// so they can be flagged without context.

const TYPOS = {
  再接再励: '再接再厉',
  一股作气: '一鼓作气',
  按步就班: '按部就班',
  迫不急待: '迫不及待',
  默守成规: '墨守成规',
  草管人命: '草菅人命',
  甘败下风: '甘拜下风',
  自抱自弃: '自暴自弃',
  谈笑风声: '谈笑风生',
  走头无路: '走投无路',
  声名雀起: '声名鹊起',
  委屈求全: '委曲求全',
  世外桃园: '世外桃源',
  一愁莫展: '一筹莫展',
  穿流不息: '川流不息',
  川流不惜: '川流不息',
  变本加利: '变本加厉',
  怨天由人: '怨天尤人',
  关怀倍至: '关怀备至',
  莫明其妙: '莫名其妙',
  出奇不意: '出其不意',
  美仑美奂: '美轮美奂',
  不径而走: '不胫而走',
  一张一驰: '一张一弛',
  再所难免: '在所难免',
  天翻地复: '天翻地覆',
  黄梁美梦: '黄粱美梦',
  蛛丝蚂迹: '蛛丝马迹',
  针贬时弊: '针砭时弊',
  食不裹腹: '食不果腹',
  一如继往: '一如既往',
  既往不究: '既往不咎',
  不加思索: '不假思索',
  举一返三: '举一反三',
  名列前矛: '名列前茅',
  披星带月: '披星戴月',
  鬼鬼崇崇: '鬼鬼祟祟',
  记忆尤新: '记忆犹新',
  相辅相承: '相辅相成',
  金榜提名: '金榜题名',
  甜言密语: '甜言蜜语',
  大相经庭: '大相径庭',
  有持无恐: '有恃无恐',
  名符其实: '名副其实',
  人情事故: '人情世故',
  毛骨耸然: '毛骨悚然',
  惹事生非: '惹是生非',
  貌和神离: '貌合神离',
  凭心而论: '平心而论',
  按纳不住: '按捺不住',
  别出新裁: '别出心裁',
  独挡一面: '独当一面',
  发人深醒: '发人深省',
  分道扬镖: '分道扬镳',
  富丽堂煌: '富丽堂皇',
  急燥: '急躁',
  烦燥: '烦躁',
  暴燥: '暴躁',
  脉膊: '脉搏',
  松驰: '松弛',
  编缉: '编辑',
  题纲: '提纲',
  安祥: '安详',
  发韧: '发轫',
  寒喧: '寒暄',
  陷井: '陷阱',
  弦律: '旋律',
  膺品: '赝品',
  侯车: '候车',
  修茸: '修葺',
  渡假: '度假',
  震憾: '震撼',
  部份: '部分',
  帐号: '账号',
  帐户: '账户',
  刻划: '刻画',
  重迭: '重叠',
  座标: '坐标',
  幅射: '辐射',
  磨擦: '摩擦',
  精萃: '精粹',
  气慨: '气概',
  凑和: '凑合',
  渲泄: '宣泄',
  好象: '好像',
  截止目前: '截至目前',
  截止到目前: '截至目前',
  既使: '即使',
  即然: '既然',
  必竟: '毕竟',
  做为: '作为',
  辩别: '辨别',
  辩认: '辨认',
  辨论: '辩论',
  辨解: '辩解',
  赔养: '培养',
  阀值: '阈值',
  鲁邦性: '鲁棒性',
  鲁棒姓: '鲁棒性',
  拟和: '拟合',
  卷基: '卷积',
  神精网络: '神经网络',
  梯度下将: '梯度下降',
  正则画: '正则化',
  归一画: '归一化',
  复杂读: '复杂度',
  算发: '算法',
  模形: '模型',
  数剧: '数据',
};
const TYPO_RE = new RegExp(
  Object.keys(TYPOS)
    .sort((a, b) => b.length - a.length)
    .join('|'),
  'g'
);

/** Known typos in `text`: [{a, b, wrong, right}] with text offsets. */
function typos(text, accepted = new Set()) {
  if (!hasCJK(text)) return [];
  const out = [];
  for (const m of text.matchAll(TYPO_RE)) {
    if (accepted.has(m[0])) continue;
    out.push({ a: m.index, b: m.index + m[0].length, wrong: m[0], right: TYPOS[m[0]] });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Typography

const FULL = { ',': '，', ';': '；', ':': '：', '?': '？', '!': '！', '.': '。' };
/** Full-width punctuation that closes or separates (a space before it is stray). */
const FW_AFTER = '，。、；：？！）》】”’';
/** Full-width punctuation that opens or separates (a space after it is stray). */
const FW_BEFORE = '，。、；：？！（《【“‘';

/**
 * Typography issues in reading text `text`: [{a, b, message, fix, rule, hint}] where [a, b) is the
 * text to replace with `fix`. `quoteAt(k)` tells whether a '"' at k came from `` (open), '' (close)
 * or a plain " (null), so straight quotes can be turned the right way.
 */
function typography(text, quoteAt = () => null) {
  if (!hasCJK(text)) return [];
  const out = [];
  const isCJK = (ch) => !!ch && CJK.test(ch);
  // The character `dir` steps from k, skipping spaces (not line breaks).
  const near = (k, dir) => {
    let j = k + dir;
    while (j >= 0 && j < text.length && (text[j] === ' ' || text[j] === '\t')) j += dir;
    return text[j];
  };

  // Half-width , ; : ? ! next to CJK, and a period right after CJK.
  for (const m of text.matchAll(/[,;:?!.]/g)) {
    const k = m.index;
    const ch = m[0];
    const prev = text[k - 1];
    const next = text[k + 1];
    if (ch === '.') {
      // 句号: only a lone period straight after CJK, before a space, a line end or more CJK.
      if (!isCJK(prev) || next === '.' || text[k - 1] === '.' || (next && !/[\s\p{Script=Han}]/u.test(next))) continue;
    } else {
      if (next === ch || prev === ch) continue; // ::, ?!-runs and the like are deliberate
      if (/\d/.test(prev || '') && /\d/.test(next || '')) continue; // 1,000 and 12:30
      if (ch === ':' && next === '/') continue; // URLs
      if (!isCJK(near(k, -1)) && !isCJK(near(k, 1))) continue;
    }
    // Full-width marks carry their own spacing, so spaces around one go with it.
    let a = k;
    let b = k + 1;
    while (b < text.length && (text[b] === ' ' || text[b] === '\t')) b++;
    if (b > k + 1 && !isCJK(text[b])) b = k + 1;
    while (a > 0 && (text[a - 1] === ' ' || text[a - 1] === '\t')) a--;
    if (a < k && !isCJK(text[a - 1])) a = k;
    out.push({ a, b, fix: FULL[ch], rule: 'halfwidth', message: `Half-width "${ch}" in Chinese text: use "${FULL[ch]}"` });
  }

  // ... or a lone … next to CJK → ……
  for (const m of text.matchAll(/\.{3,}|…+|。{3,}/g)) {
    if (m[0] === '……') continue;
    // CJK just before or after, allowing for a closing quote or bracket in between.
    const around = text.slice(Math.max(0, m.index - 3), m.index) + text.slice(m.index + m[0].length, m.index + m[0].length + 3);
    if (!CJK.test(around)) continue;
    out.push({ a: m.index, b: m.index + m[0].length, fix: '……', rule: 'ellipsis', message: `Chinese ellipsis is "……" (two ellipsis characters), not "${m[0]}"` });
  }

  // Straight double quotes around CJK → “ ”.
  let open = true;
  for (const m of text.matchAll(/"/g)) {
    const k = m.index;
    const src = quoteAt(k);
    const opening = src === 'open' ? true : src === 'close' ? false : open;
    open = !opening;
    if (!isCJK(near(k, -1)) && !isCJK(near(k, 1))) continue;
    const fix = opening ? '“' : '”';
    out.push({ a: k, b: k + 1, fix, rule: 'quotes', message: `Straight quotes in Chinese text: use "${fix}"` });
  }

  // Doubled punctuation and 的的.
  for (const m of text.matchAll(/([，。、；：])\1+|的的(?!确)/g)) {
    const fix = m[0][0];
    out.push({ a: m.index, b: m.index + m[0].length, fix, rule: 'doubled', message: `"${m[0]}" is doubled` });
  }

  // Spaces before closing / after opening full-width punctuation.
  for (const m of text.matchAll(new RegExp(`(?<=\\S)[ \\t]+(?=[${FW_AFTER}])|(?<=[${FW_BEFORE}])[ \\t]+(?=\\S)`, 'gu'))) {
    out.push({ a: m.index, b: m.index + m[0].length, fix: '', rule: 'space', hint: true, message: 'Space next to full-width punctuation' });
  }
  return out.sort((x, y) => x.a - y.a);
}

// ---------------------------------------------------------------------------
// Grammar language

/** The LanguageTool language for a paragraph: zh-CN / ja-JP for mostly-CJK text, else `fallback`. */
function paragraphLanguage(text, fallback) {
  const cjk = (text.match(CJK_ALL) || []).length;
  if (!cjk) return fallback;
  const latin = (text.match(/\p{Script=Latin}/gu) || []).length;
  if (cjk * 3 < latin) return fallback; // an English paragraph with a Chinese name or two
  if (/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text)) return 'ja-JP';
  return 'zh-CN';
}

// ---------------------------------------------------------------------------
// Fonts

/** The same typeface on each system: [role, Windows, macOS (ctex's fontset=mac), Fandol (ships with TeX), Linux]. */
const FONTS = [
  ['serif (宋体)', 'SimSun', 'Songti SC', 'FandolSong', 'Noto Serif CJK SC'],
  ['sans (黑体)', 'SimHei', 'Heiti SC', 'FandolHei', 'Noto Sans CJK SC'],
  ['sans (雅黑)', 'Microsoft YaHei', 'PingFang SC', 'FandolHei', 'Noto Sans CJK SC'],
  ['kai (楷体)', 'KaiTi', 'Kaiti SC', 'FandolKai', 'AR PL UKai CN'],
  ['fangsong (仿宋)', 'FangSong', 'STFangsong', 'FandolFang', 'FandolFang'],
  ['serif (宋体)', 'NSimSun', 'Songti SC', 'FandolSong', 'Noto Serif CJK SC'],
  ['serif (宋体)', 'STSong', 'Songti SC', 'FandolSong', 'Noto Serif CJK SC'],
  ['sans (黑体)', 'STHeiti', 'Heiti SC', 'FandolHei', 'Noto Sans CJK SC'],
  ['kai (楷体)', 'STKaiti', 'Kaiti SC', 'FandolKai', 'AR PL UKai CN'],
  ['serif (宋体)', 'Source Han Serif SC', 'Songti SC', 'FandolSong', 'Noto Serif CJK SC'],
  ['sans (黑体)', 'Source Han Sans SC', 'PingFang SC', 'FandolHei', 'Noto Sans CJK SC'],
  ['serif (宋体)', 'Noto Serif CJK SC', 'Songti SC', 'FandolSong', 'Noto Serif CJK SC'],
  ['sans (黑体)', 'Noto Sans CJK SC', 'PingFang SC', 'FandolHei', 'Noto Sans CJK SC'],
];
const PLATFORM_COL = { win32: 1, darwin: 2, linux: 4 };
const PLATFORM_NAME = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' };
/** ctex's font set for this system. */
const PLATFORM_FONTSET = { win32: 'windows', darwin: 'mac', linux: 'fandol' };

const MISSING_FONT = /The font "([^"]+)" cannot be found/;
/** Fonts of ctex's fontset=mac that macOS may only download on first use. */
const MAC_ON_DEMAND = /^(STXihei|STHeiti|STFangsong|STKaiti|STSong|Kaiti SC|Songti SC|Heiti SC|Lantinghei SC|Yuanti SC|Baoli SC|Libian SC|Weibei SC|Xingkai SC|Hannotate SC|HanziPen SC)$/i;

/** Replacements for a missing font: [{font, why}] — this system's equivalent, then Fandol. */
function fontAlternatives(font, platform = process.platform) {
  const row = FONTS.find((r) => r.slice(1).some((f) => f.toLowerCase() === font.toLowerCase()));
  if (!row) return [];
  const out = [];
  const here = row[PLATFORM_COL[platform] || 3];
  if (here && here.toLowerCase() !== font.toLowerCase()) out.push({ font: here, why: `${row[0]} on ${PLATFORM_NAME[platform] || 'this system'}` });
  if (row[3].toLowerCase() !== font.toLowerCase() && here !== row[3]) out.push({ font: row[3], why: `${row[0]}, included with TeX` });
  return out;
}

/** The ctex font set named in `text` (fontset=… in \documentclass or \usepackage{ctex} options) and where. */
function ctexFontset(text) {
  const m = /\\(?:documentclass|usepackage)\s*\[([^\]]*)\]\s*\{(ctex(?:art|rep|book|beamer)?)\}/.exec(text);
  if (!m) return null;
  const opts = m.index + m[0].indexOf('[') + 1;
  const f = /(^|,)(\s*)(fontset\s*=\s*([\w-]+))/.exec(m[1]);
  const start = f ? opts + f.index + f[1].length + f[2].length : -1;
  return { cls: m[2], optsStart: opts, optsEnd: opts + m[1].length, fontset: f ? f[4] : null, start, end: f ? start + f[3].length : -1 };
}
const usesCtex = (text) => /\\(?:documentclass|usepackage)\s*(?:\[[^\]]*\])?\s*\{ctex(?:art|rep|book|beamer)?\}/.test(text);

/** A longer message for a missing-font error, or null if `message` isn't one. */
function explainFont(message, rootText) {
  const m = MISSING_FONT.exec(message);
  if (!m) return null;
  const alts = fontAlternatives(m[1]);
  let hint = ` This font isn't installed on this computer.`;
  // macOS ships several Chinese fonts as downloadable assets, fetched the first time one is asked for.
  if (process.platform === 'darwin' && MAC_ON_DEMAND.test(m[1])) hint = ' macOS downloads some Chinese fonts the first time they are used: wait a moment and build again.';
  if (usesCtex(rootText || '')) {
    const fs = ctexFontset(rootText || '');
    hint += fs && fs.fontset ? ` ctex is set to fontset=${fs.fontset}; use fontset=${PLATFORM_FONTSET[process.platform] || 'fandol'} here, fontset=fandol for fonts included with TeX, or remove it to let ctex choose.` : ' Try ctex\'s fontset=fandol (fonts included with TeX).';
  } else if (alts.length) {
    hint += ` Use ${alts.map((a) => `"${a.font}"`).join(' or ')} instead.`;
  }
  return m[0] + '.' + hint;
}

/** Where a missing-font error belongs in `text`: the line that names the font or sets ctex's fontset (0-based), or -1. */
function fontErrorLine(text, font) {
  const lines = text.split(/\r?\n/);
  const esc = font.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let k = lines.findIndex((l) => !/^\s*%/.test(l) && new RegExp(`\\{\\s*${esc}\\s*\\}|=\\s*${esc}\\s*[,\\]]`).test(l));
  if (k < 0) k = lines.findIndex((l) => !/^\s*%/.test(l) && /\\(?:documentclass|usepackage)\s*(?:\[[^\]]*\])?\s*\{ctex/.test(l));
  return k;
}

module.exports = {
  CJK,
  NON_CJK_LETTER,
  hasCJK,
  cjkCount,
  TYPOS,
  typos,
  typography,
  paragraphLanguage,
  MISSING_FONT,
  fontAlternatives,
  ctexFontset,
  usesCtex,
  explainFont,
  fontErrorLine,
  PLATFORM_FONTSET,
};
