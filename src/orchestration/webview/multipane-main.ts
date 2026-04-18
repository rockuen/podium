import { Terminal } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';

declare function acquireVsCodeApi(): { postMessage: (msg: unknown) => void };

interface PaneInfo {
  paneId: string;
  title: string;
  command: string;
  windowIndex: number;
  pid: number | null;
  agent: string;
  agentColor: string;
  agentLabel: string;
}

interface PaneInstance {
  info: PaneInfo;
  term: Terminal;
  fit: FitAddon;
  el: HTMLDivElement;
}

const vscode = acquireVsCodeApi();

const grid = document.getElementById('grid') as HTMLDivElement;
const sessLabel = document.getElementById('sess') as HTMLSpanElement;
const cntLabel = document.getElementById('cnt') as HTMLSpanElement;
const status = document.getElementById('status') as HTMLSpanElement;
const emptyMsg = document.getElementById('emptyMsg');

const instances = new Map<string, PaneInstance>();

function layoutTemplate(count: number): { rows: string; cols: string } {
  if (count <= 1) return { rows: '1fr', cols: '1fr' };
  if (count === 2) return { rows: '1fr', cols: '1fr 1fr' };
  if (count <= 4) return { rows: '1fr 1fr', cols: '1fr 1fr' };
  if (count <= 6) return { rows: '1fr 1fr', cols: '1fr 1fr 1fr' };
  if (count <= 9) return { rows: '1fr 1fr 1fr', cols: '1fr 1fr 1fr' };
  const n = Math.ceil(Math.sqrt(count));
  return { rows: `repeat(${n}, 1fr)`, cols: `repeat(${n}, 1fr)` };
}

const lastResize = new Map<string, { cols: number; rows: number }>();
let resizeTimer: number | null = null;

function updateLayout(): void {
  const count = instances.size;
  const { rows, cols } = layoutTemplate(count);
  grid.style.gridTemplateRows = rows;
  grid.style.gridTemplateColumns = cols;
  cntLabel.textContent = count > 0 ? `${count} pane${count === 1 ? '' : 's'}` : '';
  if (emptyMsg) {
    emptyMsg.style.display = count === 0 ? 'block' : 'none';
  }
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
  // Debounce so rapid layout changes don't flood the backend with
  // `psmux resize-pane` commands.
  if (resizeTimer !== null) window.clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(() => {
    resizeTimer = null;
    for (const inst of instances.values()) {
      const cols = inst.term.cols;
      const rows = inst.term.rows;
      if (!Number.isFinite(cols) || !Number.isFinite(rows) || cols < 10 || rows < 5) continue;
      const prev = lastResize.get(inst.info.paneId);
      if (prev && prev.cols === cols && prev.rows === rows) continue;
      lastResize.set(inst.info.paneId, { cols, rows });
      vscode.postMessage({ type: 'resize', paneId: inst.info.paneId, cols, rows });
    }
  }, 200);
}

function workerName(info: PaneInfo): string {
  // "%1" → strip leading %, "{agent}-{n}"
  const idx = info.paneId.replace(/^%/, '');
  if (info.agent === 'unknown' || info.agent === 'shell') {
    return info.command || info.paneId;
  }
  return `${info.agentLabel.toLowerCase()}-${idx}`;
}

