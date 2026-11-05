import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { ExtensionApi } from '../../extension';

const rss = (ids: number[]) =>
  `<?xml version="1.0"?><rss version="2.0"><channel><title>Test Feed</title><link>http://localhost/</link>${ids
    .map((i) => `<item><guid>id-${i}</guid><title>Post ${i}</title><link>http://localhost/${i}</link><pubDate>${new Date(Date.UTC(2026, 0, i)).toUTCString()}</pubDate></item>`)
    .join('')}</channel></rss>`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, what: string, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await sleep(50);
  }
}

/** Executed inside a real VS Code extension host. Throw to fail. */
export async function run(): Promise<void> {
  let ids = [1, 2];
  const server = createServer((req, res) => {
    if (req.url === '/project.xml') {
      res.writeHead(200, { 'content-type': 'application/rss+xml' }).end(rss([100]));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/rss+xml' }).end(rss(ids));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  try {
    const ext = vscode.extensions.getExtension<ExtensionApi>('akashagarwal.rss-feed-curator');
    assert.ok(ext, 'extension is installed');
    const api = await ext.activate();
    await api.ready;
    const ctl = api.controller;
    assert.ok(ctl.store.dir.includes('rssc-data-'), `uses test data dir (${ctl.store.dir})`);

    const commands = await vscode.commands.getCommands(true);
    for (const c of ['rssCurator.addFeed', 'rssCurator.refresh', 'rssCurator.markAllRead', 'rssCurator.openProjectFeeds']) {
      assert.ok(commands.includes(c), `${c} registered`);
    }

    // Global feed: first fetch seeds items without "new" notifications.
    await api.addSource({ url: `${base}/global.xml`, name: 'Global One' }, 'global');
    assert.equal(ctl.sources[0].scope, 'global');
    const r1 = await api.refresh(true);
    assert.ok(r1, 'refresh ran');
    assert.deepEqual(r1.initial, [`${base}/global.xml`]);
    assert.equal(api.unreadCount(), 2);

    // Read state persists to disk.
    const first = ctl.items(`${base}/global.xml`)[0];
    assert.equal(first.title, 'Post 2');
    await vscode.commands.executeCommand('rssCurator.markRead', { kind: 'item', source: ctl.sources[0], item: first });
    assert.equal(api.unreadCount(), 1);
    const onDisk = JSON.parse(readFileSync(path.join(ctl.store.dir, 'read.json'), 'utf8'));
    assert.ok(first.key in onDisk.read, 'read state written to disk');

    // A new post appears → reported as new.
    ids = [1, 2, 3];
    const r2 = await api.refresh(true);
    assert.deepEqual(r2?.newItems.map((n) => n.item.title), ['Post 3']);
    assert.equal(api.unreadCount(), 2);

    // Project feed via .vscode/rss-feeds.json is picked up by the watcher.
    const ws = process.env.TEST_WORKSPACE!;
    // Create it the way a user would: through the editor (watchers alone are unreliable on CI).
    const projectUri = vscode.Uri.file(path.join(ws, '.vscode', 'rss-feeds.json'));
    const edit = new vscode.WorkspaceEdit();
    edit.createFile(projectUri, { ignoreIfExists: true });
    edit.insert(projectUri, new vscode.Position(0, 0), JSON.stringify({ feeds: [{ url: `${base}/project.xml` }] }));
    assert.ok(await vscode.workspace.applyEdit(edit), 'created project feeds file');
    await (await vscode.workspace.openTextDocument(projectUri)).save();
    await until(() => ctl.sources.some((s) => s.scope === 'project'), 'project source', 15000);
    await until(() => ctl.unreadCount(`${base}/project.xml`) === 1, 'project feed fetched', 10000);
    assert.equal(ctl.displayName(ctl.sources.find((s) => s.scope === 'project')!), 'Test Feed');

    // Mark feed read via command.
    await vscode.commands.executeCommand('rssCurator.markFeedRead', { kind: 'feed', source: ctl.sources[0] });
    assert.equal(ctl.unreadCount(`${base}/global.xml`), 0);

    // Removing a feed rewrites the global file.
    await ctl.removeSource(ctl.sources[0]);
    const globalFile = JSON.parse(readFileSync(ctl.store.globalFeedsPath, 'utf8'));
    assert.deepEqual(globalFile.feeds, []);
    assert.equal(ctl.sources.length, 1);
  } finally {
    server.close();
  }
  console.log('Integration test passed');
}
