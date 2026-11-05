import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { fetchFeed, type FetchFn } from './fetcher';
import { refreshFeeds, sortItems, type NewItem, type RefreshResult } from './refresh';
import {
  mergeSources,
  parseSourcesFile,
  serializeSourcesFile,
  type FeedSource,
  type ResolvedSource,
  type Scope,
} from './sources';
import { Store, type CacheFile, type FeedEntry, type ReadFile, type StoredItem } from './store';
import { showSystemNotification } from './systemNotify';

export const SECTION = 'rssCurator';
export const PROJECT_FILE = path.join('.vscode', 'rss-feeds.json');
const TICK_MS = 5 * 60_000;
const READ_RETENTION_MS = 180 * 24 * 60 * 60_000;

const GLOBAL_TEMPLATE = `{
  // Global feeds, shared by every VS Code / Cursor window on this machine.
  // Per-project feeds go in <workspace>/.vscode/rss-feeds.json (same format).
  "feeds": [
    // { "name": "Hacker News", "url": "https://news.ycombinator.com/rss" }
  ]
}
`;
const PROJECT_TEMPLATE = `{
  // Feeds for this project only. Global feeds live in ~/.rss-feed-curator/feeds.json.
  "feeds": [
    // { "name": "TypeScript releases", "url": "https://github.com/microsoft/TypeScript/releases.atom" }
  ]
}
`;

function cfg() {
  return vscode.workspace.getConfiguration(SECTION);
}

export function resolveDataDir(): string {
  const configured = cfg().get<string>('dataDirectory')?.trim() || process.env.RSS_CURATOR_DATA_DIR || '~/.rss-feed-curator';
  return path.resolve(configured.replace(/^~(?=$|[\\/])/, os.homedir()));
}

export class Controller implements vscode.Disposable {
  store: Store;
  sources: ResolvedSource[] = [];
  sourceErrors: string[] = [];
  cache: CacheFile = { version: 1, feeds: {} };
  readState: ReadFile = { version: 1, read: {} };
  refreshing = false;

  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  private readonly disposables: vscode.Disposable[] = [this.changed];
  private storeWatcher?: vscode.Disposable;
  private timer?: NodeJS.Timeout;
  private reloadTimer?: NodeJS.Timeout;

  constructor(
    private readonly log: vscode.LogOutputChannel,
    private readonly fetchFn: FetchFn = fetchFeed,
  ) {
    this.store = new Store(resolveDataDir());
  }

