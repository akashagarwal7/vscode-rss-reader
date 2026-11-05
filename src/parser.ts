// Pure feed parsing (RSS 2.0, RSS 1.0/RDF, Atom, JSON Feed). No `vscode` import.
import { XMLParser } from 'fast-xml-parser';

export interface ParsedItem {
  id: string;
  title: string;
  link?: string;
  published?: number;
  author?: string;
  summary?: string;
}

export interface ParsedFeed {
  title?: string;
  link?: string;
  items: ParsedItem[];
}

export class NotAFeedError extends Error {
  constructor(message = 'Response is not an RSS, Atom or JSON feed') {
    super(message);
    this.name = 'NotAFeedError';
  }
}

const xml = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  processEntities: true,
  htmlEntities: true,
  isArray: (name) => ['item', 'entry', 'link', 'category'].includes(name),
});

const NAMED: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', mdash: '—', ndash: '–',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', copy: '©', reg: '®', trade: '™', bull: '•', middot: '·',
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    }
    return NAMED[e.toLowerCase()] ?? m;
  });
}

/** Strip HTML to plain text and collapse whitespace. */
export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<br\s*\/?>|<\/p>|<\/div>|<\/li>/gi, ' ')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/\s+/g, ' ')
    .trim();
}

function text(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return text(v[0]);
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if ('#text' in o) return text(o['#text']);
    if ('name' in o) return text(o.name); // Atom <author><name>
  }
  return undefined;
}

function clean(v: unknown): string | undefined {
  const t = text(v);
  if (t === undefined) return undefined;
  const out = htmlToText(t);
  return out || undefined;
}

function parseDate(v: unknown): number | undefined {
  const t = text(v);
  if (!t) return undefined;
  const ms = Date.parse(t.trim());
  return Number.isFinite(ms) ? ms : undefined;
}

function truncate(s: string | undefined, n: number): string | undefined {
  if (!s) return undefined;
  return s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s;
}

function resolveUrl(href: string | undefined, base: string | undefined): string | undefined {
  if (!href) return undefined;
  try {
    return new URL(href.trim(), base).toString();
  } catch {
    return href.trim();
  }
}

/** Atom `<link>`s: prefer rel=alternate (or no rel), html type. */
function atomLink(links: unknown, base?: string): string | undefined {
  if (!Array.isArray(links)) return resolveUrl(text(links), base);
  let best: string | undefined;
  for (const l of links) {
    if (typeof l === 'string') {
      best ??= l;
      continue;
    }
    const o = l as Record<string, unknown>;
    const href = text(o['@_href']);
    const rel = text(o['@_rel']) ?? 'alternate';
    if (href && rel === 'alternate') return resolveUrl(href, base);
    if (href && !best && rel !== 'self') best = href;
    if (!href && text(o)) best ??= text(o);
  }
  return resolveUrl(best, base);
}

function makeId(...parts: (string | undefined)[]): string {
  return parts.find((p) => p && p.trim())?.trim() ?? '';
}

const SUMMARY_MAX = 1000;

function parseRssItems(items: unknown[], base?: string): ParsedItem[] {
  return items.map((raw) => {
    const it = raw as Record<string, unknown>;
    const link = resolveUrl(text(it.link) ?? (text(it['@_about'])), base);
    const title = clean(it.title) ?? '(untitled)';
    const guid = text(it.guid);
    const published = parseDate(it.pubDate ?? it.date ?? it.published ?? it.updated);
    return {
      id: makeId(guid, link, `${title}|${published ?? ''}`),
      title,
      link,
      published,
      author: clean(it.creator ?? it.author),
      summary: truncate(clean(it.description ?? it.encoded ?? it.summary), SUMMARY_MAX),
    };
  });
}

function parseAtom(feed: Record<string, unknown>, base?: string): ParsedFeed {
  const link = atomLink(feed.link, base);
  const entries = (feed.entry as unknown[] | undefined) ?? [];
  return {
    title: clean(feed.title),
    link,
    items: entries.map((raw) => {
      const e = raw as Record<string, unknown>;
      const itemLink = atomLink(e.link, link ?? base);
      const title = clean(e.title) ?? '(untitled)';
      const published = parseDate(e.published ?? e.updated ?? e.issued ?? e.modified);
      return {
        id: makeId(text(e.id), itemLink, `${title}|${published ?? ''}`),
        title,
        link: itemLink,
        published,
        author: clean(e.author),
        summary: truncate(clean(e.summary ?? e.content), SUMMARY_MAX),
      };
    }),
  };
}

