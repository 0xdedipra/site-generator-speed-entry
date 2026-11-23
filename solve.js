// A fast static site generator: a drop-in replacement for makefun-site 1.0.0 that returns its exact
// output tree for every input, written from scratch against makefun-site's published rules (its
// README) for the site-generator-speed-01 competition. The work is organised as the reference's
// pipeline — sources, front matter, permalinks, Markdown, collections, tags, layouts, report — but
// every stage is built for speed: the Markdown inline renderer walks plain runs instead of single
// characters, HTML escaping copies clean spans in one slice, slugs are memoised per build and take
// an ASCII fast path, templates render into a shared array, and a template partial whose free
// variables are only the build-constant site/tags/recent values is rendered once per build and
// reused wherever it is included at top level.
//
// run(input) is the only export: { site, templates, files } in, the output tree (path -> text) out.
// Nothing is kept between calls: every cache below lives for one run.

// ---------------------------------------------------------------- text

/** HTML escape replacements by char code (the five of the escape table, and no others). */
const ESCAPE_REPL = new Array(128).fill(null);
ESCAPE_REPL[38] = '&amp;';
ESCAPE_REPL[60] = '&lt;';
ESCAPE_REPL[62] = '&gt;';
ESCAPE_REPL[34] = '&quot;';
ESCAPE_REPL[39] = '&#39;';