  async start(): Promise<void> {
    await this.store.init();
    this.watchStore();
    const projectWatcher = vscode.workspace.createFileSystemWatcher('**/.vscode/rss-feeds.json');
    const onProject = () => this.scheduleReload(true);
    this.disposables.push(
      projectWatcher,
      projectWatcher.onDidChange(onProject),
      projectWatcher.onDidCreate(onProject),
      projectWatcher.onDidDelete(onProject),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.reloadSources().then(() => this.tick())),
      vscode.workspace.onDidChangeConfiguration(async (e) => {
        if (e.affectsConfiguration(`${SECTION}.dataDirectory`)) {
          this.store = new Store(resolveDataDir());
          await this.store.init();
          this.watchStore();
          await this.reloadAll();
          void this.tick();
        } else if (e.affectsConfiguration(SECTION)) {
          this.changed.fire();
        }
      }),
      // Other windows may have fetched or marked items read while this one was in the background.
      vscode.window.onDidChangeWindowState((s) => {
        if (s.focused) void this.reloadState().then(() => this.tick());
      }),
    );
    await this.reloadAll();
    void this.store.pruneReadState(READ_RETENTION_MS).catch(() => undefined);
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    setTimeout(() => void this.tick(), 3_000);
  }

  private watchStore(): void {
    this.storeWatcher?.dispose();
    const w = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.file(this.store.dir), '{cache,read,feeds}.json'),
    );
    const on = (uri: vscode.Uri) => this.scheduleReload(path.basename(uri.fsPath) === 'feeds.json');
    this.storeWatcher = vscode.Disposable.from(w, w.onDidChange(on), w.onDidCreate(on), w.onDidDelete(on));
  }

  private pendingSourceReload = false;
  private scheduleReload(sources: boolean): void {
    this.pendingSourceReload ||= sources;
    clearTimeout(this.reloadTimer);
    this.reloadTimer = setTimeout(async () => {
      const withSources = this.pendingSourceReload;
      this.pendingSourceReload = false;
      if (withSources) {
        const before = new Set(this.sources.map((s) => s.url));
        await this.reloadSources();
        if (this.sources.some((s) => !before.has(s.url))) void this.tick();
      }
      await this.reloadState();
    }, 200);
  }

  async reloadAll(): Promise<void> {
    await this.reloadSources();
    await this.reloadState();
  }

  async reloadState(): Promise<void> {
    [this.cache, this.readState] = await Promise.all([this.store.readCache(), this.store.readReadState()]);
    this.changed.fire();
  }

  async reloadSources(): Promise<void> {
    const errors: string[] = [];
    const load = async (file: string, scope: Scope, folder?: string): Promise<ResolvedSource[]> => {
      let content: string;
      try {
        content = await fs.readFile(file, 'utf8');
      } catch {
        return [];
      }
      const parsed = parseSourcesFile(content);
      errors.push(...parsed.errors.map((e) => `${file}: ${e}`));
      return parsed.file.feeds.map((f) => ({ ...f, scope, folder, file }));
    };
    const groups = [await load(this.store.globalFeedsPath, 'global')];
    for (const wf of vscode.workspace.workspaceFolders ?? []) {
      if (wf.uri.scheme !== 'file') continue;
      groups.push(await load(path.join(wf.uri.fsPath, PROJECT_FILE), 'project', wf.name));
    }
    this.sources = mergeSources(groups);
    this.sourceErrors = errors;
    for (const e of errors) this.log.warn(e);
    this.changed.fire();
  }

  // ---- queries -------------------------------------------------------------------------------------------------

  entry(url: string): FeedEntry | undefined {
    return this.cache.feeds[url];
  }

  items(url: string): StoredItem[] {
    return sortItems(this.cache.feeds[url]?.items ?? []);
  }

  isRead(item: StoredItem): boolean {
    return item.key in this.readState.read;
  }

  unreadItems(url?: string): StoredItem[] {
    const urls = url ? [url] : this.sources.map((s) => s.url);
    return urls.flatMap((u) => this.items(u).filter((i) => !this.isRead(i)));
  }

  unreadCount(url?: string): number {
    return this.unreadItems(url).length;
  }

  displayName(source: FeedSource): string {
    return source.name ?? this.cache.feeds[source.url]?.title ?? source.url;
  }

  // ---- mutations -----------------------------------------------------------------------------------------------

  async setRead(keys: string[], read: boolean): Promise<void> {
    if (!keys.length) return;
    this.readState = await this.store.setRead(keys, read);
    this.changed.fire();
  }

  async tick(): Promise<RefreshResult | undefined> {
    return this.refresh(false);
  }

  /** Refresh due feeds (or all / the given URLs with `force`) and notify about new items. */
  async refresh(force: boolean, urls?: string[]): Promise<RefreshResult | undefined> {
    // Background ticks are dropped while busy; explicit refreshes queue behind the in-flight one.
    if (this.inflight) {
      if (!force) return undefined;
      await this.inflight.catch(() => undefined);
    }
    const p = this.doRefresh(force, urls);
    this.inflight = p;
    try {
      return await p;
    } finally {
      if (this.inflight === p) this.inflight = undefined;
    }
  }

  private inflight?: Promise<RefreshResult | undefined>;

  private async doRefresh(force: boolean, urls?: string[]): Promise<RefreshResult | undefined> {
    const targets = urls ?? this.sources.map((s) => s.url);
    if (!targets.length) return undefined;
    this.refreshing = true;
    this.changed.fire();
    try {
      const minutes = Math.max(5, cfg().get<number>('refreshIntervalMinutes') ?? 120);
      const res = await refreshFeeds(this.store, targets, this.fetchFn, {
        intervalMs: minutes * 60_000,
        maxItemsPerFeed: Math.max(10, cfg().get<number>('maxItemsPerFeed') ?? 200),
        force,
      });
      if (res.fetched.length || res.errors.length) {
        this.log.info(`Fetched ${res.fetched.length} feed(s), ${res.newItems.length} new item(s), ${res.errors.length} error(s)`);
      }
      for (const e of res.errors) this.log.warn(`${e.url}: ${e.error}`);
      await this.reloadState();
      const fresh = res.newItems.filter((n) => !this.isRead(n.item));
      if (fresh.length) void this.notify(fresh);
      return res;
    } catch (e) {
      this.log.error(`Refresh failed: ${(e as Error).message}`);
      return undefined;
    } finally {
      this.refreshing = false;
      this.changed.fire();
    }
  }

  private feedName(n: NewItem): string {
    const src = this.sources.find((s) => s.url === n.feedUrl);
    return src?.name ?? n.feedTitle;
  }

  private async notify(items: NewItem[]): Promise<void> {
    const feeds = [...new Set(items.map((n) => this.feedName(n)))];
    const single = items.length === 1 ? items[0] : undefined;

    if (cfg().get<boolean>('notifications.system', true)) {
      void showSystemNotification({
        title: single ? this.feedName(single) : `${items.length} new posts`,
        subtitle: single ? undefined : feeds.slice(0, 3).join(', ') + (feeds.length > 3 ? ` +${feeds.length - 3}` : ''),
        message: single ? single.item.title : items.slice(0, 3).map((n) => `• ${n.item.title}`).join('\n'),
        url: single?.item.link,
        sound: cfg().get<string>('notifications.systemSound') || undefined,
      });
    }

    if (cfg().get<boolean>('notifications.editor', true)) {
      if (single) {
        const pick = await vscode.window.showInformationMessage(
          `New in ${this.feedName(single)}: ${single.item.title}`,
          'Open',
          'Mark Read',
          'Show Feeds',
        );
        if (pick === 'Open') await vscode.commands.executeCommand('rssCurator.openItem', single.item);
        else if (pick === 'Mark Read') await this.setRead([single.item.key], true);
        else if (pick === 'Show Feeds') await vscode.commands.executeCommand('rssCurator.feeds.focus');
      } else {
        const list = feeds.slice(0, 3).join(', ') + (feeds.length > 3 ? ` and ${feeds.length - 3} more` : '');
        const pick = await vscode.window.showInformationMessage(
          `${items.length} new posts from ${list}`,
          'Show Feeds',
          'Mark All Read',
        );
        if (pick === 'Show Feeds') await vscode.commands.executeCommand('rssCurator.feeds.focus');
        else if (pick === 'Mark All Read') await this.setRead(items.map((n) => n.item.key), true);
      }
    }
  }

  // ---- sources -------------------------------------------------------------------------------------------------

  sourceFile(scope: Scope, folder?: vscode.WorkspaceFolder): string {
    if (scope === 'global') return this.store.globalFeedsPath;
    if (!folder) throw new Error('A workspace folder is required for project feeds');
    return path.join(folder.uri.fsPath, PROJECT_FILE);
  }

  /** Ensure a sources file exists (with a commented template) and return its path. */
  async ensureSourceFile(scope: Scope, folder?: vscode.WorkspaceFolder): Promise<string> {
    const file = this.sourceFile(scope, folder);
    try {
      await fs.access(file);
    } catch {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, scope === 'global' ? GLOBAL_TEMPLATE : PROJECT_TEMPLATE);
    }
    return file;
  }

  private async editSourceFile(file: string, edit: (feeds: FeedSource[]) => FeedSource[]): Promise<void> {
    let content = '';
    try {
      content = await fs.readFile(file, 'utf8');
    } catch {
      // new file
    }
    const parsed = parseSourcesFile(content);
    if (parsed.errors.some((e) => e.startsWith('Invalid JSON'))) {
      throw new Error(`${file} has invalid JSON; fix it first`);
    }
    parsed.file.feeds = edit(parsed.file.feeds);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, serializeSourcesFile(parsed.file));
  }

  async addSource(source: FeedSource, scope: Scope, folder?: vscode.WorkspaceFolder): Promise<void> {
    const file = this.sourceFile(scope, folder);
    await this.editSourceFile(file, (feeds) => [...feeds.filter((f) => f.url !== source.url), source]);
    await this.reloadSources();
  }

  async removeSource(source: ResolvedSource): Promise<void> {
    await this.editSourceFile(source.file, (feeds) => feeds.filter((f) => f.url !== source.url));
    await this.reloadSources();
  }

  dispose(): void {
    clearInterval(this.timer);
    clearTimeout(this.reloadTimer);
    this.storeWatcher?.dispose();
    for (const d of this.disposables) d.dispose();
  }
}