function parseJsonFeed(body: string, base?: string): ParsedFeed {
  let doc: Record<string, unknown>;
  try {
    doc = JSON.parse(body);
  } catch {
    throw new NotAFeedError();
  }
  if (typeof doc.version !== 'string' || !doc.version.includes('jsonfeed.org') || !Array.isArray(doc.items)) {
    throw new NotAFeedError();
  }
  const link = resolveUrl(text(doc.home_page_url), base);
  return {
    title: clean(doc.title),
    link,
    items: (doc.items as Record<string, unknown>[]).map((it) => {
      const itemLink = resolveUrl(text(it.url) ?? text(it.external_url), link ?? base);
      const title = clean(it.title) ?? truncate(clean(it.content_text ?? it.content_html), 80) ?? '(untitled)';
      const authors = it.authors as Record<string, unknown>[] | undefined;
      return {
        id: makeId(text(it.id), itemLink, title),
        title,
        link: itemLink,
        published: parseDate(it.date_published ?? it.date_modified),
        author: clean(authors?.[0]?.name ?? (it.author as Record<string, unknown> | undefined)?.name),
        summary: truncate(clean(it.summary ?? it.content_text ?? it.content_html), SUMMARY_MAX),
      };
    }),
  };
}

/** Parse a feed document. `base` (the feed URL) resolves relative links. Throws NotAFeedError for non-feeds. */
export function parseFeed(body: string, base?: string): ParsedFeed {
  const trimmed = body.replace(/^﻿/, '').trimStart();
  if (trimmed.startsWith('{')) return parseJsonFeed(trimmed, base);
  if (!trimmed.startsWith('<')) throw new NotAFeedError();

  let doc: Record<string, unknown>;
  try {
    doc = xml.parse(trimmed) as Record<string, unknown>;
  } catch (e) {
    throw new NotAFeedError(`Invalid XML: ${(e as Error).message}`);
  }

  const rss = doc.rss as Record<string, unknown> | undefined;
  if (rss) {
    const channel = (Array.isArray(rss.channel) ? rss.channel[0] : rss.channel) as Record<string, unknown> | undefined;
    if (!channel) throw new NotAFeedError();
    const link = atomLink(channel.link, base);
    return {
      title: clean(channel.title),
      link,
      items: parseRssItems((channel.item as unknown[] | undefined) ?? [], link ?? base),
    };
  }
  const feed = doc.feed as Record<string, unknown> | undefined;
  if (feed) return parseAtom(feed, base);

  const rdf = doc.RDF as Record<string, unknown> | undefined;
  if (rdf) {
    const channel = rdf.channel as Record<string, unknown> | undefined;
    const link = atomLink(channel?.link, base);
    return {
      title: clean(channel?.title),
      link,
      items: parseRssItems((rdf.item as unknown[] | undefined) ?? [], link ?? base),
    };
  }
  throw new NotAFeedError();
}

/** Find `<link rel="alternate" type="application/rss+xml|atom+xml|feed+json">` URLs in an HTML page. */
export function discoverFeedLinks(html: string, pageUrl: string): { url: string; title?: string }[] {
  const out: { url: string; title?: string }[] = [];
  const seen = new Set<string>();
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = m[0];
    const attr = (name: string) =>
      tag.match(new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'))?.slice(2).find((x) => x !== undefined);
    const rel = attr('rel')?.toLowerCase() ?? '';
    const type = attr('type')?.toLowerCase() ?? '';
    const href = attr('href');
    if (!href || !rel.split(/\s+/).includes('alternate')) continue;
    if (!/application\/(rss|atom)\+xml|application\/(feed\+)?json|text\/xml|application\/xml/.test(type)) continue;
    const url = resolveUrl(decodeEntities(href), pageUrl)!;
    if (seen.has(url)) continue;
    seen.add(url);
    const title = attr('title');
    out.push({ url, title: title ? decodeEntities(title) : undefined });
  }
  return out;
}
