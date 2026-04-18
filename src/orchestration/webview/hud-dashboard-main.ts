export {};

declare function acquireVsCodeApi(): {
  postMessage: (msg: unknown) => void;
};

interface HistoryEntryLite {
  sessionId: string;
  directory: string;
  modes: string[];
  hasCancelSignal: boolean;
  directoryMtime: number;
  startTs: number;
  updateTs: number;
  backgroundTaskCount: number;
}

interface HistoryLite {
  entries: HistoryEntryLite[];
  activeSessionId: string | null;
  scannedAt: number;
}

interface HUDLite {
  session_id?: string;
  model?: { id?: string; display_name?: string };
  cost?: { total_cost_usd?: number; total_duration_ms?: number; total_api_duration_ms?: number; total_lines_added?: number; total_lines_removed?: number };
  context_window?: {
    total_input_tokens?: number;
    total_output_tokens?: number;
    context_window_size?: number;
    used_percentage?: number;
    remaining_percentage?: number;
    current_usage?: {
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
      input_tokens?: number;
      output_tokens?: number;
    };
  };
  rate_limits?: {
    five_hour?: { used_percentage?: number; resets_at?: number };
    seven_day?: { used_percentage?: number; resets_at?: number };
  };
  output_style?: { name?: string };
  cwd?: string;
}

interface CcgLite {
  pairCount: number;
  scannedAt: number;
}

interface Snapshot {
  hud: HUDLite | null;
  history: HistoryLite | null;
  ccg: CcgLite | null;
}

const vscode = acquireVsCodeApi();
const body = document.getElementById('body')!;
const refreshBtn = document.getElementById('refreshBtn')!;
refreshBtn.addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));

window.addEventListener('message', (ev) => {
  const msg = ev.data;
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'snapshot') render(msg.snapshot as Snapshot);
});

vscode.postMessage({ type: 'ready' });

function render(snap: Snapshot): void {
  const hasAny = snap.hud || (snap.history && snap.history.entries.length > 0) || (snap.ccg && snap.ccg.pairCount > 0);
  if (!hasAny) {
    body.innerHTML = `
      <div class="empty-state">
        <strong>Nothing yet</strong>
        Start a Claude session, spawn an OMC team, or run <code>/ccg</code> to populate live analytics.
      </div>
    `;
    return;
  }

  body.innerHTML = `
    ${renderStatsRow(snap)}
    ${renderChartsRow(snap)}
    ${renderContextCard(snap)}
    ${renderRecentSessions(snap)}
  `;

  wireInteractions();
}

function renderStatsRow(snap: Snapshot): string {
  const sessionsToday = countSessionsToday(snap.history);
  const tokens = getTokens(snap.hud);
  const cost = snap.hud?.cost?.total_cost_usd ?? 0;
  const modes = listModes(snap.history);

  return `
    <div class="stats-row">
      <div class="card">
        <div class="top">
          <span class="icon-omc">◆</span>
          <span class="title">Sessions Today</span>
          <span class="spacer"></span>
          <span class="trend">${sessionsToday.total} total</span>
        </div>
        <div class="val">${sessionsToday.total}</div>
        <div class="sub">${sessionsToday.active} active · ${sessionsToday.completed} completed${sessionsToday.cancelled > 0 ? ` · ${sessionsToday.cancelled} cancelled` : ''}</div>
      </div>
      <div class="card">
        <div class="top">
          <span class="icon-claude">✧</span>
          <span class="title">Tokens (current)</span>
          <span class="spacer"></span>
          <span class="trend">${tokens.cacheHitPct !== null ? `cache ${tokens.cacheHitPct}%` : 'no cache'}</span>
        </div>
        <div class="val">${formatBig(tokens.total)}</div>
        <div class="sub">input ${formatBig(tokens.input)} · output ${formatBig(tokens.output)}${tokens.cache !== null ? ` · cache ${formatBig(tokens.cache)}` : ''}</div>
      </div>
      <div class="card">
        <div class="top">
          <span class="icon-codex">$</span>
          <span class="title">Cost (current)</span>
          <span class="spacer"></span>
          <span class="trend${cost > 0 ? ' up' : ''}">${modes.length > 0 ? modes.slice(0, 3).join('+') : 'idle'}</span>
        </div>
        <div class="val money">$${cost.toFixed(2)}</div>
        <div class="sub">${formatDuration(snap.hud?.cost?.total_duration_ms)} wall · ${formatDuration(snap.hud?.cost?.total_api_duration_ms)} API${snap.ccg?.pairCount ? ` · ${snap.ccg.pairCount} CCG` : ''}</div>
      </div>
    </div>
  `;
}