function createPane(info: PaneInfo): PaneInstance {
  const el = document.createElement('div');
  el.className = 'pane';
  el.dataset.paneId = info.paneId;
  el.style.setProperty('--pane-accent', info.agentColor);

  // Make the pane click-activate: a single active pane gets the full-border
  // accent emphasis from CSS, all others revert. Listener uses capture so it
  // still runs even when inner controls (footer buttons, close icon)
  // stopPropagation on mousedown.
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

  const agent = document.createElement('span');
  agent.className = 'agent';
  agent.textContent = info.agentLabel;
  header.appendChild(agent);

  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = workerName(info);
  header.appendChild(name);

  const idEl = document.createElement('span');
  idEl.className = 'id';
  idEl.textContent = `· ${info.paneId}`;
  header.appendChild(idEl);

  if (info.command && info.command !== info.agentLabel.toLowerCase()) {
    const cmd = document.createElement('span');
    cmd.className = 'cmd';
    cmd.textContent = `· ${info.command}`;
    header.appendChild(cmd);
  } else {
    // fill flex
    const spacer = document.createElement('span');
    spacer.className = 'cmd';
    header.appendChild(spacer);
  }

  const closeBtn = document.createElement('span');
  closeBtn.className = 'close';
  closeBtn.textContent = '×';
  closeBtn.title = `Kill pane ${info.paneId}`;
  closeBtn.addEventListener('mousedown', (ev) => {
    ev.stopPropagation();
    if (confirm(`Kill pane ${info.paneId} (${info.agentLabel})?`)) {
      vscode.postMessage({ type: 'kill', paneId: info.paneId });
    }
  });
  header.appendChild(closeBtn);

  el.appendChild(header);

  const body = document.createElement('div');
  body.className = 'pane-body';
  el.appendChild(body);

  const footer = buildPaneFooter(info);
  el.appendChild(footer);

  grid.appendChild(el);

  const term = new Terminal({
    fontFamily: '"Cascadia Code", Consolas, "Courier New", monospace',
    fontSize: 11,
    cursorBlink: false,
    disableStdin: true,
    convertEol: true,
    scrollback: 5000,
    theme: { background: '#1e1e1e', foreground: '#d4d4d4' },
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(body);
  try {
    fit.fit();
  } catch {
    /* ignore */
  }

  return { info, term, fit, el };
}

function buildPaneFooter(info: PaneInfo): HTMLDivElement {
  const footer = document.createElement('div');
  footer.className = 'pane-footer';

  const paneId = info.paneId;

  const quickChar = (label: string, char: string, title?: string) => {
    const btn = document.createElement('button');
    btn.textContent = label;
    btn.className = 'accent';
    if (title) btn.title = title;
    btn.addEventListener('mousedown', (ev) => {
      ev.preventDefault();
      vscode.postMessage({
        type: 'send-key',
        paneId,
        keys: [char, 'Enter'],
        literal: false,
      });
    });
    footer.appendChild(btn);
  };
  quickChar('1', '1', 'Send "1" + Enter');
  quickChar('2', '2', 'Send "2" + Enter');
  quickChar('3', '3', 'Send "3" + Enter');
  quickChar('y', 'y', 'Send "y" + Enter');
  quickChar('n', 'n', 'Send "n" + Enter');

  const rawKey = (label: string, keyName: string, title: string) => {
    const btn = document.createElement('button');
    btn.textContent = label;
    btn.title = title;
    btn.addEventListener('mousedown', (ev) => {
      ev.preventDefault();
      vscode.postMessage({
        type: 'send-key',
        paneId,
        keys: [keyName],
        literal: false,
      });
    });
    footer.appendChild(btn);
  };
  rawKey('⏎', 'Enter', 'Send Enter');
  rawKey('Esc', 'Escape', 'Send Escape');

  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = 'type text…';
  input.spellcheck = false;
  const submit = () => {
    const text = input.value;
    if (text.length > 0) {
      vscode.postMessage({
        type: 'send-key',
        paneId,
        keys: [text],
        literal: true,
      });
    }
    vscode.postMessage({
      type: 'send-key',
      paneId,
      keys: ['Enter'],
      literal: false,
    });
    input.value = '';
  };
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      submit();
    }
  });
  footer.appendChild(input);

  const sendBtn = document.createElement('button');
  sendBtn.className = 'send';
  sendBtn.textContent = '▶';
  sendBtn.title = 'Send text + Enter';
  sendBtn.addEventListener('mousedown', (ev) => {
    ev.preventDefault();
    submit();
  });
  footer.appendChild(sendBtn);

  return footer;
}

function rebuildPanes(next: PaneInfo[]): void {
  const nextIds = new Set(next.map((p) => p.paneId));
  for (const [id, inst] of instances) {
    if (!nextIds.has(id)) {
      inst.term.dispose();
      inst.el.remove();
      instances.delete(id);
    }
  }
  for (const info of next) {
    const existing = instances.get(info.paneId);
    if (!existing) {
      instances.set(info.paneId, createPane(info));
    } else if (
      existing.info.command !== info.command ||
      existing.info.agent !== info.agent
    ) {
      // agent/command changed → update header visuals without recreating xterm
      existing.info = info;
      existing.el.style.setProperty('--pane-accent', info.agentColor);
      const header = existing.el.querySelector('.pane-header');
      if (header) {
        header.querySelector<HTMLElement>('.agent')!.textContent = info.agentLabel;
        header.querySelector<HTMLElement>('.name')!.textContent = workerName(info);
        const cmdEl = header.querySelector<HTMLElement>('.cmd');
        if (cmdEl) cmdEl.textContent = info.command ? `· ${info.command}` : '';
      }
    }
  }
  updateLayout();
}

window.addEventListener('resize', updateLayout);

window.addEventListener('message', (ev: MessageEvent) => {
  const msg = ev.data as {
    type?: string;
    session?: string;
    panes?: PaneInfo[];
    paneId?: string;
    content?: string;
  };
  if (!msg || typeof msg !== 'object') return;

  if (msg.type === 'init' && Array.isArray(msg.panes)) {
    sessLabel.textContent = msg.session ?? '';
    rebuildPanes(msg.panes);
    flashStatus();
    return;
  }
  if (msg.type === 'panes-changed' && Array.isArray(msg.panes)) {
    rebuildPanes(msg.panes);
    return;
  }
  if (msg.type === 'pane-update' && typeof msg.paneId === 'string') {
    const inst = instances.get(msg.paneId);
    if (!inst) return;
    inst.term.reset();
    inst.term.write(msg.content ?? '');
    flashStatus();
    return;
  }
});

let flashTimer: number | null = null;
function flashStatus(): void {
  status.style.color = '#A6E22E';
  if (flashTimer !== null) window.clearTimeout(flashTimer);
  flashTimer = window.setTimeout(() => {
    status.style.color = '#FACC15';
  }, 160);
}

vscode.postMessage({ type: 'ready' });
