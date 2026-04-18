import { execFile } from 'child_process';
import { promisify } from 'util';
import type {
  IMultiplexerBackend,
  TmuxPane,
  TmuxSession,
} from './IMultiplexerBackend';

const execFileAsync = promisify(execFile);

export class PsmuxBackend implements IMultiplexerBackend {
  readonly name: 'psmux' | 'tmux' = 'psmux';

  protected binary: string;

  constructor(binary: string = 'psmux') {
    this.binary = binary;
  }

  async isAvailable(): Promise<boolean> {
    try {
      await this.run(['-V']);
      return true;
    } catch {
      return false;
    }
  }

  async getVersion(): Promise<string> {
    const { stdout } = await this.run(['-V']);
    return stdout.trim();
  }

  async listSessions(): Promise<TmuxSession[]> {
    const fmt = '#{session_name}|#{session_windows}|#{session_attached}|#{session_created}';
    try {
      const { stdout } = await this.run(['list-sessions', '-F', fmt]);
      return stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => parseSessionLine(line));
    } catch (err) {
      if (isNoServerError(err)) {
        return [];
      }
      throw err;
    }
  }

  async listPanes(sessionName: string): Promise<TmuxPane[]> {
    // pane_title moved to last field so that its free-form text (which a
    // program can change to anything, including `|`) cannot shift the
    // preceding well-typed fields and corrupt pid / window_index / agent
    // detection. parsePaneLine joins any trailing `|` segments back into the
    // title.
    const fmt = '#{pane_id}|#{session_name}|#{window_index}|#{pane_current_command}|#{pane_pid}|#{pane_title}';
    try {
      const { stdout } = await this.run([
        'list-panes',
        '-s',
        '-t',
        sessionName,
        '-F',
        fmt,
      ]);
      return stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => parsePaneLine(line))
        .filter((p): p is TmuxPane => p !== null);
    } catch (err) {
      if (isNoServerError(err)) {
        return [];
      }
      throw err;
    }
  }

  async killSession(sessionName: string): Promise<void> {
    await this.run(['kill-session', '-t', sessionName]);
  }

  async killPane(paneId: string): Promise<void> {
    await this.run(['kill-pane', '-t', paneId]);
  }

  async sendKeys(paneId: string, keys: string[], literal = false): Promise<void> {
    if (keys.length === 0) return;
    const args = ['send-keys', '-t', paneId];
    if (literal) args.push('-l', '--');
    args.push(...keys);
    await this.run(args);
  }

  async resizePane(paneId: string, cols: number, rows: number): Promise<void> {
    const safeCols = Math.max(10, Math.min(500, Math.floor(cols)));
    const safeRows = Math.max(5, Math.min(300, Math.floor(rows)));
    await this.run(['resize-pane', '-t', paneId, '-x', String(safeCols), '-y', String(safeRows)]);
  }

  async capturePane(paneId: string, scrollback: number = 0): Promise<string> {
    const args: string[] = ['capture-pane', '-p', '-e', '-t', paneId];
    if (scrollback > 0) {
      args.push('-S', `-${scrollback}`);
    }
    try {
      const { stdout } = await this.run(args);
      return stdout;
    } catch (err) {
      if (isNoServerError(err)) return '';
      throw err;
    }
  }

  private run(args: string[]): Promise<{ stdout: string; stderr: string }> {
    return execFileAsync(this.binary, args, {
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    });
  }
}

function parseSessionLine(line: string): TmuxSession {
  // Happy path: tmux / psmux honoring `-F '#{…}|#{…}|…'`.
  if (line.includes('|')) {
    const [name, windows, attached, created] = line.split('|');
    const createdUnix = Number(created);
    return {
      name,
      windowCount: Number(windows) || 0,
      attached: attached === '1',
      createdAtUnix: Number.isFinite(createdUnix) ? createdUnix : null,
    };
  }
  // Fallback: psmux 3.3.2 silently ignores `-F` on `list-sessions` and emits
  // the default format:
  //   `<name>: <N> windows (created <date>) [optional " (attached)"]`
  const match = line.match(
    /^(.+?):\s*(\d+)\s+windows?\s+\(created\s+([^)]+)\)(\s+\(attached\))?\s*$/,
  );
  if (match) {
    const parsedDate = Date.parse(match[3]);
    return {
      name: match[1].trim(),
      windowCount: Number(match[2]) || 0,
      attached: !!match[4],
      createdAtUnix: Number.isFinite(parsedDate) ? Math.floor(parsedDate / 1000) : null,
    };
  }
  // Last resort: strip everything after the first colon so at least the name
  // is usable for subsequent `-t` references.
  const colon = line.indexOf(':');
  return {
    name: colon >= 0 ? line.slice(0, colon).trim() : line.trim(),
    windowCount: 0,
    attached: /\(attached\)/.test(line),
    createdAtUnix: null,
  };
}

function parsePaneLine(line: string): TmuxPane | null {
  const parts = line.split('|');
  if (parts.length < 5) return null;
  const paneId = parts[0];
  const sessionName = parts[1];
  const windowIndex = Number(parts[2]) || 0;
  const cmd = parts[3] ?? '';
  const pidNum = Number(parts[4]);
  // Join any trailing segments back into the title (titles may contain `|`).
  const title = parts.length > 5 ? parts.slice(5).join('|') : '';
  return {
    paneId,
    sessionName,
    windowIndex,
    title,
    currentCommand: cmd,
    pid: Number.isFinite(pidNum) ? pidNum : null,
  };
}

function isNoServerError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const msg = String((err as { stderr?: string }).stderr ?? (err as Error).message ?? '');
  return /no server running|no such file|failed to connect/i.test(msg);
}
