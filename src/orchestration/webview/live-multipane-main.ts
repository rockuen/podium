import { Terminal } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';

// Phase 1 · v2.7.0 webview client for LiveMultiPanel.
//
// Difference vs multipane-main.ts (the older psmux-polling variant): this
// panel owns node-pty streams directly. The extension side pumps `pty-data`
// messages per-pane and we write them straight to the xterm instance — no
// capture-pane polling, no tmux mouse-tracking strip hacks.

declare function acquireVsCodeApi(): { postMessage: (msg: unknown) => void };

interface PaneMeta {
  paneId: string;
  label: string;
  agent: 'claude' | 'codex' | 'gemini' | 'shell';
  agentColor: string;
}

interface PaneInstance {
  meta: PaneMeta;
  term: Terminal;
  fit: FitAddon;
  el: HTMLDivElement;
}

const vscode = acquireVsCodeApi();
const grid = document.getElementById('grid') as HTMLDivElement;
const emptyMsg = document.getElementById('emptyMsg') as HTMLDivElement | null;

const instances = new Map<string, PaneInstance>();

// v0.3.3 · Orientation toggle. 'horizontal' keeps the legacy grid (panes
// arranged left-to-right first). 'vertical' stacks panes top-to-bottom —
// useful when the panel is itself a narrow side column (Summon Team's
// workers host). Swapping rows/cols in the template gives us that for
// free at counts where the original layout was strictly horizontal.
type Orientation = 'horizontal' | 'vertical';
let orientation: Orientation = 'horizontal';

function layoutTemplate(count: number): { rows: string; cols: string } {
  let tmpl: { rows: string; cols: string };
  if (count <= 1) tmpl = { rows: '1fr', cols: '1fr' };
  else if (count === 2) tmpl = { rows: '1fr', cols: '1fr 1fr' };
  else if (count <= 4) tmpl = { rows: '1fr 1fr', cols: '1fr 1fr' };
  else if (count <= 6) tmpl = { rows: '1fr 1fr', cols: '1fr 1fr 1fr' };
  else if (count <= 9) tmpl = { rows: '1fr 1fr 1fr', cols: '1fr 1fr 1fr' };
  else {
    const n = Math.ceil(Math.sqrt(count));
    tmpl = { rows: `repeat(${n}, 1fr)`, cols: `repeat(${n}, 1fr)` };
  }
  // Vertical orientation transposes the grid so panes stack top-to-bottom.
  if (orientation === 'vertical') return { rows: tmpl.cols, cols: tmpl.rows };
  return tmpl;
}

const lastResize = new Map<string, { cols: number; rows: number }>();
let resizeTimer: number | null = null;

function updateLayout(): void {
  const count = instances.size;
  const { rows, cols } = layoutTemplate(count);
  grid.style.gridTemplateRows = rows;
  grid.style.gridTemplateColumns = cols;
  if (emptyMsg) emptyMsg.style.display = count === 0 ? 'block' : 'none';
  requestAnimationFrame(() => {
    for (const inst of instances.values()) {
      try {
        inst.fit.fit();
      } catch {
        /* ignore */
      }
    }
    scheduleResizeSync();
  });
}

function scheduleResizeSync(): void {
  if (resizeTimer !== null) window.clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(() => {
    resizeTimer = null;
    for (const inst of instances.values()) {
      const c = inst.term.cols;
      const r = inst.term.rows;
      if (!Number.isFinite(c) || !Number.isFinite(r) || c < 10 || r < 5) continue;
      const prev = lastResize.get(inst.meta.paneId);
      if (prev && prev.cols === c && prev.rows === r) continue;
      lastResize.set(inst.meta.paneId, { cols: c, rows: r });
      vscode.postMessage({ type: 'resize', paneId: inst.meta.paneId, cols: c, rows: r });
    }
  }, 200);
}

