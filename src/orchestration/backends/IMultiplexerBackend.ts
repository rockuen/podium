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