/** `s` with & < > " ' replaced by their escapes; clean spans are copied whole. */
function escapeHtml(s) {
  let out = null;
  let last = 0;
  for (let i = 0; i < s.length; i++) {
    const rep = ESCAPE_REPL[s.charCodeAt(i)];
    if (rep != null) {
      if (out === null) out = s.slice(0, i);
      else out += s.slice(last, i);
      out += rep;
      last = i + 1;
    }
  }
  return out === null ? s : out + s.slice(last);
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A YYYY-MM-DD date in words, from the string alone: "2026-11-09" is "9 November 2026". */
function longDate(date) {
  return `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
}

/** Slugs are a pure function of their text, so one build memoises them. Cleared by every run(). */
const slugCache = new Map();

function slugify(text) {
  let v = slugCache.get(text);
  if (v === undefined) {
    v = slugifyFresh(text);
    slugCache.set(text, v);
  }
  return v;
}

function slugifyFresh(text) {
  let out = '';
  let gap = false;
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 127) {
      ascii = false;
      break;
    }
  }
  if (ascii) {
    // NFKD is the identity on ASCII and drops no marks there, so the general rule specialises to this.
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      let keep = -1;
      if (c >= 65 && c <= 90) keep = c + 32;
      else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) keep = c;
      if (keep === -1) {
        gap = out.length > 0;
        continue;
      }
      if (gap) out += '-';
      gap = false;
      out += String.fromCharCode(keep);
    }
  } else {
    const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
    for (const ch of plain) {
      let keep = null;
      if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
      else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
      if (keep === null) {
        gap = out.length > 0;
        continue;
      }
      if (gap) out += '-';
      gap = false;
      out += keep;
    }
  }
  out = out.slice(0, 64).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

/** `slug` made unique against the `taken` set (and added to it): slug, slug-2, slug-3, ... */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

/** Whether a char code is whitespace exactly as JavaScript's \s sees it. */
function isWsCode(c) {
  return (
    c === 32 ||
    (c >= 9 && c <= 13) ||
    c === 0xa0 ||
    c === 0x1680 ||
    (c >= 0x2000 && c <= 0x200a) ||
    c === 0x2028 ||
    c === 0x2029 ||
    c === 0x202f ||
    c === 0x205f ||
    c === 0x3000 ||
    c === 0xfeff
  );
}

/** The words of a body: its runs of characters other than whitespace (the count of \S+ matches). */
function wordsOf(text) {
  let count = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    if (isWsCode(text.charCodeAt(i))) inWord = false;
    else if (!inWord) {
      inWord = true;
      count++;
    }
  }
  return count;
}

/** Whether `s` holds any whitespace character (the /\s/ test, by hand). */
function hasWhitespace(s) {
  for (let i = 0; i < s.length; i++) if (isWsCode(s.charCodeAt(i))) return true;
  return false;
}

// ---------------------------------------------------------------- front matter

const FM_KEYS = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const LAYOUT_RE = /^[a-z0-9-]+$/;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TAG_RE = /^[^"[\]]+$/;

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare, the rest of the line. */
function fmString(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const nx = raw[i + 1];
        if ((nx !== '"' && nx !== '\\') || i + 1 === raw.length - 1)
          return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += nx;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One front-matter key's value, or why it is refused. */
function fmValue(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = fmString(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = DATE_RE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo))
        return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || !TAG_RE.test(t))) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return LAYOUT_RE.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return SLUG_RE.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * One "key: value" line taken apart, or null when it is not one: a key of a-z and _, a colon, then
 * either the line's end or one space and the value (its trailing spaces and tabs dropped).
 */
function fmLine(line) {
  let i = 0;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if ((c >= 97 && c <= 122) || c === 95) i++;
    else break;
  }
  if (i === 0 || line[i] !== ':') return null;
  const key = line.slice(0, i);
  if (i + 1 === line.length) return { key, raw: '' };
  if (line[i + 1] !== ' ') return null;
  return { key, raw: line.slice(i + 2).replace(/[ \t]+$/, '') };
}

/**
 * A source's front matter and body: { data, body }, or { error } with the first reason it is
 * refused. `text` has "\n" line ends. The closing line is found before any line is judged, as the
 * reference does: with no closing line the refusal is "not closed" whatever the lines hold.
 */
function parseFrontMatter(text) {
  const firstNl = text.indexOf('\n');
  const line0 = firstNl === -1 ? text : text.slice(0, firstNl);
  if (line0 !== '---') return { error: 'no front matter' };
  if (firstNl === -1) return { error: 'the front matter is not closed' };
  // The spans of the lines after the first, up to and including the closing one.
  const spans = [];
  let close = -1;
  let bodyStart = -1;
  let pos = firstNl + 1;
  while (pos <= text.length) {
    const nl = text.indexOf('\n', pos);
    const end = nl === -1 ? text.length : nl;
    spans.push([pos, end]);
    if (end - pos === 3 && text.startsWith('---', pos)) {
      close = spans.length; // the closing line's index in the whole file's lines (line 0 is the opener)
      bodyStart = nl === -1 ? text.length : nl + 1;
      break;
    }
    if (nl === -1) break;
    pos = nl + 1;
  }
  if (close === -1) return { error: 'the front matter is not closed' };
  const data = {};
  for (let idx = 1; idx < close; idx++) {
    const [a, b] = spans[idx - 1];
    const line = text.slice(a, b);
    let blank = true;
    for (let i = 0; i < line.length; i++) {
      const c = line.charCodeAt(i);
      if (c !== 32 && c !== 9) {
        blank = false;
        break;
      }
    }
    if (blank || line.charCodeAt(0) === 35) continue;
    const m = fmLine(line);
    if (m === null) return { error: `line ${idx + 1} is not "key: value"` };
    const key = m.key;
    if (!FM_KEYS.has(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (m.raw === '') return { error: `key "${key}" has no value` };
    const v = fmValue(key, m.raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: text.slice(bodyStart) };
}

// ---------------------------------------------------------------- Markdown

/** A line of nothing but spaces and tabs (or nothing). */
function isBlankLine(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A line with its spaces and tabs at either end dropped. */
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

function isLangChar(c) {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45;
}

/** A fence's opening line: three backticks, a language, then spaces or tabs only. Its language, or null. */
function fenceOpen(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let i = 3;
  while (i < line.length && isLangChar(line.charCodeAt(i))) i++;
  const lang = line.slice(3, i);
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return null;
    i++;
  }
  return lang;
}

/** A fence's closing line: three backticks, then spaces or tabs only. */
function isFenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A heading line's depth and text, or null: 1 to 6 "#", a space or tab, then text (never empty). */
function headingOf(line) {
  let j = 0;
  while (line.charCodeAt(j) === 35) j++;
  if (j === 0 || j > 6) return null;
  const c = line.charCodeAt(j);
  if (c !== 32 && c !== 9) return null;
  let a = j;
  while (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9) a++;
  let b = line.length;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  if (b <= a) return null;
  return { depth: j, text: line.slice(a, b) };
}

/** A thematic break: "---" or "***", then spaces or tabs only. */
function isHr(line) {
  const a = line.charCodeAt(0);
  const b = line.charCodeAt(1);
  const c = line.charCodeAt(2);
  if (!((a === 45 && b === 45 && c === 45) || (a === 42 && b === 42 && c === 42))) return false;
  for (let i = 3; i < line.length; i++) {
    const ch = line.charCodeAt(i);
    if (ch !== 32 && ch !== 9) return false;
  }
  return true;
}

/** A bullet item line ("- " or "* "): the item's text, or null. */
function bulletOf(line) {
  const c = line.charCodeAt(0);
  if ((c === 45 || c === 42) && line.charCodeAt(1) === 32) return line.slice(2);
  return null;
}

/** An ordered item line (1 to 9 digits, ". "): { num, text }, or null. */
function orderedOf(line) {
  let i = 0;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if (c >= 48 && c <= 57) i++;
    else break;
  }
  if (i === 0 || i > 9) return null;
  if (line.charCodeAt(i) !== 46 || line.charCodeAt(i + 1) !== 32) return null;
  return { num: Number(line.slice(0, i)), text: line.slice(i + 2) };
}

/** A list continuation line: two or more spaces, then a non-space. */
function isContinued(line) {
  if (line.charCodeAt(0) !== 32 || line.charCodeAt(1) !== 32) return false;
  let i = 2;
  while (line.charCodeAt(i) === 32) i++;
  if (i >= line.length) return false;
  return !isWsCode(line.charCodeAt(i));
}

/** Whether `line` ends a paragraph: a blank line, a fence, a heading or a thematic break. */
function endsParagraph(line) {
  return isBlankLine(line) || fenceOpen(line) !== null || headingOf(line) !== null || isHr(line);
}

/** The characters a backslash escapes, by char code. */
const ESCAPABLE_T = new Uint8Array(128);
for (const ch of ['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']) ESCAPABLE_T[ch.charCodeAt(0)] = 1;

function isEscapable(ch) {
  const c = ch.charCodeAt(0);
  return c < 128 && ESCAPABLE_T[c] === 1;
}

/** The first index from `from` where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from) {
  const last = s.length - what.length;
  for (let j = from; j <= last; j++) {
    if (s.charCodeAt(j) === 92 && j + 1 < s.length && isEscapable(s[j + 1])) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < s.length && isEscapable(s[j + 1])) {
      j++;
      continue;
    }
    if (c !== '*') continue;
    if (s[j + 1] === '*') {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

/** Per char code: 1 opens an inline construct (a backslash, a backtick, a star, a bracket); 2 is escaped in HTML. */
const INLINE_FLAG = new Uint8Array(128);
INLINE_FLAG[92] = 1;
INLINE_FLAG[96] = 1;
INLINE_FLAG[42] = 1;
INLINE_FLAG[91] = 1;
INLINE_FLAG[38] = 2;
INLINE_FLAG[60] = 2;
INLINE_FLAG[62] = 2;
INLINE_FLAG[34] = 2;
INLINE_FLAG[39] = 2;

/**
 * `s` rendered inline; `env.link(target)` is a link's href. One pass: plain text collects into a
 * run that is copied out whole (it holds nothing HTML escapes), an escapable character writes its
 * entity, and the four characters that can open a construct resolve exactly as the reference
 * resolves them (it walks character by character to the same bytes).
 */
function renderInline(s, env) {
  const out = [];
  const n = s.length;
  let i = 0;
  let start = 0;
  while (i < n) {
    const code = s.charCodeAt(i);
    const f = code < 128 ? INLINE_FLAG[code] : 0;
    if (f === 0) {
      i++;
      continue;
    }
    if (i > start) out.push(s.slice(start, i));
    if (f === 2) {
      out.push(ESCAPE_REPL[code]);
      i++;
      start = i;
      continue;
    }
    const c = s[i];
    if (c === '\\') {
      if (i + 1 < n && isEscapable(s[i + 1])) {
        out.push(escapeHtml(s[i + 1]));
        i += 2;
      } else {
        out.push('\\');
        i++;
      }
    } else if (c === '`') {
      const k = s.indexOf('`', i + 1);
      if (k > i + 1) {
        out.push('<code>', escapeHtml(s.slice(i + 1, k)), '</code>');
        i = k + 1;
      } else {
        out.push('`');
        i++;
      }
    } else if (c === '*') {
      if (s[i + 1] === '*') {
        const k = findUnescaped(s, '**', i + 2);
        if (k > i + 2) {
          out.push('<strong>', renderInline(s.slice(i + 2, k), env), '</strong>');
          i = k + 2;
        } else {
          out.push('**');
          i += 2;
        }
      } else {
        const k = findSingleStar(s, i + 1);
        if (k > i + 1) {
          out.push('<em>', renderInline(s.slice(i + 1, k), env), '</em>');
          i = k + 1;
        } else {
          out.push('*');
          i++;
        }
      }
    } else {
      // c === '['
      const k = findUnescaped(s, ']', i + 1);
      const m = k !== -1 && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
      const target = m === -1 ? '' : s.slice(k + 2, m);
      if (target !== '' && !hasWhitespace(target)) {
        out.push('<a href="', escapeHtml(env.link(target)), '">', renderInline(s.slice(i + 1, k), env), '</a>');
        i = m + 1;
      } else {
        out.push('[');
        i++;
      }
    }
    start = i;
  }
  if (n > start) out.push(s.slice(start, n));
  return out.join('');
}

