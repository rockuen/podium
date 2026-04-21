export interface TmuxSession {
  name: string;
  windowCount: number;
  attached: boolean;
  createdAtUnix: number | null;
}

export interface TmuxPane {
  paneId: string;
  sessionName: string;
  windowIndex: number;
  title: string;
  currentCommand: string;
  pid: number | null;
}

export interface IMultiplexerBackend {
  readonly name: 'tmux' | 'psmux';

  isAvailable(): Promise<boolean>;
  getVersion(): Promise<string>;

  listSessions(): Promise<TmuxSession[]>;
  listPanes(sessionName: string): Promise<TmuxPane[]>;

  killSession(sessionName: string): Promise<void>;

  /**
   * Kill the entire tmux/psmux server process — the nuclear option, used
   * by Emergency Reset when individual kill-session / kill-pane calls fail
   * to release RAM. Safe to call when no server is running (resolves).
   */
  killServer(): Promise<void>;

  /**
   * Set a global (server-scoped) option on the running tmux/psmux server.
   * Equivalent to `tmux set-option -g <name> <value>`. Persists for every
   * subsequent split-window / new-window on this server process. Used in
   * v2.6.43 to force `default-shell` to MSYS2 bash before OMC's coordinator
   * spawns workers — OMC's worker-start string assumes a Unix shell and
   * blows up in cmd.exe.
   */
  setServerOption(option: string, value: string): Promise<void>;

  /**
   * Split-window to add a worker pane inside an existing session. Returns
   * the newly created pane id (e.g. `%18`). Used by P0.6 inline team
   * spawning to attach claude/codex/gemini workers to the current
   * `podium-leader-*` session. `envPairs` are passed through tmux/psmux `-e`
   * flags so each pane receives team/worker identifiers and OpenClaw routing.
   */
  splitWorker(
    session: string,
    envPairs: ReadonlyArray<[string, string]>,
    command: string,
    args: ReadonlyArray<string>,
    cwd?: string,
  ): Promise<string>;

  /**
   * Apply a built-in layout (`tiled`, `even-horizontal`, `even-vertical`,
   * `main-horizontal`, `main-vertical`) to a session's active window. Called
   * after spawning worker panes so the grid redistributes evenly.
   */
  applyLayout(session: string, layout: 'tiled' | 'even-horizontal' | 'even-vertical' | 'main-horizontal' | 'main-vertical'): Promise<void>;

  /**
   * Capture current visible content of a pane (read-only snapshot).
   * Returns the rendered text including escape sequences for colors.
   */
  capturePane(paneId: string, scrollback?: number): Promise<string>;

  /**
   * Kill a single pane. If it is the last pane in its session the
   * session will be destroyed as well.
   */
  killPane(paneId: string): Promise<void>;

  /**
   * Send keystrokes to a pane. `literal = true` passes the text as-is via
   * `-l` (useful for arbitrary letters like "y", "A", full strings).
   * `literal = false` lets tmux/psmux translate key names (e.g. "Enter",
   * "Escape", "C-c"). Caller must send the terminating key (Enter) explicitly.
   */
  sendKeys(paneId: string, keys: string[], literal?: boolean): Promise<void>;

  /**
   * Resize a pane to exact cols × rows. Used by the Multi-Pane grid to match
   * psmux pane geometry to the webview's xterm.js fit so the pane fills the
   * visible area instead of leaving blank rows below short content.
   */
  resizePane(paneId: string, cols: number, rows: number): Promise<void>;
}
