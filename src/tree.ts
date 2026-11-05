import * as vscode from 'vscode';
import type { Controller } from './controller';
import { htmlToText } from './parser';
import type { ResolvedSource } from './sources';
import type { StoredItem } from './store';

export type Node = { kind: 'feed'; source: ResolvedSource } | { kind: 'item'; source: ResolvedSource; item: StoredItem };

export function relativeTime(ms: number, now = Date.now()): string {
  const s = Math.round((now - ms) / 1000);
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(ms).toLocaleDateString();
}

function escapeMd(s: string): string {
  return s.replace(/[\\`*_{}[\]()#+\-.!|<>]/g, '\\$&');
}

export class FeedTree implements vscode.TreeDataProvider<Node> {
  private readonly emitter = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  unreadOnly = false;

  constructor(private readonly ctl: Controller) {}

  refresh(): void {
    this.emitter.fire(undefined);
  }

  getParent(node: Node): Node | undefined {
    return node.kind === 'item' ? { kind: 'feed', source: node.source } : undefined;
  }

  getChildren(node?: Node): Node[] {
    if (!node) {
      return this.ctl.sources
        .filter((s) => !this.unreadOnly || this.ctl.unreadCount(s.url) > 0)
        .map((source) => ({ kind: 'feed' as const, source }));
    }
    if (node.kind === 'feed') {
      const items = this.ctl.items(node.source.url);
      return items
        .filter((item) => !this.unreadOnly || !this.ctl.isRead(item))
        .map((item) => ({ kind: 'item' as const, source: node.source, item }));
    }
    return [];
  }

  getTreeItem(node: Node): vscode.TreeItem {
    return node.kind === 'feed' ? this.feedItem(node.source) : this.itemItem(node.source, node.item);
  }

  private feedItem(source: ResolvedSource): vscode.TreeItem {
    const entry = this.ctl.entry(source.url);
    const unread = this.ctl.unreadCount(source.url);
    const t = new vscode.TreeItem(this.ctl.displayName(source), vscode.TreeItemCollapsibleState.Collapsed);
    t.id = `feed:${source.url}`;
    const parts: string[] = [];
    if (unread) parts.push(`${unread} unread`);
    if (source.scope === 'project' && (vscode.workspace.workspaceFolders?.length ?? 0) > 1) parts.push(source.folder ?? '');
    if (entry?.error) parts.push('⚠ failed');
    else if (!entry?.lastFetched) parts.push('not fetched yet');
    t.description = parts.filter(Boolean).join(' · ');
    t.iconPath = entry?.error
      ? new vscode.ThemeIcon('warning', new vscode.ThemeColor('list.warningForeground'))
      : new vscode.ThemeIcon(source.scope === 'global' ? 'globe' : 'root-folder');
    t.contextValue = `feed-${source.scope}`;
    const md = new vscode.MarkdownString(undefined, true);
    md.appendMarkdown(`**${escapeMd(this.ctl.displayName(source))}**  \n`);
    md.appendMarkdown(`${source.scope === 'global' ? '$(globe) Global' : `$(root-folder) Project · ${escapeMd(source.folder ?? '')}`}  \n`);
    md.appendMarkdown(`[${escapeMd(source.url)}](${source.url})  \n`);
    if (entry?.lastFetched) md.appendMarkdown(`Last fetched ${relativeTime(entry.lastFetched)}  \n`);
    if (entry?.error) md.appendMarkdown(`$(warning) ${escapeMd(entry.error)}`);
    t.tooltip = md;
    return t;
  }

  private itemItem(source: ResolvedSource, item: StoredItem): vscode.TreeItem {
    const read = this.ctl.isRead(item);
    const t = new vscode.TreeItem(item.title, vscode.TreeItemCollapsibleState.None);
    t.id = `item:${item.key}`;
    t.description = [relativeTime(item.published ?? item.firstSeen), item.author].filter(Boolean).join(' · ');
    t.iconPath = read
      ? new vscode.ThemeIcon('circle-outline', new vscode.ThemeColor('disabledForeground'))
      : new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('charts.blue'));
    t.contextValue = read ? 'item-read' : 'item-unread';
    t.command = { command: 'rssCurator.openItem', title: 'Open', arguments: [{ kind: 'item', source, item }] };
    const md = new vscode.MarkdownString(undefined, true);
    md.appendMarkdown(`**${escapeMd(item.title)}**  \n`);
    const meta = [this.ctl.displayName(source), item.author, item.published ? new Date(item.published).toLocaleString() : undefined]
      .filter(Boolean)
      .map((s) => escapeMd(s!));
    md.appendMarkdown(`_${meta.join(' · ')}_\n\n`);
    if (item.summary) md.appendMarkdown(escapeMd(htmlToText(item.summary)).slice(0, 600) + '\n\n');
    if (item.link) md.appendMarkdown(`[${escapeMd(item.link)}](${item.link})`);
    t.tooltip = md;
    t.accessibilityInformation = { label: `${read ? '' : 'Unread: '}${item.title}` };
    return t;
  }
}
