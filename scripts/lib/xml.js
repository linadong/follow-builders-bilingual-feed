// Minimal, dependency-free RSS 2.0 / Atom parser.
// Only extracts what the digest needs: title, link, date, body text, transcript URL.

const ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  rsquo: '’',
  lsquo: '‘',
  ldquo: '“',
  rdquo: '”'
};

export function decodeEntities(input = '') {
  return input
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => safeChar(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeChar(parseInt(d, 10)))
    .replace(/&([a-z]+);/gi, (m, name) => ENTITIES[name.toLowerCase()] ?? m);
}

function safeChar(code) {
  return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : '';
}

/** Strip markup down to readable plain text. */
export function stripHtml(input = '', limit = 0) {
  let text = input
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<\/(p|div|h[1-6]|li|blockquote)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  text = decodeEntities(text)
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return limit > 0 && text.length > limit ? text.slice(0, limit).trimEnd() + '…' : text;
}

function firstTag(block, names) {
  for (const name of names) {
    const re = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i');
    const m = block.match(re);
    if (m && m[1] != null) return m[1];
  }
  return '';
}

function atomLink(block) {
  const links = [...block.matchAll(/<link\b([^>]*)\/?>/gi)];
  if (!links.length) return firstTag(block, ['link']).trim();
  const preferred =
    links.find((m) => /rel=["']alternate["']/i.test(m[1]) && !/type=["']application/i.test(m[1])) ||
    links.find((m) => /href=/i.test(m[1]));
  const attrs = (preferred || links[0])[1];
  const href = attrs.match(/href=["']([^"']+)["']/i);
  return href ? href[1] : '';
}

function toDate(value) {
  if (!value) return null;
  const ts = Date.parse(value.trim());
  return Number.isNaN(ts) ? null : new Date(ts).toISOString();
}

/**
 * @param {string} xml
 * @param {{limit?:number, contentLimit?:number}} opts
 * @returns {{title:string, items:Array<{title:string, link:string, date:string|null, content:string, transcriptUrl:string|null}>}}
 */
export function parseFeed(xml, opts = {}) {
  const { limit = 30, contentLimit = 6000 } = opts;
  if (!xml) return { title: '', items: [] };

  const isAtom = /<feed\b/i.test(xml) && !/<rss\b/i.test(xml);
  const itemRe = isAtom ? /<entry\b[\s\S]*?<\/entry>/gi : /<item\b[\s\S]*?<\/item>/gi;
  const blocks = xml.match(itemRe) || [];

  const items = blocks.slice(0, limit).map((block) => {
    const rawContent =
      firstTag(block, ['content:encoded', 'content', 'description', 'summary', 'subtitle']) || '';
    const transcriptMatch = block.match(/<podcast:transcript[^>]*url=["']([^"']+)["']/i);
    return {
      title: stripHtml(firstTag(block, ['title']), 300),
      link: isAtom ? atomLink(block) : firstTag(block, ['link']).trim() || atomLink(block),
      date: toDate(
        firstTag(block, ['pubDate', 'published', 'updated', 'dc:date', 'a10:updated']) ||
          (block.match(/<published>([^<]+)</i) || [])[1]
      ),
      content: stripHtml(rawContent, contentLimit),
      transcriptUrl: transcriptMatch ? transcriptMatch[1] : null,
      // guid is what we use as the stable identity for dedupe
      guid: stripHtml(firstTag(block, ['guid', 'id']), 200) || null
    };
  });

  return {
    title: stripHtml(firstTag(xml, ['title']), 200),
    items
  };
}

/** Pull readable text out of an arbitrary HTML page (blog article fallback). */
export function htmlToArticle(html, limit = 6000) {
  if (!html) return { title: '', content: '' };
  const title = stripHtml((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '', 200);
  const main =
    (html.match(/<article\b[\s\S]*?<\/article>/i) || [])[0] ||
    (html.match(/<main\b[\s\S]*?<\/main>/i) || [])[0] ||
    html;
  return { title, content: stripHtml(main, limit) };
}

/** Collect absolute links under a base URL from an index page. */
export function extractLinks(html, baseUrl, limit = 8) {
  let host = '';
  try {
    host = new URL(baseUrl).origin;
  } catch {
    /* ignore */
  }
  const seen = new Set();
  for (const m of html.matchAll(/href=["']([^"']+)["']/gi)) {
    let href = m[1];
    if (!href || href.startsWith('#') || href.startsWith('mailto:')) continue;
    if (href.startsWith('/')) href = host + href;
    if (!href.startsWith('http')) continue;
    if (baseUrl && !href.startsWith(baseUrl)) continue;
    const clean = href.split('#')[0].split('?')[0].replace(/\/$/, '');
    if (clean && !seen.has(clean)) seen.add(clean);
    if (seen.size >= limit * 3) break;
  }
  return [...seen].slice(0, limit);
}
