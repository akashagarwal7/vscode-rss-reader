// OS-level notifications (macOS Notification Center, Linux notify-send). No `vscode` import.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';

export interface SystemNotification {
  title: string;
  subtitle?: string;
  message: string;
  /** Opened on click (terminal-notifier only). */
  url?: string;
  sound?: string;
}

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 10_000 }, (err) => (err ? reject(err) : resolve()));
  });
}

const TERMINAL_NOTIFIER = ['/opt/homebrew/bin/terminal-notifier', '/usr/local/bin/terminal-notifier'];

export function findTerminalNotifier(): string | undefined {
  return TERMINAL_NOTIFIER.find((p) => existsSync(p));
}

/** Arguments for `osascript`; values are passed via argv, never interpolated into the script. */
export function osascriptArgs(n: SystemNotification): string[] {
  const script = [
    'on run argv',
    n.sound
      ? 'display notification (item 1 of argv) with title (item 2 of argv) subtitle (item 3 of argv) sound name (item 4 of argv)'
      : 'display notification (item 1 of argv) with title (item 2 of argv) subtitle (item 3 of argv)',
    'end run',
  ];
  const args = script.flatMap((l) => ['-e', l]);
  args.push(n.message, n.title, n.subtitle ?? '');
  if (n.sound) args.push(n.sound);
  return args;
}

export function terminalNotifierArgs(n: SystemNotification): string[] {
  // terminal-notifier treats a leading "-" or "[" in values specially; prefix with a zero-width space.
  const v = (s: string) => (/^[-[]/.test(s) ? `​${s}` : s);
  const args = ['-title', v(n.title), '-message', v(n.message), '-group', 'rss-feed-curator'];
  if (n.subtitle) args.push('-subtitle', v(n.subtitle));
  if (n.url) args.push('-open', n.url);
  if (n.sound) args.push('-sound', n.sound);
  return args;
}

/** Show a system notification. Resolves to false when unsupported or failed. */
export async function showSystemNotification(n: SystemNotification, platform = process.platform): Promise<boolean> {
  try {
    if (platform === 'darwin') {
      const tn = findTerminalNotifier();
      if (tn) await run(tn, terminalNotifierArgs(n));
      else await run('/usr/bin/osascript', osascriptArgs(n));
      return true;
    }
    if (platform === 'linux') {
      await run('notify-send', ['--app-name=RSS Feed Curator', n.subtitle ? `${n.title} — ${n.subtitle}` : n.title, n.message]);
      return true;
    }
  } catch {
    return false;
  }
  return false;
}
