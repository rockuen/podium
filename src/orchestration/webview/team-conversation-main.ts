export {};

declare function acquireVsCodeApi(): { postMessage: (msg: unknown) => void };

type Provider = 'claude' | 'codex' | 'gemini' | 'leader' | 'unknown';

interface MailboxMessage {
  message_id: string;
  from_worker: string;
  to_worker: string;
  body: string;
  created_at: string;
  notified_at?: string;
  delivered_at?: string;
}

interface WorkerMeta {
  name: string;
  provider: Provider;
  status?: string;
  pid?: number;
}

interface Snapshot {
  teamName: string;
  root: string;
  messages: MailboxMessage[];
  workers: Record<string, WorkerMeta>;
  scannedAt: number;
}

const vscode = acquireVsCodeApi();
const feed = document.getElementById('feed')!;
const workersEl = document.getElementById('workers')!;
const countEl = document.getElementById('count')!;
const refreshEl = document.getElementById('refresh')!;
const copyEl = document.getElementById('copy-transcript')!;
const saveEl = document.getElementById('save-transcript')!;

refreshEl.addEventListener('mousedown', (ev) => {
  ev.preventDefault();
  vscode.postMessage({ type: 'refresh' });
});
copyEl.addEventListener('mousedown', (ev) => {
  ev.preventDefault();
  vscode.postMessage({ type: 'copy-transcript' });
});
saveEl.addEventListener('mousedown', (ev) => {
  ev.preventDefault();
  vscode.postMessage({ type: 'save-transcript' });
});

window.addEventListener('message', (ev) => {
  const msg = ev.data;
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'snapshot') render(msg.snapshot as Snapshot);
});

vscode.postMessage({ type: 'ready' });

let lastCount = 0;

function render(snap: Snapshot): void {
  const workerNames = Object.keys(snap.workers).sort();
  workersEl.innerHTML = workerNames
    .map((name) => {
      const w = snap.workers[name];
      const display = displayWorkerName(name, w.provider);
      const title = name === display ? name : `${display} (OMC id: ${name})`;
      return `<span class="pill ${escapeAttr(w.provider)}" title="${escapeAttr(title)}"><span class="dot"></span>${escapeHtml(display)}${
        w.status ? ` · ${escapeHtml(w.status)}` : ''
      }</span>`;
    })
    .join('');

  const msgs = snap.messages;
  countEl.textContent = `${msgs.length} message${msgs.length === 1 ? '' : 's'}`;
  if (msgs.length === 0) {
    feed.innerHTML = `
      <div class="empty-state">
        <div>
          <strong>Waiting for messages</strong>
          No mailbox entries yet. Once workers ACK or leader dispatches tasks, messages will appear here live.
        </div>
      </div>
    `;
    lastCount = 0;
    return;
  }

  let lastDateKey = '';
  const html: string[] = [];
  for (const m of msgs) {
    const fromProvider = snap.workers[m.from_worker]?.provider ?? guessProvider(m.from_worker);
    const toProvider = snap.workers[m.to_worker]?.provider ?? guessProvider(m.to_worker);
    const fromDisplay = displayWorkerName(m.from_worker, fromProvider);
    const toDisplay = displayWorkerName(m.to_worker, toProvider);
    const side = fromProvider === 'leader' ? 'from-leader' : 'from-worker';
    const providerClass = `provider-${fromProvider}`;
    const dateKey = dayKey(m.created_at);
    if (dateKey && dateKey !== lastDateKey) {
      html.push(`<div class="delivery-marker">${escapeHtml(dateKey)}</div>`);
      lastDateKey = dateKey;
    }
    const rel = relTime(m.created_at);
    const abs = absTime(m.created_at);
    const body = renderBody(m.body);
    html.push(`
      <div class="msg ${side} ${providerClass}">
        <div class="meta">
          <span class="who" title="${escapeAttr(m.from_worker)}">${escapeHtml(fromDisplay)}</span>
          <span class="arrow">→</span>
          <span class="target" title="${escapeAttr(m.to_worker)}">${escapeHtml(toDisplay)}</span>
          <span class="time" title="${escapeAttr(abs)}">${escapeHtml(rel)}</span>
        </div>
        <div class="bubble">${body}</div>
      </div>
    `);
  }
  feed.innerHTML = html.join('');

  if (msgs.length > lastCount) {
    feed.scrollTop = feed.scrollHeight;
  }
  lastCount = msgs.length;
}

function guessProvider(workerName: string): Provider {
  if (/^leader/i.test(workerName)) return 'leader';
  return 'unknown';
}

function displayWorkerName(name: string, provider: Provider): string {
  if (/^leader/i.test(name)) return 'leader';
  const m = name.match(/^worker-(\d+)$/i);
  if (m && (provider === 'claude' || provider === 'codex' || provider === 'gemini')) {
    return `${provider}-${m[1]}`;
  }
  return name;
}

function renderBody(body: string): string {
  // Minimal markdown-ish: fenced code blocks, inline code, bold.
  const lines = body.split(/\r?\n/);
  const out: string[] = [];
  let inCode = false;
  let buf: string[] = [];
  for (const line of lines) {
    if (/^```/.test(line)) {
      if (!inCode) {
        inCode = true;
        buf = [];
      } else {
        out.push(`<pre>${escapeHtml(buf.join('\n'))}</pre>`);
        inCode = false;
      }
      continue;
    }
    if (inCode) {
      buf.push(line);
    } else {
      out.push(inlineMd(line));
    }
  }
  if (inCode && buf.length > 0) out.push(`<pre>${escapeHtml(buf.join('\n'))}</pre>`);
  return out.join('\n');
}

function inlineMd(line: string): string {
  let s = escapeHtml(line);
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  return s;
}

function relTime(iso: string): string {
  const t = Date.parse(iso || '');
  if (!Number.isFinite(t)) return '';
  const delta = Date.now() - t;
  if (delta < 10_000) return 'just now';
  if (delta < 60_000) return `${Math.floor(delta / 1000)}s ago`;
  if (delta < 3600_000) return `${Math.floor(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3600_000)}h ago`;
  const days = Math.floor(delta / 86_400_000);
  return `${days}d ago`;
}

function absTime(iso: string): string {
  const t = Date.parse(iso || '');
  if (!Number.isFinite(t)) return iso;
  return new Date(t).toLocaleString();
}

function dayKey(iso: string): string {
  const t = Date.parse(iso || '');
  if (!Number.isFinite(t)) return '';
  const d = new Date(t);
  const today = new Date();
  const isToday =
    d.getFullYear() === today.getFullYear() &&
    d.getMonth() === today.getMonth() &&
    d.getDate() === today.getDate();
  if (isToday) return 'Today';
  return d.toLocaleDateString();
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttr(s: string): string {
  return escapeHtml(s);
}