/**
 * `src` rendered in one pass over its lines (the reference lexes to tokens first; the blocks, and
 * so the bytes, are the same): its HTML (a "\n" after every block), its table of contents (every
 * level 2 and 3 heading: level, id and its inline HTML) and its excerpt (the first paragraph's
 * inline HTML, or "").
 */
function renderMarkdown(src, env) {
  const lines = src.split('\n');
  const ids = new Set();
  const blocks = [];
  const toc = [];
  let excerpt = '';
  let excerptSet = false;
  const n = lines.length;
  let i = 0;
  while (i < n) {
    const line = lines[i];
    if (isBlankLine(line)) {
      i++;
      continue;
    }
    const fence = fenceOpen(line);
    if (fence !== null) {
      let inner = '';
      i++;
      while (i < n && !isFenceClose(lines[i])) {
        inner += escapeHtml(lines[i]) + '\n';
        i++;
      }
      i++;
      blocks.push(fence === '' ? `<pre><code>${inner}</code></pre>` : `<pre><code class="language-${escapeHtml(fence)}">${inner}</code></pre>`);
      continue;
    }
    const heading = headingOf(line);
    if (heading !== null) {
      const id = uniqueSlug(slugify(heading.text), ids);
      const html = renderInline(heading.text, env);
      blocks.push(`<h${heading.depth} id="${id}">${html}</h${heading.depth}>`);
      if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
      i++;
      continue;
    }
    if (isHr(line)) {
      blocks.push('<hr>');
      i++;
      continue;
    }
    if (line.charCodeAt(0) === 62) {
      const kept = [];
      while (i < n && lines[i].charCodeAt(0) === 62) {
        const l = lines[i];
        const t = trimLine(l.charCodeAt(1) === 32 ? l.slice(2) : l.slice(1));
        if (t !== '') kept.push(t);
        i++;
      }
      blocks.push(
        kept.length === 0
          ? '<blockquote>\n</blockquote>'
          : `<blockquote>\n<p>${renderInline(kept.join('\n'), env)}</p>\n</blockquote>`,
      );
      continue;
    }
    const bullet = bulletOf(line);
    const ordered = bullet === null ? orderedOf(line) : null;
    if (bullet !== null || ordered !== null) {
      const isOrd = ordered !== null;
      const start = isOrd ? ordered.num : 1;
      const items = [];
      while (i < n) {
        if (isOrd) {
          const m = orderedOf(lines[i]);
          if (m !== null) {
            items.push([trimLine(m.text)]);
            i++;
            continue;
          }
        } else {
          const m = bulletOf(lines[i]);
          if (m !== null) {
            items.push([trimLine(m)]);
            i++;
            continue;
          }
        }
        if (isContinued(lines[i])) {
          items[items.length - 1].push(trimLine(lines[i]));
          i++;
          continue;
        }
        break;
      }
      const tag = isOrd ? 'ol' : 'ul';
      let block = isOrd && start !== 1 ? `<ol start="${start}">\n` : `<${tag}>\n`;
      for (const parts of items) block += `<li>${renderInline(parts.join('\n'), env)}</li>\n`;
      block += `</${tag}>`;
      blocks.push(block);
      continue;
    }
    const body = [trimLine(line)];
    i++;
    while (i < n && !endsParagraph(lines[i])) {
      body.push(trimLine(lines[i]));
      i++;
    }
    const html = renderInline(body.join('\n'), env);
    if (!excerptSet) {
      excerpt = html;
      excerptSet = true;
    }
    blocks.push(`<p>${html}</p>`);
  }
  let html = '';
  for (const b of blocks) html += b + '\n';
  return { html, toc, excerpt };
}

