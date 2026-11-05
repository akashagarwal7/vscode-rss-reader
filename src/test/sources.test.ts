import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mergeSources, normalizeUrl, parseSourcesFile, serializeSourcesFile, stripJsonc } from '../sources';

test('stripJsonc keeps URLs in strings', () => {
  const s = stripJsonc('{ // c\n "u": "https://a.b/c", /* x */ "v": [1,2,], }');
  assert.deepEqual(JSON.parse(s), { u: 'https://a.b/c', v: [1, 2] });
});

test('parseSourcesFile accepts strings, objects, bare arrays and reports errors', () => {
  const { file, errors } = parseSourcesFile('{"feeds": ["example.com/rss", {"url": "https://b.org/f", "name": " B "}, {"name": "x"}], "extra": 1}');
  assert.deepEqual(file.feeds, [{ url: 'https://example.com/rss', name: undefined }, { url: 'https://b.org/f', name: 'B' }]);
  assert.equal(file.extra, 1);
  assert.equal(errors.length, 1);
  assert.equal(parseSourcesFile('["https://a.org/"]').file.feeds.length, 1);
  assert.match(parseSourcesFile('{nope').errors[0], /Invalid JSON/);
  assert.deepEqual(parseSourcesFile('').file.feeds, []);
});

test('serialize round-trips', () => {
  const out = serializeSourcesFile({ feeds: [{ url: 'https://a.org/', name: 'A' }, { url: 'https://b.org/' }] });
  assert.deepEqual(JSON.parse(out), { feeds: [{ name: 'A', url: 'https://a.org/' }, { url: 'https://b.org/' }] });
});

test('normalizeUrl', () => {
  assert.equal(normalizeUrl('  example.com/feed '), 'https://example.com/feed');
  assert.equal(normalizeUrl('ftp://x.org'), undefined);
  assert.equal(normalizeUrl(''), undefined);
});

test('mergeSources: first occurrence wins', () => {
  const g = [{ url: 'u1', scope: 'global' as const, file: 'g' }];
  const p = [{ url: 'u1', scope: 'project' as const, file: 'p' }, { url: 'u2', scope: 'project' as const, file: 'p' }];
  assert.deepEqual(mergeSources([g, p]).map((s) => `${s.url}:${s.scope}`), ['u1:global', 'u2:project']);
});