function renderChartsRow(snap: Snapshot): string {
  const hourly = bucketByHour(snap.history);
  const hourlyMax = Math.max(1, ...hourly);
  const hourlyTotal = hourly.reduce((a, b) => a + b, 0);
  const now = new Date();
  const currentHour = now.getHours();

  const barsHtml = hourly
    .map((v, h) => {
      const pct = (v / hourlyMax) * 100;
      const isEmpty = v === 0;
      const isNow = h === currentHour;
      const labelEvery = 3;
      const label = h % labelEvery === 0 ? `<span class="label">${String(h).padStart(2, '0')}</span>` : '';
      return `
        <div class="bar-wrap" title="${h}:00 · ${v} session${v === 1 ? '' : 's'}">
          <div class="bar${isEmpty ? ' empty' : ''}" style="height: ${Math.max(pct, 2)}%; ${isNow ? 'background: linear-gradient(to top, var(--status-running), #FBBF24);' : ''}"></div>
          ${label}
        </div>
      `;
    })
    .join('');

  const breakdown = computeModelBreakdown(snap.history);
  const donut = renderDonut(breakdown);
  const legend = renderLegend(breakdown);

  return `
    <div class="charts-row">
      <div class="card hourly">
        <div class="chart-head">
          <span class="icon-omc">▤</span>
          <span class="title">Hourly Sessions</span>
          <span class="sub">${hourlyTotal} today · 24h</span>
        </div>
        <div class="bars">${barsHtml}</div>
      </div>
      <div class="card breakdown">
        <div class="chart-head">
          <span class="icon-claude">✧</span>
          <span class="title">By Mode</span>
          <span class="sub">${breakdown.total} entries</span>
        </div>
        <div class="donut-wrap">
          <div style="position: relative; width: 140px; height: 140px;">
            ${donut}
            <div class="donut-center"><span class="big">${breakdown.total}</span><span class="small">sessions</span></div>
          </div>
          <div class="legend">${legend}</div>
        </div>
      </div>
    </div>
  `;
}

function renderContextCard(snap: Snapshot): string {
  const cw = snap.hud?.context_window;
  const rl = snap.hud?.rate_limits;
  if (!cw && !rl) return '';
  const used = cw?.used_percentage ?? 0;
  const remaining = cw?.remaining_percentage ?? 100 - used;
  const color = used >= 85 ? 'var(--status-error)' : used >= 60 ? 'var(--status-running)' : 'var(--status-success)';
  const winSize = cw?.context_window_size ?? 0;
  return `
    <div class="card">
      <div class="top">
        <span class="icon-omc">▦</span>
        <span class="title">Context & Rate Limits</span>
        <span class="spacer"></span>
        <span class="trend">session ${snap.hud?.session_id?.slice(0, 8) ?? '—'}</span>
      </div>
      ${cw ? `
        <div style="display: flex; justify-content: space-between; align-items: baseline; gap: 8px;">
          <div><span style="font-size: 28px; font-weight: 800; color: ${color};">${used.toFixed(1)}%</span>
          <span style="font-size: 11px; color: var(--text-disabled); margin-left: 8px;">used · ${formatBig(winSize)} window</span></div>
          <div style="font-size: 11px; color: var(--text-secondary); font-family: Consolas, monospace;">${remaining.toFixed(1)}% free</div>
        </div>
        <div class="ctx-bar"><div class="fill" style="width: ${Math.min(100, used)}%; background: ${color};"></div></div>
      ` : ''}
      ${rl ? `
        <div class="rl-grid">
          ${rl.five_hour ? `<div class="rl-item"><div class="l">5 hour window</div><div class="v">${(rl.five_hour.used_percentage ?? 0).toFixed(1)}%</div><div class="r">${formatReset(rl.five_hour.resets_at)}</div></div>` : ''}
          ${rl.seven_day ? `<div class="rl-item"><div class="l">7 day window</div><div class="v">${(rl.seven_day.used_percentage ?? 0).toFixed(1)}%</div><div class="r">${formatReset(rl.seven_day.resets_at)}</div></div>` : ''}
        </div>
      ` : ''}
    </div>
  `;
}