function buildPane(meta: PaneMeta): PaneInstance {
  const el = document.createElement('div');
  el.className = 'pane';
  el.dataset.paneId = meta.paneId;
  el.style.setProperty('--pane-accent', meta.agentColor);

  el.addEventListener(
    'mousedown',
    () => {
      for (const other of Array.from(grid.querySelectorAll('.pane.active'))) {
        if (other !== el) other.classList.remove('active');
      }
      el.classList.add('active');
    },
    true,
  );

  const header = document.createElement('div');
  header.className = 'pane-header';
  const dot = document.createElement('span');
  dot.className = 'dot';
  header.appendChild(dot);
  const agentLabel = document.createElement('span');
  agentLabel.className = 'agent';
  agentLabel.textContent = meta.agent.toUpperCase();
  header.appendChild(agentLabel);
  const nameEl = document.createElement('span');
  nameEl.className = 'name';
  nameEl.textContent = meta.label;
  header.appendChild(nameEl);
  const idEl = document.createElement('span');
  idEl.className = 'id';
  idEl.textContent = `· ${meta.paneId}`;
  header.appendChild(idEl);
  el.appendChild(header);

  const body = document.createElement('div');
  body.className = 'pane-body';
  el.appendChild(body);

  grid.appendChild(el);

  const term = new Terminal({
    fontFamily: '"Cascadia Code", Consolas, "Courier New", monospace',
    fontSize: 12,
    cursorBlink: true,
    convertEol: true,
    scrollback: 5000,
    theme: { background: '#000', foreground: '#d4d4d4' },
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(body);
  try {
    fit.fit();
  } catch {
    /* ignore */
  }

  // User typing in this pane's xterm → send to the extension-side pty.
  term.onData((data) => {
    vscode.postMessage({ type: 'input', paneId: meta.paneId, data });
  });

  // v2.6.28-style selection cache → auto-copy on mouseup (TUI redraws wipe xterm selection).
  let lastSelection = '';
  term.onSelectionChange(() => {
    const sel = term.getSelection().trim();
    if (sel) lastSelection = sel;
  });
  body.addEventListener('mouseup', () => {
    const sel = (term.getSelection() || lastSelection).trim();
    if (sel) {
      vscode.postMessage({ type: 'copy-selection', paneId: meta.paneId, text: sel });
      lastSelection = sel;
    }
  });

  return { meta, term, fit, el };
}

function addPane(meta: PaneMeta): void {
  if (instances.has(meta.paneId)) return;
  const inst = buildPane(meta);
  instances.set(meta.paneId, inst);
  updateLayout();
}

function writeToPane(paneId: string, data: string): void {
  const inst = instances.get(paneId);
  if (!inst) return;
  inst.term.write(data);
}

function removePane(paneId: string): void {
  const inst = instances.get(paneId);
  if (!inst) return;
  try {
    inst.term.dispose();
  } catch {
    /* ignore */
  }
  inst.el.remove();
  instances.delete(paneId);
  updateLayout();
}

window.addEventListener('resize', updateLayout);

window.addEventListener('message', (ev: MessageEvent) => {
  const msg = ev.data as {
    type?: string;
    paneId?: string;
    data?: string;
    meta?: PaneMeta;
    exitCode?: number;
  };
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'add-pane' && msg.meta) {
    addPane(msg.meta);
    return;
  }
  if (msg.type === 'pty-data' && typeof msg.paneId === 'string' && typeof msg.data === 'string') {
    writeToPane(msg.paneId, msg.data);
    return;
  }
  if (msg.type === 'pty-exit' && typeof msg.paneId === 'string') {
    writeToPane(msg.paneId, `\r\n\x1b[31m[pane exited · code=${msg.exitCode ?? '?'}]\x1b[0m\r\n`);
    return;
  }
  if (msg.type === 'remove-pane' && typeof msg.paneId === 'string') {
    removePane(msg.paneId);
    return;
  }
  // v0.3.3 · Host-driven orientation toggle. Summon Team sets 'vertical'
  // so workers stack top-to-bottom inside the right-column panel.
  if (msg.type === 'set-orientation') {
    const v = (msg as { value?: unknown }).value;
    if (v === 'horizontal' || v === 'vertical') {
      orientation = v;
      updateLayout();
    }
    return;
  }
});

vscode.postMessage({ type: 'ready' });
