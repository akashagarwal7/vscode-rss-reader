# RSS Feed Curator

Curate global and per-project RSS/Atom feeds inside VS Code or Cursor, get notified (in the editor and in macOS
Notification Center) when new posts land, and keep one read/unread state across every window and editor.

<!-- ![Feeds view](docs/overview.png) -->

## Why this exists

Release notes, changelogs, security advisories and blogs you care about are scattered across sites, and a separate
RSS app is one more window you forget to check. Some feeds matter everywhere (Hacker News, your favourite blogs);
others only matter while you're working on a particular project (that framework's releases, the upstream repo's
Atom feed). This keeps both next to your code and taps you on the shoulder when something new arrives.

## Features

- **Feeds view** in the activity bar: feeds → posts, newest first; unread posts marked with a blue dot, plus an
  unread badge and status bar count.
- **Global + project sources.** Global feeds live in `~/.rss-feed-curator/feeds.json`; project feeds in
  `<workspace>/.vscode/rss-feeds.json` (commit it to share with your team). Both are watched and schema-validated.
- **Add Feed…** accepts a feed URL *or* a website URL (auto-discovers `<link rel="alternate">` feeds).
- **Background refresh** every 2 hours (configurable). Fetching is coordinated through a lock file, so ten open
  windows still fetch each feed once and notify once. Uses ETag / Last-Modified to save bandwidth.
- **Notifications** in VS Code/Cursor (Open / Mark Read / Show Feeds) and as macOS system notifications.
  Install [`terminal-notifier`](https://github.com/julienXX/terminal-notifier) (`brew install terminal-notifier`) and
  clicking a notification opens the post.
- **Global read state** stored in `~/.rss-feed-curator/read.json`, shared by every window and by both VS Code and
  Cursor. Mark read/unread per post, per feed or everything; toggle *Show Only Unread*.
- RSS 2.0, RSS 1.0 (RDF), Atom and JSON Feed.

## Usage

1. Open the **RSS Feeds** view in the activity bar and click **+** (or run **RSS Feed Curator: Add Feed…**).
2. Paste a feed or website URL, optionally name it, and choose **Global** or **Project: &lt;folder&gt;**.
3. Click a post to open it (marks it read). Hover for a summary. Right-click for more.

Or edit the sources files directly (**Edit Global Feeds** / **Edit Project Feeds** in the view's `…` menu):

```jsonc
// ~/.rss-feed-curator/feeds.json  or  <workspace>/.vscode/rss-feeds.json
{
  "feeds": [
    { "name": "Hacker News", "url": "https://news.ycombinator.com/rss" },
    { "name": "TypeScript releases", "url": "https://github.com/microsoft/TypeScript/releases.atom" },
    "https://code.visualstudio.com/feed.xml"
  ]
}
```

If the same URL appears in both, it's shown once as global.

## Commands

| Command | |
| --- | --- |
| Add Feed… | Add a feed (with auto-discovery) to global or project sources |
| Refresh All Feeds | Fetch every feed now, ignoring the interval |
| Show Only Unread / Show All Posts | Filter the tree |
| Mark All as Read | Mark every visible feed's posts read |
| Open Next Unread Post | Open the newest unread post |
| Edit Global Feeds / Edit Project Feeds | Open (and create) the sources file |
| Show Log | Fetch results and errors |

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `rssCurator.refreshIntervalMinutes` | `120` | How often each feed is fetched (min 5). Failed feeds retry after 15 min. |
| `rssCurator.notifications.editor` | `true` | In-editor notification for new posts |
| `rssCurator.notifications.system` | `true` | macOS Notification Center / Linux `notify-send` |
| `rssCurator.notifications.systemSound` | `""` | macOS sound name, e.g. `Glass` |
| `rssCurator.openIn` | `browser` | `browser` or `editor` (Simple Browser tab) |
| `rssCurator.maxItemsPerFeed` | `200` | Posts kept per feed |
| `rssCurator.statusBar` | `true` | Unread count in the status bar |
| `rssCurator.dataDirectory` | `~/.rss-feed-curator` | Global feeds, cache and read state |

## Notes

- The first fetch of a newly added feed doesn't notify (its backlog shows as unread instead).
- Without `terminal-notifier`, macOS notifications are sent via `osascript` and appear as coming from
  *Script Editor*; allow notifications for it in System Settings › Notifications if they don't show.
- Only the window that performs a fetch shows the notification; all other windows update their tree and counts.

## Development

```sh
npm install
npm run build            # bundle to dist/
npm test                 # unit tests (node:test)
npm run test:integration # runs inside a real VS Code
./install.sh             # package + install into VS Code and Cursor
./publish.sh             # publish to the Marketplace
```

Press F5 to launch an Extension Development Host.