function renderRecentSessions(snap: Snapshot): string {
  const entries = (snap.history?.entries ?? []).slice(0, 8);
  if (entries.length === 0) {
    return `
      <div class="card sessions-card">
        <div class="sessions-head"><span class="title">Recent Sessions</span></div>
        <div class="sessions-empty">No session history yet.</div>
      </div>
    `;
  }
  const rows = entries
    .map((e) => {
      const isActive = e.sessionId === snap.history?.activeSessionId;
      const dotColor = isActive
        ? 'var(--status-running)'
        : e.hasCancelSignal
        ? 'var(--status-error)'
        : 'var(--status-success)';
      const dur = durationMs(e);
      const updatedMs = e.updateTs || e.directoryMtime;
      const updated = formatRelative(updatedMs);
      const modeStr = e.modes.length > 0 ? e.modes.join(',') : '—';
      return `
        <div class="srow${isActive ? ' active' : ''}">
          <span class="dot" style="background: ${dotColor};"></span>
          <span class="name" title="${escapeHtml(e.sessionId)}">${escapeHtml(e.sessionId.slice(0, 8))}${isActive ? ' · live' : ''}</span>
          <span class="modes" title="${escapeHtml(modeStr)}">${escapeHtml(modeStr)}</span>
          <span class="dur">${dur ? formatDuration(dur) : '—'}</span>
          <span class="bg">${e.backgroundTaskCount} bg</span>
          <span class="updated${Date.now() - updatedMs < 5 * 60 * 1000 ? ' fresh' : ''}">${updated}</span>
        </div>
      `;
    })
    .join('');
  return `
    <div class="card sessions-card">
      <div class="sessions-head">
        <span class="title">Recent Sessions</span>
        <span class="sub" style="color: var(--text-disabled); font-size: 10px; margin-left: 8px;">showing ${entries.length} of ${snap.history?.entries.length ?? 0}</span>
      </div>
      <div class="sessions-list">${rows}</div>
    </div>
  `;
}

function countSessionsToday(history: HistoryLite | null): {
  total: number;
  active: number;
  completed: number;
  cancelled: number;
} {
  if (!history) return { total: 0, active: 0, completed: 0, cancelled: 0 };
  const todayStart = startOfDay(Date.now());
  let total = 0, active = 0, completed = 0, cancelled = 0;
  for (const e of history.entries) {
    const anchor = e.updateTs || e.directoryMtime;
    if (anchor < todayStart) continue;
    total++;
    if (e.sessionId === history.activeSessionId) active++;
    else if (e.hasCancelSignal) cancelled++;
    else completed++;
  }
  return { total, active, completed, cancelled };
}

function listModes(history: HistoryLite | null): string[] {
  if (!history) return [];
  const counts: Record<string, number> = {};
  for (const e of history.entries) {
    for (const m of e.modes) counts[m] = (counts[m] ?? 0) + 1;
  }
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([m]) => m);
}

function getTokens(hud: HUDLite | null): {
  total: number;
  input: number;
  output: number;
  cache: number | null;
  cacheHitPct: number | null;
} {
  const cw = hud?.context_window;
  const input = cw?.total_input_tokens ?? 0;
  const output = cw?.total_output_tokens ?? 0;
  const cacheRead = cw?.current_usage?.cache_read_input_tokens ?? 0;
  const cacheCreate = cw?.current_usage?.cache_creation_input_tokens ?? 0;
  const cache = cacheRead + cacheCreate;
  const total = input + output;
  const cacheHitPct = input > 0 ? Math.round((cacheRead / input) * 100) : null;
  return {
    total,
    input,
    output,
    cache: cache > 0 ? cache : null,
    cacheHitPct: cacheHitPct !== null && cacheHitPct > 0 ? cacheHitPct : null,
  };
}

