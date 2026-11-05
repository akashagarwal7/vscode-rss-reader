// Pure helpers for feed source files (global `feeds.json`, project `.vscode/rss-feeds.json`). No `vscode` import.

export interface FeedSource {
  url: string;
  name?: string;
}

export type Scope = 'global' | 'project';

export interface ResolvedSource extends FeedSource {
  scope: Scope;
  /** For project sources: the workspace folder name + path of the file it came from. */
  folder?: string;
  file: string;
}

export interface SourcesFile {
  feeds: FeedSource[];
  [k: string]: unknown;
}

/** Remove // and /* *\/ comments and trailing commas, leaving string contents intact. */
export function stripJsonc(src: string): string {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '"') {
      let j = i + 1;
      while (j < src.length && src[j] !== '"') j += src[j] === '\\' ? 2 : 1;
      out += src.slice(i, j + 1);
      i = j + 1;
    } else if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++;
    } else if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end < 0 ? src.length : end + 2;
    } else {
      out += c;
      i++;
    }
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}

/** Parse a sources file. Accepts `{ "feeds": [...] }` or a bare array; entries may be strings or `{url, name}`. */
export function parseSourcesFile(content: string): { file: SourcesFile; errors: string[] } {
  const errors: string[] = [];
  if (!content.trim()) return { file: { feeds: [] }, errors };
  let raw: unknown;
  try {
    raw = JSON.parse(stripJsonc(content));
  } catch (e) {
    return { file: { feeds: [] }, errors: [`Invalid JSON: ${(e as Error).message}`] };
  }
  const obj: Record<string, unknown> = Array.isArray(raw) ? { feeds: raw } : (raw as Record<string, unknown>) ?? {};
  const list = Array.isArray(obj.feeds) ? obj.feeds : [];
  if (!Array.isArray(obj.feeds) && obj.feeds !== undefined) errors.push('"feeds" must be an array');
  const feeds: FeedSource[] = [];
  list.forEach((entry, i) => {
    const e = typeof entry === 'string' ? { url: entry } : (entry as Record<string, unknown>);
    const url = typeof e?.url === 'string' ? normalizeUrl(e.url) : undefined;
    if (!url) {
      errors.push(`feeds[${i}]: missing or invalid "url"`);
      return;
    }
    feeds.push({ url, name: typeof e.name === 'string' && e.name.trim() ? e.name.trim() : undefined });
  });
  return { file: { ...obj, feeds }, errors };
}

export function serializeSourcesFile(file: SourcesFile): string {
  const feeds = file.feeds.map((f) => (f.name ? { name: f.name, url: f.url } : { url: f.url }));
  return JSON.stringify({ ...file, feeds }, null, 2) + '\n';
}

/** Trim and validate an http(s) URL; adds https:// when the scheme is missing. */
export function normalizeUrl(input: string): string | undefined {
  let s = input.trim();
  if (!s) return undefined;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) s = `https://${s}`;
  try {
    const u = new URL(s);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return undefined;
    return u.toString();
  } catch {
    return undefined;
  }
}

/** Merge sources; the first occurrence of a URL wins (global first, then project folders in order). */
export function mergeSources(groups: ResolvedSource[][]): ResolvedSource[] {
  const seen = new Set<string>();
  const out: ResolvedSource[] = [];
  for (const g of groups) {
    for (const s of g) {
      if (seen.has(s.url)) continue;
      seen.add(s.url);
      out.push(s);
    }
  }
  return out;
}
