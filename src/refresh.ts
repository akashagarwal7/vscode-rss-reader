// Refresh orchestration: decides which feeds are due, claims them across windows, fetches and merges. No `vscode`.
import type { FetchFn } from './fetcher';
import type { ParsedFeed } from './parser';
import { itemKey, type FeedEntry, type Store, type StoredItem } from './store';

export interface RefreshOptions {
  intervalMs: number;
  maxItemsPerFeed: number;
  force?: boolean;
  now?: () => number;
  concurrency?: number;
  /** Retry delay after a failed fetch (capped at intervalMs). */
  retryMs?: number;
}

export interface NewItem {
  feedUrl: string;
  feedTitle: string;
  item: StoredItem;
}

export interface RefreshResult {
  fetched: string[];
  newItems: NewItem[];
  errors: { url: string; error: string }[];
  /** Feeds fetched successfully for the first time (their items are not reported as new). */
  initial: string[];
}

const CLAIM_MS = 2 * 60_000;

export function isDue(entry: FeedEntry | undefined, now: number, intervalMs: number, retryMs: number): boolean {
  if (!entry || !entry.lastAttempt) return true;
  if (entry.claimedUntil && entry.claimedUntil > now) return false;
  const wait = entry.error ? Math.min(retryMs, intervalMs) : intervalMs;
  return now - entry.lastAttempt >= wait;
}

/** Merge freshly fetched items into a stored list; returns the merged list and items not seen before. */
export function mergeItems(
  feedUrl: string,
  existing: StoredItem[],
  fetched: ParsedFeed['items'],
  now: number,
  max: number,
): { items: StoredItem[]; added: StoredItem[] } {
  const byId = new Map(existing.map((i) => [i.id, i]));
  const added: StoredItem[] = [];
  const fresh: StoredItem[] = [];
  const seenNow = new Set<string>();
  for (const f of fetched) {
    if (!f.id || seenNow.has(f.id)) continue;
    seenNow.add(f.id);
    const prev = byId.get(f.id);
    if (prev) {
      fresh.push({ ...prev, ...f, key: prev.key, firstSeen: prev.firstSeen, published: f.published ?? prev.published });
    } else {
      const item: StoredItem = { ...f, key: itemKey(feedUrl, f.id), firstSeen: now };
      fresh.push(item);
      added.push(item);
    }
  }
  const kept = existing.filter((i) => !seenNow.has(i.id));
  const items = sortItems([...fresh, ...kept]).slice(0, max);
  const keptKeys = new Set(items.map((i) => i.key));
  return { items, added: added.filter((i) => keptKeys.has(i.key)) };
}

export function sortItems(items: StoredItem[]): StoredItem[] {
  return [...items].sort((a, b) => (b.published ?? b.firstSeen) - (a.published ?? a.firstSeen));
}

async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await fn(items[idx]);
      }
    }),
  );
  return out;
}

/**
 * Refresh the given feed URLs. Only feeds that are due (or all, with `force`) and not claimed by another window are
 * fetched. Claims are written under the store lock so concurrent windows don't fetch (or notify) twice.
 */
export async function refreshFeeds(
  store: Store,
  urls: string[],
  fetchFn: FetchFn,
  opts: RefreshOptions,
): Promise<RefreshResult> {
  const now = opts.now ?? Date.now;
  const retryMs = opts.retryMs ?? 15 * 60_000;
  const result: RefreshResult = { fetched: [], newItems: [], errors: [], initial: [] };

  const claimed = await store.withLock(async () => {
    const cache = await store.readCache();
    const t = now();
    const due = [...new Set(urls)].filter((u) => {
      const e = cache.feeds[u];
      if (opts.force) return !(e?.claimedUntil && e.claimedUntil > t);
      return isDue(e, t, opts.intervalMs, retryMs);
    });
    if (!due.length) return [];
    for (const u of due) {
      const e = (cache.feeds[u] ??= { items: [] });
      e.lastAttempt = t;
      e.claimedUntil = t + CLAIM_MS;
    }
    await store.writeCache(cache);
    return due.map((u) => ({ url: u, etag: cache.feeds[u].etag, lastModified: cache.feeds[u].lastModified }));
  });
  if (!claimed.length) return result;

  const outcomes = await pool(claimed, opts.concurrency ?? 4, async (c) => {
    try {
      return { url: c.url, res: await fetchFn(c.url, { etag: c.etag, lastModified: c.lastModified }) };
    } catch (e) {
      return { url: c.url, error: (e as Error).message || String(e) };
    }
  });

  await store.withLock(async () => {
    const cache = await store.readCache();
    const t = now();
    for (const o of outcomes) {
      const e = (cache.feeds[o.url] ??= { items: [] });
      e.claimedUntil = undefined;
      if ('error' in o && o.error !== undefined) {
        e.error = o.error;
        result.errors.push({ url: o.url, error: o.error });
        continue;
      }
      const res = o.res!;
      result.fetched.push(o.url);
      e.error = undefined;
      const firstTime = !e.lastFetched;
      e.lastFetched = t;
      if (res.status === 'notModified') continue;
      e.etag = res.etag;
      e.lastModified = res.lastModified;
      e.title = res.feed.title ?? e.title;
      e.link = res.feed.link ?? e.link;
      const { items, added } = mergeItems(o.url, e.items, res.feed.items, t, opts.maxItemsPerFeed);
      e.items = items;
      if (firstTime) result.initial.push(o.url);
      else for (const item of added) result.newItems.push({ feedUrl: o.url, feedTitle: e.title ?? o.url, item });
    }
    await store.writeCache(cache);
  });
  return result;
}