function bucketByHour(history: HistoryLite | null): number[] {
  const buckets = new Array(24).fill(0) as number[];
  if (!history) return buckets;
  const todayStart = startOfDay(Date.now());
  for (const e of history.entries) {
    const anchor = e.startTs || e.updateTs || e.directoryMtime;
    if (anchor < todayStart) continue;
    const h = new Date(anchor).getHours();
    if (h >= 0 && h < 24) buckets[h]++;
  }
  return buckets;
}

interface BreakdownSlice {
  key: string;
  count: number;
  color: string;
}

interface BreakdownData {
  total: number;
  slices: BreakdownSlice[];
}

function computeModelBreakdown(history: HistoryLite | null): BreakdownData {
  if (!history || history.entries.length === 0) {
    return { total: 0, slices: [] };
  }
  const counts: Record<string, number> = {};
  for (const e of history.entries) {
    if (e.modes.length === 0) counts['plain'] = (counts['plain'] ?? 0) + 1;
    else for (const m of e.modes) counts[m] = (counts[m] ?? 0) + 1;
  }
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const palette: Record<string, string> = {
    autopilot: 'var(--accent-claude)',
    ralph: 'var(--accent-codex)',
    ultrawork: 'var(--accent-gemini)',
    team: 'var(--accent-omc)',
    'omc-teams': 'var(--accent-omc)',
    ralplan: 'var(--status-running)',
    ultraqa: 'var(--status-success)',
    'deep-interview': '#A78BFA',
    'self-improve': '#F472B6',
    plain: 'var(--text-disabled)',
  };
  const slices = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([key, count]) => ({
      key,
      count,
      color: palette[key] ?? 'var(--text-secondary)',
    }));
  return { total, slices };
}

function renderLegend(breakdown: BreakdownData): string {
  if (breakdown.total === 0) {
    return '<div class="row" style="color:var(--text-disabled)">No data</div>';
  }
  return breakdown.slices
    .map(
      (s) =>
        `<div class="row"><span class="dot" style="background:${s.color};"></span><span class="name">${escapeHtml(s.key)}</span><span class="val">${s.count} · ${Math.round((s.count / breakdown.total) * 100)}%</span></div>`,
    )
    .join('');
}

function renderDonut(breakdown: BreakdownData): string {
  if (breakdown.total === 0) {
    return `<svg class="donut-svg" viewBox="0 0 42 42"><circle cx="21" cy="21" r="15.9" fill="transparent" stroke="var(--border)" stroke-width="3"/></svg>`;
  }
  // Circumference of r=15.9 circle ≈ 100 (chosen for dasharray convenience).
  const circumference = 100;
  let offset = 25; // start at 12 o'clock (stroke-dashoffset 25)
  const arcs = breakdown.slices
    .map((s) => {
      const pct = (s.count / breakdown.total) * circumference;
      const arc = `<circle cx="21" cy="21" r="15.9" fill="transparent" stroke="${s.color}" stroke-width="3.5" stroke-dasharray="${pct.toFixed(3)} ${(circumference - pct).toFixed(3)}" stroke-dashoffset="${offset.toFixed(3)}" />`;
      offset -= pct;
      return arc;
    })
    .join('');
  return `<svg class="donut-svg" viewBox="0 0 42 42" style="transform: rotate(0deg);">
    <circle cx="21" cy="21" r="15.9" fill="transparent" stroke="var(--bg-panel)" stroke-width="3.5" />
    ${arcs}
  </svg>`;
}

function durationMs(e: HistoryEntryLite): number | null {
  if (!e.startTs || !e.updateTs) return null;
  const d = e.updateTs - e.startTs;
  if (!Number.isFinite(d) || d <= 0) return null;
  return d;
}

function formatBig(n: number): string {
  if (!Number.isFinite(n) || n === 0) return '0';
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function formatDuration(ms?: number | null): string {
  if (!ms || !Number.isFinite(ms)) return '—';
  const sec = Math.floor(ms / 1000);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function formatRelative(ts: number): string {
  if (!ts) return '—';
  const delta = Date.now() - ts;
  const abs = Math.abs(delta);
  if (abs < 60 * 1000) return 'just now';
  const mins = Math.floor(abs / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  const d = new Date(ts);
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function formatReset(unix?: number): string {
  if (!unix) return '';
  const d = new Date(unix * 1000);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `resets ${hh}:${mm}`;
}

function startOfDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function wireInteractions(): void {
  // No additional wiring currently; refresh handled at top.
}
