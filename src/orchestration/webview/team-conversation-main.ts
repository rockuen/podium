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
  index?: number;
}

interface LeaderMeta {
  provider: Provider;
  model?: string;
  agent?: string;
}

interface Snapshot {
  teamName: string;
  root: string;
  messages: MailboxMessage[];
  workers: Record<string, WorkerMeta>;
  scannedAt: number;
  displayName?: string;
  initialPrompt?: string;
  createdAt?: number;
  leader?: LeaderMeta;
}

// ---- Per-worker accent color (mirrors ui/colors.ts workerAccentColor) ------
// Duplicated here because this file bundles for the browser; importing from
// `../ui/colors` would pull in `vscode`, which has no browser build.
const PROVIDER_BASE_HSL: Record<Provider, { h: number; s: number; l: number }> = {
  claude: { h: 270, s: 95, l: 75 },
  codex: { h: 160, s: 84, l: 39 },
  gemini: { h: 217, s: 91, l: 68 },
  leader: { h: 24, s: 95, l: 61 },
  unknown: { h: 220, s: 9, l: 56 },
};

function workerAccentColor(provider: Provider, workerIndex: number): string {
  const base = PROVIDER_BASE_HSL[provider] ?? PROVIDER_BASE_HSL.unknown;
  const idx = Number.isFinite(workerIndex) && workerIndex > 0 ? Math.floor(workerIndex) : 0;
  const shift = idx > 0 ? (idx - 1) * 12 : 0;
  const h = ((base.h + shift) % 360 + 360) % 360;
  return `hsl(${h.toFixed(1)}, ${base.s}%, ${base.l}%)`;
}

function workerIndexOf(name: string, snap: Snapshot): number {
  const w = snap.workers[name];
  if (w && typeof w.index === 'number' && w.index > 0) return w.index;
  const m = name.match(/^worker-(\d+)$/i);
  if (m) {
    const n = parseInt(m[1], 10);
    if (Number.isFinite(n)) return n;
  }
  return 0;
}

const vscode = acquireVsCodeApi();
const feed = document.getElementById('feed')!;
const workersEl = document.getElementById('workers')!;
const countEl = document.getElementById('count')!;
const refreshEl = document.getElementById('refresh')!;
const copyEl = document.getElementById('copy-transcript')!;
const saveEl = document.getElementById('save-transcript')!;
const renameEl = document.getElementById('rename');
const displayNameEl = document.getElementById('display-name');
const displaySubEl = document.getElementById('display-sub');
const leaderInjectEl = document.getElementById('leader-inject') as HTMLTextAreaElement | null;
const leaderSendEl = document.getElementById('leader-send') as HTMLButtonElement | null;
const leaderHintEl = document.getElementById('leader-inject-hint');

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
if (renameEl) {
  renameEl.addEventListener('mousedown', (ev) => {
    ev.preventDefault();
    vscode.postMessage({ type: 'rename' });
  });
}

function sendLeaderInject(): void {
  if (!leaderInjectEl || !leaderSendEl) return;
  const text = leaderInjectEl.value.trim();
  if (!text) return;
  leaderSendEl.disabled = true;
  if (leaderHintEl) {
    leaderHintEl.className = 'hint';
    leaderHintEl.textContent = 'sending…';
  }
  vscode.postMessage({ type: 'leader-inject', text });
}

if (leaderInjectEl) {
  // Auto-grow textarea between 36px and 140px to match CSS constraints.
  const autoGrow = () => {
    if (!leaderInjectEl) return;
    leaderInjectEl.style.height = 'auto';
    leaderInjectEl.style.height = Math.min(140, Math.max(36, leaderInjectEl.scrollHeight)) + 'px';
  };
  leaderInjectEl.addEventListener('input', autoGrow);
  leaderInjectEl.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && !ev.shiftKey && !ev.metaKey && !ev.ctrlKey) {
      ev.preventDefault();
      sendLeaderInject();
    }
  });
}
if (leaderSendEl) {
  leaderSendEl.addEventListener('mousedown', (ev) => {
    ev.preventDefault();
    sendLeaderInject();
  });
}

window.addEventListener('message', (ev) => {
  const msg = ev.data;
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'snapshot') {
    render(msg.snapshot as Snapshot);
    return;
  }
  if (msg.type === 'leader-inject-result') {
    if (leaderSendEl) leaderSendEl.disabled = false;
    if (msg.ok) {
      if (leaderInjectEl) leaderInjectEl.value = '';
      if (leaderHintEl) {
        leaderHintEl.className = 'hint ok';
        leaderHintEl.textContent = 'sent · leader pane received via tmux send-keys';
      }
      setTimeout(() => {
        if (leaderHintEl) {
          leaderHintEl.className = 'hint';
          leaderHintEl.textContent = "Inject via tmux send-keys into the team's leader pane.";
        }
      }, 4000);
    } else {
      if (leaderHintEl) {
        leaderHintEl.className = 'hint err';
        leaderHintEl.textContent = msg.error ? `failed · ${msg.error}` : 'failed to inject';
      }
    }
    return;
  }
});

