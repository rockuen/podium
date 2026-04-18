export {};

declare function acquireVsCodeApi(): { postMessage: (msg: unknown) => void };

type AgentModel = 'claude' | 'codex' | 'gemini';

interface SlotState {
  model: AgentModel;
  count: number;
  selected: boolean;
}

const vscode = acquireVsCodeApi();

function boot(): void {
  const chipsEl = document.getElementById('chips')!;
  const promptEl = document.getElementById('prompt') as HTMLTextAreaElement;
  const cliEl = document.getElementById('cli')!;
  const copyBtn = document.getElementById('copy-cli')!;
  const spawnBtn = document.getElementById('podium-spawn') as HTMLButtonElement;
  const cancelBtn = document.getElementById('podium-cancel')!;
  const closeBtn = document.getElementById('podium-close')!;
  const statusEl = document.getElementById('status')!;
  const spawnCountBadge = document.getElementById('spawn-count')!;

  const slots: Record<AgentModel, SlotState> = {
    claude: { model: 'claude', count: 2, selected: true },
    codex: { model: 'codex', count: 1, selected: false },
    gemini: { model: 'gemini', count: 1, selected: false },
  };
  const availability: Record<AgentModel, 'ok' | 'missing' | 'unknown'> = {
    claude: 'unknown',
    codex: 'unknown',
    gemini: 'unknown',
  };
  const healthStateEl = document.getElementById('health-state')!;
  const healthRefreshEl = document.getElementById('health-refresh')!;
  const modeToggleEl = document.getElementById('mode-toggle')!;
  const modeHintEl = document.getElementById('mode-hint')!;

  let mode: 'shell' | 'in-session' = 'shell';
  let submitting = false;

  const MODE_HINTS: Record<'shell' | 'in-session', string> = {
    shell: 'Shell: opens a terminal and runs <code>omc team …</code> → tmux session + Sessions tree + Multi-Pane grid.',
    'in-session': 'In-session: opens Claude webview and sends <code>/team …</code> → Claude orchestrates with Task tool (no tmux session, Sessions tree stays empty).',
  };

  function setMode(next: 'shell' | 'in-session'): void {
    mode = next;
    for (const btn of Array.from(modeToggleEl.querySelectorAll('.mbtn'))) {
      btn.classList.toggle('active', btn.getAttribute('data-mode') === next);
    }
    modeHintEl.innerHTML = MODE_HINTS[next];
    updateCli();
  }

  modeToggleEl.addEventListener('mousedown', (ev) => {
    const target = ev.target as HTMLElement | null;
    if (!target) return;
    const btn = target.closest('.mbtn') as HTMLElement | null;
    if (!btn) return;
    ev.preventDefault();
    const next = btn.getAttribute('data-mode');
    if (next === 'shell' || next === 'in-session') setMode(next);
  });

  function clamp(n: number): number {
    return Math.max(1, Math.min(10, Math.floor(n)));
  }

  function activeSlots(): SlotState[] {
    return (Object.values(slots) as SlotState[]).filter((s) => s.selected);
  }

  function syncChipVisuals(): void {
    for (const model of Object.keys(slots) as AgentModel[]) {
      const chip = chipsEl.querySelector(`.chip[data-model="${model}"]`) as HTMLElement | null;
      if (!chip) continue;
      chip.classList.toggle('selected', slots[model].selected);
      chip.classList.toggle('unavailable', availability[model] === 'missing');
      const valEl = chip.querySelector('.val');
      if (valEl) valEl.textContent = String(slots[model].count);
      const dot = document.getElementById(`health-dot-${model}`);
      if (dot) {
        dot.className = `health-dot ${availability[model]}`;
        dot.setAttribute(
          'title',
          availability[model] === 'ok'
            ? `${model} CLI resolved`
            : availability[model] === 'missing'
            ? `${model} CLI not found on PATH — run omc doctor`
            : 'health not probed yet',
        );
      }
    }
  }

  function updateCli(): void {
    const active = activeSlots();
    const totalWorkers = active.reduce((sum, s) => sum + s.count, 0);
    spawnCountBadge.textContent = totalWorkers > 0 ? `×${totalWorkers}` : '—';
    const prompt = promptEl.value.trim();
    const preview = prompt.length > 50 ? prompt.slice(0, 47) + '...' : prompt;
    const prefix = mode === 'shell' ? 'omc team' : '/team';
    if (active.length === 0) {
      cliEl.textContent = `${prefix} … (select a model first)`;
      return;
    }
    const slotStr = active.map((s) => `${s.count}:${s.model}`).join(',');
    cliEl.textContent = `${prefix} ${slotStr} "${preview || '…'}"`;
  }

  function setStatus(level: 'running' | 'success' | 'error' | '', text: string): void {
    statusEl.className = 'status-banner';
    if (!level) {
      statusEl.textContent = '';
      return;
    }
    statusEl.classList.add('show', level);
    const prefix = level === 'running' ? '⟳ ' : level === 'success' ? '✓ ' : '✗ ';
    statusEl.textContent = prefix + text;
  }

  // One delegated mousedown handler for the chip area — Antigravity webviews
  // drop dot-typed postMessage names and occasionally swallow synthesised click
  // events, but mousedown is consistently delivered.
  chipsEl.addEventListener('mousedown', (ev) => {
    const target = ev.target as HTMLElement | null;
    if (!target) return;

    // Stepper buttons (±) — also mousedown-based
    const stepBtn = target.closest('button[data-step]') as HTMLButtonElement | null;
    if (stepBtn) {
      ev.preventDefault();
      ev.stopPropagation();
      const chip = stepBtn.closest('.chip') as HTMLElement | null;
      const model = chip?.getAttribute('data-model') as AgentModel | null;
      if (!model || !slots[model]) return;
      const delta = Number(stepBtn.getAttribute('data-step')) || 0;
      slots[model].count = clamp(slots[model].count + delta);
      slots[model].selected = true;
      syncChipVisuals();
      updateCli();
      return;
    }

    // Chip body toggle
    const chip = target.closest('.chip') as HTMLElement | null;
    if (!chip) return;
    const model = chip.getAttribute('data-model') as AgentModel | null;
    if (!model || !slots[model]) return;
    ev.preventDefault();
    slots[model].selected = !slots[model].selected;
    syncChipVisuals();
    updateCli();
  });

  promptEl.addEventListener('input', updateCli);

  function submit(): void {
    if (submitting) return;
    const prompt = promptEl.value.trim();
    if (!prompt) {
      setStatus('error', 'prompt is required');
      promptEl.focus();
      return;
    }
    const active = activeSlots();
    if (active.length === 0) {
      setStatus('error', 'select at least one model');
      return;
    }
    const unavailable = active.filter((s) => availability[s.model] === 'missing').map((s) => s.model);
    if (unavailable.length > 0) {
      setStatus('error', `CLI not found: ${unavailable.join(', ')} — run omc doctor`);
      return;
    }
    const totalWorkers = active.reduce((sum, s) => sum + s.count, 0);
    if (totalWorkers > 10) {
      setStatus('error', `total workers ${totalWorkers} exceeds limit (10)`);
      return;
    }
    submitting = true;
    spawnBtn.disabled = true;
    setStatus('running', 'sending request to extension…');
    vscode.postMessage({
      type: 'submit',
      mode,
      slots: active.map((s) => ({ model: s.model, count: s.count })),
      prompt,
    });
  }

  function cancel(): void {
    vscode.postMessage({ type: 'cancel' });
  }

  spawnBtn.addEventListener('mousedown', (ev) => {
    ev.preventDefault();
    submit();
  });
  cancelBtn.addEventListener('mousedown', (ev) => {
    ev.preventDefault();
    cancel();
  });
  closeBtn.addEventListener('mousedown', (ev) => {
    ev.preventDefault();
    cancel();
  });
  copyBtn.addEventListener('mousedown', (ev) => {
    ev.preventDefault();
    const text = cliEl.textContent ?? '';
    void navigator.clipboard?.writeText(text).catch(() => {
      /* clipboard may be unavailable */
    });
    const orig = copyBtn.textContent;
    copyBtn.textContent = '✓';
    setTimeout(() => {
      copyBtn.textContent = orig;
    }, 900);
  });

  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') {
      ev.preventDefault();
      cancel();
      return;
    }
    if ((ev.metaKey || ev.ctrlKey) && ev.key === 'Enter') {
      ev.preventDefault();
      submit();
    }
  });

  window.addEventListener('message', (ev) => {
    const msg = ev.data;
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'status') {
      setStatus(msg.level, msg.text);
      if (msg.level === 'error') {
        submitting = false;
        spawnBtn.disabled = false;
      }
      return;
    }
    if (msg.type === 'health') {
      applyHealth(msg.health);
      return;
    }
  });

  function applyHealth(health: { probes?: Array<{ provider: string; found: boolean; version?: string }>; missing?: string[]; error?: string; checkedAt?: number }): void {
    healthRefreshEl.classList.remove('spin');
    if (health?.error) {
      for (const m of Object.keys(availability) as AgentModel[]) availability[m] = 'unknown';
      healthStateEl.className = 'state error';
      healthStateEl.textContent = `probe failed · ${health.error.slice(0, 60)}`;
      syncChipVisuals();
      return;
    }
    const probes = Array.isArray(health?.probes) ? health!.probes : [];
    const versions: Partial<Record<AgentModel, string>> = {};
    const probed = new Set<AgentModel>();
    for (const p of probes) {
      if (p.provider === 'claude' || p.provider === 'codex' || p.provider === 'gemini') {
        availability[p.provider] = p.found ? 'ok' : 'missing';
        probed.add(p.provider);
        if (p.version) versions[p.provider] = p.version;
      }
    }
    // Providers not in probes stay 'unknown' (role routing didn't request them).
    for (const m of Object.keys(availability) as AgentModel[]) {
      if (!probed.has(m)) availability[m] = 'unknown';
    }
    const missing = health?.missing ?? probes.filter((p) => !p.found).map((p) => p.provider);
    const okCount = probes.filter((p) => p.found).length;
    if (missing.length === 0 && okCount > 0) {
      healthStateEl.className = 'state ok';
      const parts = probes.filter((p) => p.found).map((p) => `${p.provider}${p.version ? ' ' + shortVer(p.version) : ''}`);
      healthStateEl.textContent = `all ready · ${parts.join(' · ')}`;
    } else if (okCount === 0 && probes.length === 0) {
      healthStateEl.className = 'state warn';
      healthStateEl.textContent = 'no team.roleRouting configured — all models probed as unknown';
    } else if (missing.length > 0) {
      healthStateEl.className = 'state warn';
      healthStateEl.textContent = `missing: ${missing.join(', ')} · ok: ${okCount}/${probes.length}`;
    }
    syncChipVisuals();
    updateCli();
  }

  function shortVer(v: string): string {
    const m = v.match(/\d+\.\d+\.\d+/);
    return m ? m[0] : v.slice(0, 10);
  }

  healthRefreshEl.addEventListener('mousedown', (ev) => {
    ev.preventDefault();
    healthRefreshEl.classList.add('spin');
    healthStateEl.className = 'state';
    healthStateEl.textContent = 'probing…';
    vscode.postMessage({ type: 'refresh-health' });
  });

  setMode('shell');
  syncChipVisuals();
  updateCli();
  promptEl.focus();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
