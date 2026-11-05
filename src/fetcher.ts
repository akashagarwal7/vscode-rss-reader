// HTTP fetching of feeds with conditional GET. No `vscode` import.
import { discoverFeedLinks, NotAFeedError, parseFeed, type ParsedFeed } from './parser';

export interface FetchOptions {
  etag?: string;
  lastModified?: string;
  timeoutMs?: number;
}

export type FetchResult =
  | { status: 'ok'; feed: ParsedFeed; etag?: string; lastModified?: string; finalUrl: string }
  | { status: 'notModified' };

export type FetchFn = (url: string, opts: FetchOptions) => Promise<FetchResult>;

const USER_AGENT = 'RSS-Feed-Curator/1.0 (+https://github.com/akashagarwal7/vscode-rss-reader)';
const ACCEPT =
  'application/rss+xml, application/atom+xml, application/feed+json, application/json;q=0.9, application/xml;q=0.9, text/xml;q=0.9, */*;q=0.5';

async function get(url: string, opts: FetchOptions): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 20_000);
  const headers: Record<string, string> = { 'User-Agent': USER_AGENT, Accept: ACCEPT };
  if (opts.etag) headers['If-None-Match'] = opts.etag;
  if (opts.lastModified) headers['If-Modified-Since'] = opts.lastModified;
  try {
    return await fetch(url, { headers, redirect: 'follow', signal: ctrl.signal });
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw new Error(`Timed out after ${(opts.timeoutMs ?? 20_000) / 1000}s`);
    const cause = (e as { cause?: { code?: string; message?: string } }).cause;
    throw new Error(cause?.code ?? cause?.message ?? (e as Error).message);
  } finally {
    clearTimeout(timer);
  }
}

export const fetchFeed: FetchFn = async (url, opts) => {
  const res = await get(url, opts);
  if (res.status === 304) return { status: 'notModified' };
  if (!res.ok) throw new Error(`HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''}`);
  const body = await res.text();
  const finalUrl = res.url || url;
  return {
    status: 'ok',
    feed: parseFeed(body, finalUrl),
    etag: res.headers.get('etag') ?? undefined,
    lastModified: res.headers.get('last-modified') ?? undefined,
    finalUrl,
  };
};

/**
 * Resolve user input to a feed: if the URL is a feed, return it; if it is an HTML page, return the feed links it
 * advertises.
 */
export async function probe(
  url: string,
): Promise<{ kind: 'feed'; url: string; feed: ParsedFeed } | { kind: 'page'; candidates: { url: string; title?: string }[] }> {
  const res = await get(url, {});
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.text();
  const finalUrl = res.url || url;
  try {
    return { kind: 'feed', url, feed: parseFeed(body, finalUrl) };
  } catch (e) {
    if (!(e instanceof NotAFeedError)) throw e;
    return { kind: 'page', candidates: discoverFeedLinks(body, finalUrl) };
  }
}
