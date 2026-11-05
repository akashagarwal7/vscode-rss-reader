import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import type { FetchFn } from '../fetcher';
import type { ParsedItem } from '../parser';
import { isDue, mergeItems, refreshFeeds } from '../refresh';
import { Store } from '../store';
import { osascriptArgs, terminalNotifierArgs } from '../systemNotify';

const H = 3600_000;
const item = (id: string, published?: number): ParsedItem => ({ id, title: `T${id}`, link: `https://x/${id}`, published });
const tmpStore = () => new Store(mkdtempSync(path.join(tmpdir(), 'rssc-')));

test('isDue', () => {
  assert.equal(isDue(undefined, 0, H, H), true);
  assert.equal(isDue({ items: [], lastAttempt: 0 + 1 }, H, H, H), false);
  assert.equal(isDue({ items: [], lastAttempt: 1 }, H + 1, H, H), true);
  assert.equal(isDue({ items: [], lastAttempt: 1, claimedUntil: 10 * H }, 5 * H, H, H), false);
  assert.equal(isDue({ items: [], lastAttempt: 1, error: 'x' }, 16 * 60_000, 2 * H, 15 * 60_000), true);
});

test('mergeItems detects additions, keeps firstSeen, sorts and caps', () => {
  const a = mergeItems('f', [], [item('1', 100), item('2', 200)], 1000, 10);
  assert.deepEqual(a.items.map((i) => i.id), ['2', '1']);
  assert.equal(a.added.length, 2);
  const b = mergeItems('f', a.items, [item('3', 300), item('2', 200)], 2000, 2);
  assert.deepEqual(b.items.map((i) => i.id), ['3', '2']);
  assert.deepEqual(b.added.map((i) => i.id), ['3']);
  assert.equal(b.items[1].firstSeen, 1000);
  assert.equal(b.items[1].key, a.items[0].key);
});

test('refreshFeeds: first fetch is silent, later additions are new, interval respected', async () => {
  const store = tmpStore();
  await store.init();
  let items = [item('1', 1), item('2', 2)];
  let calls = 0;
  const fetchFn: FetchFn = async () => {
    calls++;
    return { status: 'ok', feed: { title: 'Feed', items }, finalUrl: 'u' };
  };
  let now = 10 * H;
  const opts = { intervalMs: 2 * H, maxItemsPerFeed: 50, now: () => now };

  const r1 = await refreshFeeds(store, ['u'], fetchFn, opts);
  assert.deepEqual(r1.initial, ['u']);
  assert.equal(r1.newItems.length, 0);

  items = [item('3', 3), ...items];
  now += H;
  const r2 = await refreshFeeds(store, ['u'], fetchFn, opts);
  assert.equal(r2.fetched.length, 0, 'not due yet');
  assert.equal(calls, 1);

  now += H;
  const r3 = await refreshFeeds(store, ['u'], fetchFn, opts);
  assert.deepEqual(r3.newItems.map((n) => n.item.id), ['3']);
  assert.equal(r3.newItems[0].feedTitle, 'Feed');
  assert.equal((await store.readCache()).feeds.u.items.length, 3);
});

test('refreshFeeds: concurrent windows fetch once', async () => {
  const store = tmpStore();
  await store.init();
  let calls = 0;
  const fetchFn: FetchFn = async () => {
    calls++;
    await new Promise((r) => setTimeout(r, 50));
    return { status: 'ok', feed: { items: [item('1')] }, finalUrl: 'u' };
  };
  const opts = { intervalMs: 2 * H, maxItemsPerFeed: 50 };
  await Promise.all([refreshFeeds(store, ['u'], fetchFn, opts), refreshFeeds(store, ['u'], fetchFn, opts), refreshFeeds(store, ['u'], fetchFn, opts)]);
  assert.equal(calls, 1);
});

test('refreshFeeds: errors recorded, notModified keeps items', async () => {
  const store = tmpStore();
  await store.init();
  const fail: FetchFn = async () => {
    throw new Error('boom');
  };
  const r = await refreshFeeds(store, ['u'], fail, { intervalMs: H, maxItemsPerFeed: 10 });
  assert.deepEqual(r.errors, [{ url: 'u', error: 'boom' }]);
  assert.equal((await store.readCache()).feeds.u.error, 'boom');

  const ok: FetchFn = async () => ({ status: 'ok', feed: { items: [item('1')] }, finalUrl: 'u', etag: 'e1' });
  await refreshFeeds(store, ['u'], ok, { intervalMs: H, maxItemsPerFeed: 10, force: true });
  let seen: string | undefined;
  const nm: FetchFn = async (_u, o) => {
    seen = o.etag;
    return { status: 'notModified' };
  };
  await refreshFeeds(store, ['u'], nm, { intervalMs: H, maxItemsPerFeed: 10, force: true });
  const c = await store.readCache();
  assert.equal(seen, 'e1');
  assert.equal(c.feeds.u.items.length, 1);
  assert.equal(c.feeds.u.error, undefined);
});

test('read state persists and prunes', async () => {
  const store = tmpStore();
  await store.init();
  await store.setRead(['a', 'b'], true, 0);
  await store.setRead(['b'], false);
  assert.deepEqual(Object.keys((await store.readReadState()).read), ['a']);
  const other = new Store(store.dir); // another window
  assert.deepEqual(Object.keys((await other.readReadState()).read), ['a']);
  await store.pruneReadState(1000, 5000);
  assert.deepEqual((await store.readReadState()).read, {});
});

test('notification args never interpolate into AppleScript', () => {
  const args = osascriptArgs({ title: 'T "x"', message: 'end run\n"; do shell script "rm"', subtitle: 's' });
  assert.ok(!args.slice(0, 6).join(' ').includes('rm'));
  assert.deepEqual(args.slice(6), ['end run\n"; do shell script "rm"', 'T "x"', 's']);
  assert.deepEqual(terminalNotifierArgs({ title: '-x', message: 'm', url: 'https://a' }).slice(0, 2), ['-title', '​-x']);
});