vscode.postMessage({ type: 'ready' });

let lastCount = 0;

function render(snap: Snapshot): void {
  const label = (snap.displayName ?? '').trim() || snap.teamName;
  if (displayNameEl) displayNameEl.textContent = label;
  if (displaySubEl) {
    const leaderLine = formatLeaderLine(snap.leader);
    if (label === snap.teamName) {
      // No custom display name yet → fall back to the mailbox path (or leader
      // line if we have one, since path is noisy).
      displaySubEl.textContent = leaderLine || `.omc/state/team/${snap.teamName}/mailbox`;
    } else {
      displaySubEl.textContent = leaderLine
        ? `${snap.teamName} · ${leaderLine}`
        : snap.teamName;
    }
    displaySubEl.title = `OMC team name: ${snap.teamName}`;
  }
  if (document.title !== label) document.title = label;

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
  const hasInitial = !!(snap.initialPrompt && snap.initialPrompt.trim());
  const totalCount = msgs.length + (hasInitial ? 1 : 0);
  countEl.textContent = `${totalCount} message${totalCount === 1 ? '' : 's'}`;

  if (msgs.length === 0 && !hasInitial) {
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

  if (hasInitial) {
    const prompt = snap.initialPrompt!;
    const createdIso = snap.createdAt ? new Date(snap.createdAt).toISOString() : '';
    const dateKey = dayKey(createdIso);
    if (dateKey) {
      html.push(`<div class="delivery-marker">${escapeHtml(dateKey)}</div>`);
      lastDateKey = dateKey;
    }
    const rel = relTime(createdIso);
    const abs = absTime(createdIso);
    const body = renderBody(prompt);
    // Initial prompt represents the user/leader side → left-aligned.
    const accent = workerAccentColor('leader', 0);
    html.push(`
      <div class="msg from-leader provider-leader source-initial" style="--worker-accent: ${accent};">
        <div class="meta">
          <span class="initial-badge">📝 Initial prompt</span>
          <span class="arrow">→</span>
          <span class="target">team</span>
          <span class="time" title="${escapeAttr(abs)}">${escapeHtml(rel)}</span>
        </div>
        <div class="bubble">${body}</div>
      </div>
    `);
  }

  for (const m of msgs) {
    const isUser = m.from_worker === 'user';
    const fromProvider: Provider = isUser
      ? 'leader' // provider colour fallback; CSS uses from-user + provider-user
      : snap.workers[m.from_worker]?.provider ?? guessProvider(m.from_worker);
    const toProvider = snap.workers[m.to_worker]?.provider ?? guessProvider(m.to_worker);
    const fromDisplay = isUser ? 'you' : displayWorkerName(m.from_worker, fromProvider);
    const toDisplay = displayWorkerName(m.to_worker, toProvider);
    // v2.6.12: user messages use a dedicated left-aligned lane so they are
    // visually distinct from leader/worker traffic.
    const side = isUser ? 'from-user' : (fromProvider === 'leader' ? 'from-leader' : 'from-worker');
    const providerClass = isUser ? 'provider-user' : `provider-${fromProvider}`;
    const accent = isUser
      ? workerAccentColor('leader', 0)
      : workerAccentColor(fromProvider, workerIndexOf(m.from_worker, snap));
    const dateKey = dayKey(m.created_at);
    if (dateKey && dateKey !== lastDateKey) {
      html.push(`<div class="delivery-marker">${escapeHtml(dateKey)}</div>`);
      lastDateKey = dateKey;
    }
    const rel = relTime(m.created_at);
    const abs = absTime(m.created_at);
    const body = renderBody(m.body);
    html.push(`
      <div class="msg ${side} ${providerClass}" style="--worker-accent: ${accent};">
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

  if (totalCount > lastCount) {
    feed.scrollTop = feed.scrollHeight;
  }
  lastCount = totalCount;
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

/**
 * Render a compact leader summary for the header subtitle:
 *   leader · omc (claude / claude-opus-4-6)
 *   leader · omc (claude)                       // when model is absent or 'inherit'
 * Returns '' when there's nothing useful to say.
 */
function formatLeaderLine(leader: LeaderMeta | undefined): string {
  if (!leader) return '';
  const provider = leader.provider || 'leader';
  const agent = leader.agent || 'omc';
  const model = leader.model && leader.model !== 'inherit' ? leader.model : '';
  const inner = model ? `${provider} / ${model}` : provider;
  return `leader · ${agent} (${inner})`;
}