// ---------------------------------------------------------------- templates

/** A template that does not parse: its name and why. The build reports it and leaves it out. */
class TemplateError extends Error {}

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

/** Node kinds in a parsed template. */
const N_TEXT = 0;
const N_VAR = 1;
const N_RAW = 2;
const N_IF = 3;
const N_FOR = 4;
const N_INCLUDE = 5;

/** The deepest an include nests: one past it renders nothing. */
const INCLUDE_DEPTH = 8;

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  // Tokenise: text, {{ }}, {{{ }}} and {% %}, a standalone {% %} tag's line taken with it.
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });

  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokens) {
    if (tok.t === 'text') body.push({ kind: N_TEXT, text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t === 'var' ? N_VAR : N_RAW, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { kind: N_FOR, name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { kind: N_IF, not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== N_IF || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? N_FOR : N_IF))
          throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === N_FOR ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push({ kind: N_INCLUDE, name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind === N_FOR ? 'for' : 'if'} is not closed`);
  return root.body;
}

/**
 * Each template's free roots (the first names its paths read that no enclosing for binds, includes
 * followed) and its include depth (the longest chain of includes under it; Infinity when includes
 * cycle). A template whose free roots are all build constants (site, tags, recent) renders the
 * same text wherever it is included at top level, provided no include inside it can reach the
 * depth cutoff — the renderer checks that per use, and cycles are never cached.
 */
function analyseTemplates(templates) {
  const memo = new Map();
  const analyse = (name, visiting) => {
    if (memo.has(name)) return memo.get(name);
    if (visiting.has(name)) return { free: new Set(), depth: Infinity };
    const nodes = templates.get(name);
    if (nodes === undefined) return { free: new Set(), depth: 0 };
    visiting.add(name);
    const free = new Set();
    let depth = 0;
    const walk = (ns, bound) => {
      for (const nd of ns) {
        if (nd.kind === N_VAR || nd.kind === N_RAW) {
          if (!bound.has(nd.path[0])) free.add(nd.path[0]);
        } else if (nd.kind === N_IF) {
          if (!bound.has(nd.path[0])) free.add(nd.path[0]);
          walk(nd.then, bound);
          if (nd.else !== null) walk(nd.else, bound);
        } else if (nd.kind === N_FOR) {
          if (!bound.has(nd.path[0])) free.add(nd.path[0]);
          const b2 = new Set(bound);
          b2.add(nd.name);
          b2.add('loop');
          walk(nd.body, b2);
        } else if (nd.kind === N_INCLUDE) {
          const sub = analyse(nd.name, visiting);
          for (const r of sub.free) if (!bound.has(r)) free.add(r);
          depth = sub.depth === Infinity ? Infinity : Math.max(depth, sub.depth + 1);
        }
      }
    };
    walk(nodes, new Set());
    visiting.delete(name);
    const res = { free, depth };
    memo.set(name, res);
    return res;
  };
  const out = new Map();
  for (const name of templates.keys()) out.set(name, analyse(name, new Set()));
  return out;
}

/** The value at `path` in the scope chain: its first name from the nearest scope holding it, then own properties. */
function lookupPath(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) {
    let out = '';
    for (let k = 0; k < v.length; k++) {
      if (k > 0) out += ', ';
      out += textOf(v[k]);
    }
    return out;
  }
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

const CONSTANT_ROOTS = new Set(['site', 'tags', 'recent']);

/**
 * `nodes` rendered in `scope` ({ vars, parent }), appending to `out`. `ctx` holds the parsed
 * templates, their analysis, and this build's include cache: an include at top level (a scope with
 * no parent, so no loop binds anything over it) of a template whose free roots are all build
 * constants is rendered once and reused, when the include's depth leaves its whole subtree clear
 * of the depth cutoff, so the cached text is the text a fresh render would write.
 */
function renderNodes(nodes, scope, ctx, depth, out) {
  for (let idx = 0; idx < nodes.length; idx++) {
    const nd = nodes[idx];
    switch (nd.kind) {
      case N_TEXT:
        out.push(nd.text);
        break;
      case N_VAR:
        out.push(escapeHtml(textOf(lookupPath(scope, nd.path))));
        break;
      case N_RAW:
        out.push(textOf(lookupPath(scope, nd.path)));
        break;
      case N_IF: {
        const v = truthy(lookupPath(scope, nd.path));
        const branch = v !== nd.not ? nd.then : nd.else;
        if (branch !== null) renderNodes(branch, scope, ctx, depth, out);
        break;
      }
      case N_FOR: {
        const xs = lookupPath(scope, nd.path);
        if (Array.isArray(xs)) {
          for (let k = 0; k < xs.length; k++) {
            const vars = {
              [nd.name]: xs[k],
              loop: { index: k + 1, first: k === 0, last: k === xs.length - 1, length: xs.length },
            };
            renderNodes(nd.body, { vars, parent: scope }, ctx, depth, out);
          }
        }
        break;
      }
      case N_INCLUDE: {
        const t = ctx.templates.get(nd.name);
        if (t === undefined || depth >= INCLUDE_DEPTH) break;
        const meta = ctx.analysis.get(nd.name);
        if (
          meta !== undefined &&
          meta.cacheable &&
          scope.parent === null &&
          depth + 1 + meta.depth < INCLUDE_DEPTH
        ) {
          let cached = ctx.includeCache.get(nd.name);
          if (cached === undefined) {
            const buf = [];
            renderNodes(t, scope, ctx, depth + 1, buf);
            cached = buf.join('');
            ctx.includeCache.set(nd.name, cached);
          }
          out.push(cached);
        } else {
          renderNodes(t, scope, ctx, depth + 1, out);
        }
        break;
      }
    }
  }
}

// ---------------------------------------------------------------- the build

/** The top-level directories the generator writes itself, which no page's slug at the root may take. */
const RESERVED = ['posts', 'tags', 'page'];

/** Code-unit order (never the locale's). */
function byCodeUnits(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The directory of a "/" -separated path, or "" at the root. */
function dirOf(path) {
  const at = path.lastIndexOf('/');
  return at === -1 ? '' : path.slice(0, at);
}

/** `rel` (a link's path) from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  // The common case first: no "." or ".." segment and no empty one, so the path is dir + rel.
  if (!rel.startsWith('.') && !rel.includes('/.') && !rel.includes('//') && !rel.endsWith('/')) {
    return dir === '' ? rel : `${dir}/${rel}`;
  }
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

/** Whether a link target opens with a scheme (`https:`, `mailto:` ...), as the reference's test reads it. */
function hasScheme(t) {
  const c0 = t.charCodeAt(0);
  if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122))) return false;
  for (let i = 1; i < t.length; i++) {
    const c = t.charCodeAt(i);
    if (c === 58) return true;
    if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 46 || c === 45)) return false;
  }
  return false;
}

/** One site's output tree: path -> text. Everything below is one build's state, made fresh here. */
function build(input) {
  slugCache.clear();
  const report = [];
  const templates = new Map();
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const analysis = analyseTemplates(templates);
  for (const meta of analysis.values()) {
    meta.cacheable = meta.depth !== Infinity && [...meta.free].every((r) => CONSTANT_ROOTS.has(r));
  }
  const ctx = { templates, analysis, includeCache: new Map() };
  const base = input.site.base_url.replace(/\/+$/, '');

  // Sources, in code-unit order of their paths, line ends made "\n"; a file that is not .md is static.
  const sources = [];
  const statics = [];
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      sources.push({ path: f.path, text: f.content.includes('\r') ? f.content.replace(/\r\n?/g, '\n') : f.content });
    } else statics.push({ path: f.path, content: f.content });
  }

  // Front matter: a refused source is reported and dropped, and so is a draft; the checks run in
  // the reference's order and the first that fails is the one reported.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = RESERVED.find((d) => d !== 'posts' && s.path.startsWith(`${d}/`));
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  // Permalinks: a post's directory is posts/, a page's is its source's; each slug made unique in
  // its directory in source order, the root's reserved names taken from the start.
  const taken = new Map();
  const takenIn = (dir) => {
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    return set;
  };
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), takenIn(dir));
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // Markdown: each body's HTML, its links resolved to the pages and static files they name.
  const broken = new Set();
  const staticPaths = new Set(statics.map((f) => f.path));
  for (const s of kept) {
    const dir = dirOf(s.path);
    const env = {
      link: (target) => {
        if (hasScheme(target) || target.startsWith('/') || target.startsWith('#')) return target;
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(dir, rel);
        if (path !== null && bySource.has(path)) return `${bySource.get(path).url}${frag}`;
        if (path !== null && staticPaths.has(path)) return `${base}/${path}${frag}`;
        broken.add(`broken-link ${s.path} -> ${target}`);
        return target;
      },
    };
    const md = renderMarkdown(s.body, env);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // Collections: the posts, newest date first, and equal dates by slug; each post's neighbours.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // Tags: grouped by slug, each named as first met walking the posts in collection order, ordered
  // by their count of posts, most first, then by slug. A page's tags link to the tag of the same
  // slug, or have the url "" where no post has that tag.
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const slug = slugify(name);
      if (!seen.has(slug)) {
        seen.add(slug);
        out.push(name);
      }
    }
    return out;
  };
  const tagBySlug = new Map();
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name);
      let tag = tagBySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        tagBySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (!s.post) {
      s.tagRefs = ownTags(s).map((name) => {
        const slug = slugify(name);
        return tagBySlug.get(slug) ?? { name, slug, url: '', posts: [] };
      });
    }
  }
  const tags = [...tagBySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // Layouts: every page through its layout, the index pages and the tag pages through theirs,
  // then each static file at its own path unless a built page has that path.
  const output = {};
  const cardCache = new Map();
  const cardOf = (s) => {
    let card = cardCache.get(s);
    if (card === undefined) {
      card = {
        title: s.data.title,
        url: s.url,
        date: s.data.date ?? '',
        date_long: s.data.date === undefined ? '' : longDate(s.data.date),
        summary: s.data.summary ?? '',
        excerpt: s.excerpt,
        reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
        tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
      };
      cardCache.set(s, card);
    }
    return card;
  };
  const linkOf = (s) =>
    s === null
      ? null
      : {
          title: s.data.title,
          url: s.url,
          date: s.data.date ?? '',
          date_long: s.data.date === undefined ? '' : longDate(s.data.date),
        };
  const pageOf = (s) => ({
    ...cardOf(s),
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  });
  const cards = new Map(posts.map((p) => [p, cardOf(p)]));
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  // One root scope for every render of this build: the constants never change, and each render
  // fills only its own slot (page, posts and pager, or tag) and clears it again — renders run one
  // at a time and never nest, so no render can see another's slot.
  const rootVars = { site, tags: allTags, recent, page: undefined, posts: undefined, pager: undefined, tag: undefined };
  const rootScope = { vars: rootVars, parent: null };
  const render = (name, slot, value, slot2, value2) => {
    const nodes = templates.get(name);
    if (nodes === undefined) return null;
    if (slot !== null) rootVars[slot] = value;
    if (slot2 !== null) rootVars[slot2] = value2;
    const buf = [];
    renderNodes(nodes, rootScope, ctx, 0, buf);
    if (slot !== null) rootVars[slot] = undefined;
    if (slot2 !== null) rootVars[slot2] = undefined;
    return buf.join('');
  };
  for (const s of kept) output[`${s.outDir}/index.html`] = render(s.layout, 'page', pageOf(s), null, null);
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render(
      'index',
      'posts',
      posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      'pager',
      {
        number: k,
        total: pages,
        url: indexUrl(k),
        newer_url: k === 1 ? '' : indexUrl(k - 1),
        older_url: k === pages ? '' : indexUrl(k + 1),
      },
    );
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render(
      'tag',
      'tag',
      { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) },
      null,
      null,
    );
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', null, null, null, null);
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // The report: every line reported and each broken link, sorted, then the counts.
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pageCount = kept.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}

/** makefun-site 1.0.0's answer for one case's input, at a fraction of its CPU time. */
export function run(input) {
  return build(input);
}
