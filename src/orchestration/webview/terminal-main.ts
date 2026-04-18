import { Terminal } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import { WebLinksAddon } from 'xterm-addon-web-links';

declare function acquireVsCodeApi(): { postMessage: (msg: unknown) => void };

const vscode = acquireVsCodeApi();

const container = document.getElementById('terminal');
if (!container) {
  throw new Error('[podium] #terminal element missing');
}

const term = new Terminal({
  fontFamily: '"Cascadia Code", Consolas, "Courier New", monospace',
  fontSize: 13,
  cursorBlink: true,
  convertEol: false,
  scrollback: 10000,
  theme: {
    background: '#1e1e1e',
    foreground: '#d4d4d4',
    cursor: '#d4d4d4',
  },
});

const fit = new FitAddon();
term.loadAddon(fit);
term.loadAddon(new WebLinksAddon());
term.open(container);
fit.fit();
term.focus();

function sendResize(): void {
  const cols = term.cols;
  const rows = term.rows;
  if (cols > 0 && rows > 0) {
    vscode.postMessage({ type: 'resize', cols, rows });
  }
}

term.onData((data) => {
  vscode.postMessage({ type: 'input', data });
});

window.addEventListener('resize', () => {
  try {
    fit.fit();
  } catch {
    // ignore layout errors during window resize
  }
  sendResize();
});

sendResize();

window.addEventListener('message', (ev: MessageEvent) => {
  const msg = ev.data as { type?: string; data?: string; exitCode?: number };
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'pty-data' && typeof msg.data === 'string') {
    term.write(msg.data);
  } else if (msg.type === 'pty-exit') {
    term.writeln('');
    term.writeln(`\r\n\x1b[33m[process exited with code ${msg.exitCode ?? '?'}]\x1b[0m`);
  }
});
