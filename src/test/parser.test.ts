import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeEntities, discoverFeedLinks, htmlToText, NotAFeedError, parseFeed } from '../parser';

const RSS = `<?xml version="1.0"?>
<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:content="http://purl.org/rss/1.0/modules/content/">
<channel><title>Example &amp; Co</title><link>https://example.com/</link>
<item><title><![CDATA[Hello &#8217;world&#8217;]]></title><link>/posts/1</link><guid isPermaLink="false">p1</guid>
<pubDate>Tue, 03 Nov 2026 10:00:00 GMT</pubDate><dc:creator>Ann</dc:creator>
<description><![CDATA[<p>Some <b>bold</b> text</p>]]></description></item>
<item><title>No guid</title><link>https://example.com/posts/2</link></item>
</channel></rss>`;

test('parses RSS 2.0', () => {
  const f = parseFeed(RSS, 'https://example.com/feed.xml');
  assert.equal(f.title, 'Example & Co');
  assert.equal(f.items.length, 2);
  const [a, b] = f.items;
  assert.equal(a.id, 'p1');
  assert.equal(a.title, 'Hello ’world’');
  assert.equal(a.link, 'https://example.com/posts/1');
  assert.equal(a.author, 'Ann');
  assert.equal(a.summary, 'Some bold text');
  assert.equal(a.published, Date.parse('2026-11-03T10:00:00Z'));
  assert.equal(b.id, 'https://example.com/posts/2');
});

test('parses Atom with multiple links', () => {
  const f = parseFeed(
    `<feed xmlns="http://www.w3.org/2005/Atom"><title type="html">Atom &lt;b&gt;Feed&lt;/b&gt;</title>
     <link rel="self" href="https://ex.org/atom.xml"/><link href="https://ex.org/"/>
     <entry><id>tag:ex.org,1</id><title>Entry</title><link rel="edit" href="/edit/1"/><link rel="alternate" href="/e/1"/>
     <updated>2026-11-01T00:00:00Z</updated><author><name>Bob</name></author><summary>Sum</summary></entry></feed>`,
    'https://ex.org/atom.xml',
  );
  assert.equal(f.title, 'Atom Feed');
  assert.equal(f.link, 'https://ex.org/');
  assert.equal(f.items[0].id, 'tag:ex.org,1');
  assert.equal(f.items[0].link, 'https://ex.org/e/1');
  assert.equal(f.items[0].author, 'Bob');
});

test('parses RSS 1.0 (RDF)', () => {
  const f = parseFeed(
    `<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/">
     <channel rdf:about="x"><title>RDF</title><link>https://r.org/</link></channel>
     <item rdf:about="https://r.org/1"><title>One</title><link>https://r.org/1</link><dc:date>2026-10-01T00:00:00Z</dc:date></item>
     </rdf:RDF>`,
  );
  assert.equal(f.title, 'RDF');
  assert.equal(f.items.length, 1);
  assert.equal(f.items[0].link, 'https://r.org/1');
});

test('parses JSON Feed', () => {
  const f = parseFeed(
    JSON.stringify({ version: 'https://jsonfeed.org/version/1.1', title: 'J', items: [{ id: '1', url: 'https://j.org/1', content_text: 'Hi there' }] }),
  );
  assert.equal(f.title, 'J');
  assert.equal(f.items[0].title, 'Hi there');
});

test('rejects HTML', () => {
  assert.throws(() => parseFeed('<!doctype html><html><body>hi</body></html>'), NotAFeedError);
  assert.throws(() => parseFeed('plain text'), NotAFeedError);
});

test('discovers feed links in HTML', () => {
  const links = discoverFeedLinks(
    `<head><link rel="stylesheet" href="a.css"><link rel="alternate" type="application/rss+xml" title="Posts" href="/feed.xml">
     <link type='application/atom+xml' rel='alternate' href='https://x.org/atom'></head>`,
    'https://x.org/blog/',
  );
  assert.deepEqual(links, [
    { url: 'https://x.org/feed.xml', title: 'Posts' },
    { url: 'https://x.org/atom', title: undefined },
  ]);
});

test('entity + html helpers', () => {
  assert.equal(decodeEntities('a &amp; b &#x41; &hellip; &bogus;'), 'a & b A … &bogus;');
  assert.equal(htmlToText('<p>a</p><script>x</script><p>b&nbsp;c</p>'), 'a b c');
});
