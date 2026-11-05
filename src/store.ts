// Shared on-disk state (feed cache + read state), safe across editor windows and editors. No `vscode` import.
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { ParsedItem } from './parser';

export interface StoredItem extends ParsedItem {
  /** Globally unique key (hash of feed URL + item id) used for read state. */
  key: string;
  firstSeen: number;
}

export interface FeedEntry {
  title?: string;
  link?: string;
  items: StoredItem[];
  etag?: string;
  lastModified?: string;
  /** Last successful fetch (ms). */
  lastFetched?: number;
  /** Last attempt started (ms). */
  lastAttempt?: number;
  /** A window claimed this feed for fetching until this time (ms). */
  claimedUntil?: number;
  error?: string;
}

export interface CacheFile {
  version: 1;
  feeds: Record<string, FeedEntry>;
}

export interface ReadFile {
  version: 1;
  /** item key → time it was marked read (ms) */
  read: Record<string, number>;
}

export function itemKey(feedUrl: string, id: string): string {
  return createHash('sha1').update(`${feedUrl}\n${id}`).digest('hex').slice(0, 20);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class Store {
  readonly cachePath: string;
  readonly readPath: string;
  readonly globalFeedsPath: string;
  private readonly lockPath: string;

  constructor(readonly dir: string) {
    this.cachePath = path.join(dir, 'cache.json');
    this.readPath = path.join(dir, 'read.json');
    this.globalFeedsPath = path.join(dir, 'feeds.json');
    this.lockPath = path.join(dir, '.lock');
  }

  async init(): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
  }

  /** Cross-process mutex using an atomic mkdir; stale locks (>30s) are broken. */
  async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const deadline = Date.now() + 10_000;
    for (;;) {
      try {
        await fs.mkdir(this.lockPath);
        break;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
        try {
          const st = await fs.stat(this.lockPath);
          if (Date.now() - st.mtimeMs > 30_000) {
            await fs.rm(this.lockPath, { recursive: true, force: true });
            continue;
          }
        } catch {
          continue; // vanished between mkdir and stat
        }
        if (Date.now() > deadline) throw new Error(`Timed out waiting for lock ${this.lockPath}`);
        await sleep(25 + Math.random() * 50);
      }
    }
    try {
      return await fn();
    } finally {
      await fs.rm(this.lockPath, { recursive: true, force: true });
    }
  }

  private async readJson<T>(file: string, fallback: T): Promise<T> {
    try {
      return JSON.parse(await fs.readFile(file, 'utf8')) as T;
    } catch {
      return fallback;
    }
  }

  private async writeJson(file: string, data: unknown): Promise<void> {
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(data));
    await fs.rename(tmp, file);
  }

  async readCache(): Promise<CacheFile> {
    const c = await this.readJson<CacheFile>(this.cachePath, { version: 1, feeds: {} });
    return c && typeof c.feeds === 'object' ? c : { version: 1, feeds: {} };
  }

  writeCache(c: CacheFile): Promise<void> {
    return this.writeJson(this.cachePath, c);
  }

  async readReadState(): Promise<ReadFile> {
    const r = await this.readJson<ReadFile>(this.readPath, { version: 1, read: {} });
    return r && typeof r.read === 'object' ? r : { version: 1, read: {} };
  }

  /** Mark keys read (true) or unread (false). Returns the new state. */
  async setRead(keys: string[], read: boolean, now = Date.now()): Promise<ReadFile> {
    return this.withLock(async () => {
      const state = await this.readReadState();
      for (const k of keys) {
        if (read) state.read[k] ??= now;
        else delete state.read[k];
      }
      await this.writeJson(this.readPath, state);
      return state;
    });
  }

  /** Drop read marks for items no longer cached and older than `maxAgeMs`. */
  async pruneReadState(maxAgeMs: number, now = Date.now()): Promise<void> {
    await this.withLock(async () => {
      const [state, cache] = await Promise.all([this.readReadState(), this.readCache()]);
      const live = new Set(Object.values(cache.feeds).flatMap((f) => f.items.map((i) => i.key)));
      let changed = false;
      for (const [k, t] of Object.entries(state.read)) {
        if (!live.has(k) && now - t > maxAgeMs) {
          delete state.read[k];
          changed = true;
        }
      }
      if (changed) await this.writeJson(this.readPath, state);
    });
  }
}
