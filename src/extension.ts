import * as vscode from 'vscode';
import { Controller, SECTION } from './controller';
import { probe } from './fetcher';
import type { RefreshResult } from './refresh';
import { normalizeUrl, type FeedSource, type ResolvedSource, type Scope } from './sources';
import type { StoredItem } from './store';
import { FeedTree, type Node } from './tree';

/** Returned from activate() so integration tests can drive the extension. */
export interface ExtensionApi {
  controller: Controller;
  /** Resolves once sources and state have loaded. */
  ready: Promise<void>;
  addSource(source: FeedSource, scope: Scope): Promise<void>;
  refresh(force?: boolean): Promise<RefreshResult | undefined>;
  unreadCount(): number;
}

type ItemArg = Node | StoredItem | undefined;

function toItem(arg: ItemArg): StoredItem | undefined {
  if (!arg) return undefined;
  if ('kind' in arg) return arg.kind === 'item' ? arg.item : undefined;
  return arg;
}

export function activate(context: vscode.ExtensionContext): ExtensionApi {
  const log = vscode.window.createOutputChannel('RSS Feed Curator', { log: true });
  const ctl = new Controller(log);
  const tree = new FeedTree(ctl);
  const view = vscode.window.createTreeView('rssCurator.feeds', { treeDataProvider: tree, showCollapseAll: true });
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 50);
  status.command = 'rssCurator.feeds.focus';

  tree.unreadOnly = context.globalState.get('unreadOnly', false);
  const setUnreadOnly = async (v: boolean) => {
    tree.unreadOnly = v;
    await context.globalState.update('unreadOnly', v);
    await vscode.commands.executeCommand('setContext', 'rssCurator.unreadOnly', v);
    tree.refresh();
  };
  void vscode.commands.executeCommand('setContext', 'rssCurator.unreadOnly', tree.unreadOnly);

  const render = () => {
    tree.refresh();
    const unread = ctl.unreadCount();
    view.badge = unread ? { value: unread, tooltip: `${unread} unread` } : undefined;
    view.message = ctl.sourceErrors.length ? `⚠ ${ctl.sourceErrors[0]}` : undefined;
    void vscode.commands.executeCommand('setContext', 'rssCurator.hasFeeds', ctl.sources.length > 0);
    if (cfg().get<boolean>('statusBar', true) && (unread || ctl.refreshing)) {
      status.text = ctl.refreshing ? `$(sync~spin) ${unread || ''}`.trim() : `$(rss) ${unread}`;
      status.tooltip = ctl.refreshing ? 'Refreshing feeds…' : `${unread} unread post${unread === 1 ? '' : 's'}`;
      status.show();
    } else {
      status.hide();
    }
  };
  const cfg = () => vscode.workspace.getConfiguration(SECTION);

  const pickScope = async (): Promise<{ scope: Scope; folder?: vscode.WorkspaceFolder } | undefined> => {
    const folders = (vscode.workspace.workspaceFolders ?? []).filter((f) => f.uri.scheme === 'file');
    if (!folders.length) return { scope: 'global' };
    const picks: (vscode.QuickPickItem & { scope: Scope; folder?: vscode.WorkspaceFolder })[] = [
      { label: '$(globe) Global', description: 'All windows, all projects', detail: ctl.store.globalFeedsPath, scope: 'global' },
      ...folders.map((f) => ({
        label: `$(root-folder) Project: ${f.name}`,
        description: 'Only when this folder is open',
        detail: vscode.Uri.joinPath(f.uri, '.vscode', 'rss-feeds.json').fsPath,
        scope: 'project' as const,
        folder: f,
      })),
    ];
    return vscode.window.showQuickPick(picks, { title: 'Save feed to…', ignoreFocusOut: true });
  };

  const openItem = async (arg: ItemArg) => {
    const item = toItem(arg);
    if (!item) return;
    await ctl.setRead([item.key], true);
    if (!item.link) return;
    if (cfg().get<string>('openIn') === 'editor') {
      try {
        await vscode.commands.executeCommand('simpleBrowser.show', item.link);
        return;
      } catch {
        // Simple Browser unavailable — fall through.
      }
    }
    await vscode.env.openExternal(vscode.Uri.parse(item.link));
  };

  const selectedItems = (arg: ItemArg, selection?: Node[]): StoredItem[] => {
    const nodes = selection?.length ? selection : arg ? [arg] : view.selection;
    return nodes.map((n) => toItem(n as ItemArg)).filter((i): i is StoredItem => !!i);
  };

  const addFeed = async (prefill?: string) => {
    const input = await vscode.window.showInputBox({
      title: 'Add RSS / Atom feed',
      prompt: 'Feed URL, or a website URL to auto-discover its feed',
      placeHolder: 'https://example.com/feed.xml',
      value: typeof prefill === 'string' ? prefill : undefined,
      ignoreFocusOut: true,
      validateInput: (v) => (normalizeUrl(v) ? undefined : 'Enter an http(s) URL'),
    });
    const url0 = input && normalizeUrl(input);
    if (!url0) return;

    let url = url0;
    let title: string | undefined;
    try {
      const res = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Checking ${url0}…` },
        () => probe(url0),
      );
      if (res.kind === 'feed') {
        title = res.feed.title;
      } else if (res.candidates.length) {
        const pick =
          res.candidates.length === 1
            ? res.candidates[0]
            : await vscode.window.showQuickPick(
                res.candidates.map((c) => ({ label: c.title ?? c.url, description: c.url, c })),
                { title: 'This page advertises several feeds — pick one', ignoreFocusOut: true },
              ).then((p) => p?.c);
        if (!pick) return;
        url = pick.url;
        title = pick.title;
      } else {
        const go = await vscode.window.showWarningMessage(`No feed found at ${url0}.`, 'Add Anyway');
        if (go !== 'Add Anyway') return;
      }
    } catch (e) {
      const go = await vscode.window.showWarningMessage(`Couldn't fetch ${url0}: ${(e as Error).message}`, 'Add Anyway');
      if (go !== 'Add Anyway') return;
    }

    const name = await vscode.window.showInputBox({
      title: 'Feed name (optional)',
      value: title ?? '',
      prompt: 'Leave empty to use the title from the feed',
      ignoreFocusOut: true,
    });
    if (name === undefined) return;
    const target = await pickScope();
    if (!target) return;
    try {
      await ctl.addSource({ url, name: name.trim() || undefined }, target.scope, target.folder);
    } catch (e) {
      void vscode.window.showErrorMessage((e as Error).message);
      return;
    }
    await ctl.refresh(true, [url]);
    const n = ctl.unreadCount(url);
    const entry = ctl.entry(url);
    if (entry?.error) void vscode.window.showWarningMessage(`Added feed, but fetching failed: ${entry.error}`);
    else void vscode.window.showInformationMessage(`Added ${name.trim() || entry?.title || url} (${n} unread).`);
  };

  const openSourcesFile = async (scope: Scope) => {
    let folder: vscode.WorkspaceFolder | undefined;
    if (scope === 'project') {
      const folders = (vscode.workspace.workspaceFolders ?? []).filter((f) => f.uri.scheme === 'file');
      if (!folders.length) {
        void vscode.window.showWarningMessage('Open a folder to use project feeds.');
        return;
      }
      folder = folders.length === 1 ? folders[0] : await vscode.window.showWorkspaceFolderPick();
      if (!folder) return;
    }
    const file = await ctl.ensureSourceFile(scope, folder);
    await vscode.window.showTextDocument(vscode.Uri.file(file));
  };

  const reg = (id: string, fn: (...args: any[]) => unknown) => vscode.commands.registerCommand(id, fn);

  context.subscriptions.push(
    log,
    ctl,
    view,
    status,
    ctl.onDidChange(render),
    reg('rssCurator.refresh', () =>
      vscode.window.withProgress({ location: { viewId: 'rssCurator.feeds' } }, async () => {
        const res = await ctl.refresh(true);
        if (res?.errors.length) {
          void vscode.window.showWarningMessage(`${res.errors.length} feed(s) failed to refresh. See Output › RSS Feed Curator.`);
        }
      }),
    ),
    reg('rssCurator.refreshFeed', (n?: Node) => {
      if (n?.kind === 'feed') return vscode.window.withProgress({ location: { viewId: 'rssCurator.feeds' } }, () => ctl.refresh(true, [n.source.url]));
    }),
    reg('rssCurator.addFeed', addFeed),
    reg('rssCurator.removeFeed', async (n?: Node) => {
      if (n?.kind !== 'feed') return;
      const name = ctl.displayName(n.source);
      const ok = await vscode.window.showWarningMessage(
        `Remove "${name}" from ${n.source.scope === 'global' ? 'global' : `${n.source.folder} project`} feeds?`,
        { modal: true },
        'Remove',
      );
      if (ok === 'Remove') await ctl.removeSource(n.source as ResolvedSource);
    }),
    reg('rssCurator.openGlobalFeeds', () => openSourcesFile('global')),
    reg('rssCurator.openProjectFeeds', () => openSourcesFile('project')),
    reg('rssCurator.openItem', openItem),
    reg('rssCurator.markRead', (arg?: ItemArg, sel?: Node[]) => ctl.setRead(selectedItems(arg, sel).map((i) => i.key), true)),
    reg('rssCurator.markUnread', (arg?: ItemArg, sel?: Node[]) => ctl.setRead(selectedItems(arg, sel).map((i) => i.key), false)),
    reg('rssCurator.markFeedRead', (n?: Node) => {
      if (n?.kind === 'feed') return ctl.setRead(ctl.unreadItems(n.source.url).map((i) => i.key), true);
    }),
    reg('rssCurator.markAllRead', async () => {
      const items = ctl.unreadItems();
      if (!items.length) return;
      const ok = await vscode.window.showWarningMessage(`Mark ${items.length} posts as read?`, { modal: true }, 'Mark All Read');
      if (ok) await ctl.setRead(items.map((i) => i.key), true);
    }),
    reg('rssCurator.copyLink', async (arg?: ItemArg) => {
      const item = toItem(arg);
      if (item?.link) await vscode.env.clipboard.writeText(item.link);
    }),
    reg('rssCurator.openFeedSite', async (n?: Node) => {
      if (n?.kind !== 'feed') return;
      const link = ctl.entry(n.source.url)?.link ?? n.source.url;
      await vscode.env.openExternal(vscode.Uri.parse(link));
    }),
    reg('rssCurator.showUnreadOnly', () => setUnreadOnly(true)),
    reg('rssCurator.showAll', () => setUnreadOnly(false)),
    reg('rssCurator.nextUnread', async () => {
      const next = ctl.sources.flatMap((s) => ctl.items(s.url).filter((i) => !ctl.isRead(i)).map((item) => ({ source: s, item })))[0];
      if (!next) {
        void vscode.window.showInformationMessage('No unread posts.');
        return;
      }
      await openItem({ kind: 'item', ...next });
    }),
    reg('rssCurator.showLog', () => log.show()),
  );

  render();
  const ready = ctl.start().catch((e) => log.error(`Failed to start: ${(e as Error).message}`));

  return {
    controller: ctl,
    ready,
    addSource: (s, scope) => ctl.addSource(s, scope, scope === 'project' ? vscode.workspace.workspaceFolders?.[0] : undefined),
    refresh: (force = true) => ctl.refresh(force),
    unreadCount: () => ctl.unreadCount(),
  };
}

export function deactivate(): void {}
