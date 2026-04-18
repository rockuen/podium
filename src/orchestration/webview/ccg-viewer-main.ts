export {};

declare function acquireVsCodeApi(): {
  postMessage: (msg: unknown) => void;
};

interface ArtifactPayload {
  provider: 'codex' | 'gemini' | 'claude';
  createdAt: number;
  exitCode: number | null;
  finalPrompt: string;
  rawOutput: string;
  filePath: string;
  fileName: string;
}

interface PairPayload {
  id: string;
  title: string;
  createdAt: number;
  originalTask: string;
  codex: ArtifactPayload | null;
  gemini: ArtifactPayload | null;
  claude: ArtifactPayload | null;
}

const vscode = acquireVsCodeApi();
const app = document.getElementById('app')!;

window.addEventListener('message', (ev) => {
  const msg = ev.data;
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'pair') {
    render(msg.pair ?? null);
  }
});

vscode.postMessage({ type: 'ready' });

function render(pair: PairPayload | null): void {
  if (!pair) {
    app.innerHTML = `
      <div class="no-pair"><div>
        <strong>CCG Viewer</strong>
        Select a CCG session from the <em>CCG</em> sidebar to inspect Codex + Gemini responses side-by-side.<br/>
        Run a new comparison with <code>/ccg "your question"</code>.
      </div></div>
    `;
    return;
  }

  const isoShort = new Date(pair.createdAt).toLocaleString();
  const statusOk = pair.codex?.exitCode === 0 || pair.gemini?.exitCode === 0;
  const providers = ['codex', 'gemini', 'claude']
    .filter((p) => (pair as unknown as Record<string, unknown>)[p])
    .join('+');
  const subtitle = pair.originalTask
    ? pair.originalTask.replace(/\s+/g, ' ').slice(0, 120)
    : `ccg · ${providers}`;
  const summary = buildSummary(pair);

  const codexCol = pair.codex
    ? renderColumn('codex', 'Codex', 'C', pair.codex, pair.id)
    : renderEmptyColumn('codex', 'Codex');
  const geminiCol = pair.gemini
    ? renderColumn('gemini', 'Gemini', 'G', pair.gemini, pair.id)
    : renderEmptyColumn('gemini', 'Gemini');
  const claudeCol = renderClaudeColumn(pair);

  app.innerHTML = `
    <div id="header">
      <span class="head-icon">⇄</span>
      <div class="title">
        <div class="name">${escapeHtml(pair.title)}</div>
        <div class="sub">$ ccg "${escapeHtml(subtitle)}"</div>
      </div>
      <div class="spacer"></div>
      <div class="badge${statusOk ? '' : ' fail'}">
        <span class="dot"></span>
        <span>${statusOk ? 'Completed' : 'Exit issue'} · ${escapeHtml(isoShort)}</span>
      </div>
    </div>
    <div id="summary">
      <span class="sum-icon">✧</span>
      <div class="sum-text">${summary}</div>
    </div>
    <div id="body">
      ${codexCol}
      ${geminiCol}
      ${claudeCol}
    </div>
  `;

  wireButtons();
}

function renderColumn(
  provider: 'codex' | 'gemini',
  label: string,
  iconChar: string,
  a: ArtifactPayload,
  pairId: string,
): string {
  const body = renderMarkdown(a.rawOutput);
  const tag = a.exitCode === 0 ? 'exit 0' : a.exitCode === null ? 'no exit' : `exit ${a.exitCode}`;
  const prompt = a.finalPrompt
    ? `<div class="prompt">${escapeHtml(truncate(a.finalPrompt, 400))}</div>`
    : '';
  return `
    <div class="col ${provider}-col" data-provider="${provider}">
      <div class="col-head">
        <span class="icon">${iconChar}</span>
        <span class="name">${label}</span>
        <span class="spacer"></span>
        <span class="tag">${escapeHtml(tag)}</span>
      </div>
      <div class="col-body">
        ${prompt}
        <div class="md">${body}</div>
      </div>
      <div class="col-foot">
        <button data-action="copy" data-target="${escapeAttr(a.rawOutput)}">Copy</button>
        <button data-action="open-source" data-target="${escapeAttr(a.filePath)}">Open .md</button>
      </div>
    </div>
  `;
}

function renderEmptyColumn(provider: 'codex' | 'gemini' | 'claude', label: string): string {
  return `
    <div class="col ${provider}-col" data-provider="${provider}">
      <div class="col-head">
        <span class="icon">—</span>
        <span class="name">${label}</span>
        <span class="spacer"></span>
        <span class="tag">missing</span>
      </div>
      <div class="empty-placeholder">
        <div>
          <strong>No ${label} artifact</strong>
          This CCG round did not produce a ${label} response.
        </div>
      </div>
    </div>
  `;
}

function renderClaudeColumn(pair: PairPayload): string {
  if (pair.claude) {
    const body = renderMarkdown(pair.claude.rawOutput);
    return `
      <div class="col claude-col" data-provider="claude">
        <div class="col-head">
          <span class="icon">✧</span>
          <span class="name">Claude Synthesis</span>
          <span class="spacer"></span>
          <span class="tag">saved</span>
        </div>
        <div class="col-body"><div class="md">${body}</div></div>
        <div class="col-foot">
          <button class="primary" data-action="copy" data-target="${escapeAttr(pair.claude.rawOutput)}">Copy Synthesis</button>
          <button data-action="open-source" data-target="${escapeAttr(pair.claude.filePath)}">Open .md</button>
        </div>
      </div>
    `;
  }
  return `
    <div class="col claude-col" data-provider="claude">
      <div class="col-head">
        <span class="icon">✧</span>
        <span class="name">Claude Synthesis</span>
        <span class="spacer"></span>
        <span class="tag">inline</span>
      </div>
      <div class="empty-placeholder">
        <div>
          <strong>Synthesis lives in chat</strong>
          Ask Claude to compare the two columns in the next message. Or re-run to regenerate the comparison.
        </div>
      </div>
      <div class="col-foot">
        <button class="primary" data-action="rerun" data-pair="${escapeAttr(pair.id)}">Re-run /ccg</button>
        <button data-action="copy-both" data-codex="${escapeAttr(pair.codex?.rawOutput ?? '')}" data-gemini="${escapeAttr(pair.gemini?.rawOutput ?? '')}">Copy both</button>
      </div>
    </div>
  `;
}

function buildSummary(pair: PairPayload): string {
  const parts: string[] = [];
  const codexOk = pair.codex?.exitCode === 0;
  const geminiOk = pair.gemini?.exitCode === 0;
  if (pair.codex && pair.gemini) {
    parts.push(
      `Codex ${codexOk ? '✓' : '✗'} + Gemini ${geminiOk ? '✓' : '✗'} responded ${formatWindow(pair.codex.createdAt, pair.gemini.createdAt)}.`,
    );
  } else if (pair.codex) {
    parts.push(`Only Codex responded ${codexOk ? 'successfully' : 'with non-zero exit'}. Gemini missing.`);
  } else if (pair.gemini) {
    parts.push(`Only Gemini responded ${geminiOk ? 'successfully' : 'with non-zero exit'}. Codex missing.`);
  }
  if (pair.originalTask) {
    const hint = pair.originalTask.replace(/\s+/g, ' ').slice(0, 180);
    parts.push(`Question: ${escapeHtml(hint)}${pair.originalTask.length > 180 ? '…' : ''}`);
  }
  return parts.join(' ');
}

function formatWindow(a: number, b: number): string {
  const delta = Math.abs(a - b);
  if (delta < 1000) return 'within a second';
  const sec = Math.round(delta / 1000);
  if (sec < 60) return `within ${sec}s`;
  const min = Math.round(sec / 60);
  return `within ${min}m`;
}

function wireButtons(): void {
  for (const btn of Array.from(app.querySelectorAll('button[data-action]'))) {
    btn.addEventListener('click', () => {
      const action = btn.getAttribute('data-action');
      if (action === 'copy') {
        const text = btn.getAttribute('data-target') ?? '';
        vscode.postMessage({ type: 'copy', text });
      } else if (action === 'open-source') {
        const filePath = btn.getAttribute('data-target') ?? '';
        vscode.postMessage({ type: 'open-source', text: filePath });
      } else if (action === 'rerun') {
        const pairId = btn.getAttribute('data-pair') ?? '';
        vscode.postMessage({ type: 'rerun', pairId });
      } else if (action === 'copy-both') {
        const codex = btn.getAttribute('data-codex') ?? '';
        const gemini = btn.getAttribute('data-gemini') ?? '';
        const merged = `# Codex\n\n${codex}\n\n---\n\n# Gemini\n\n${gemini}\n`;
        vscode.postMessage({ type: 'copy', text: merged });
      }
    });
  }
}

function renderMarkdown(src: string): string {
  if (!src) return '<em style="color:var(--text-disabled)">(no output)</em>';
  const lines = src.split(/\r?\n/);
  const out: string[] = [];
  let inCode = false;
  let codeBuf: string[] = [];
  let inList = false;
  let listKind: 'ul' | 'ol' = 'ul';
  const pushParagraph = (chunks: string[]) => {
    if (chunks.length === 0) return;
    out.push(`<p>${inlineMd(chunks.join(' '))}</p>`);
  };
  let paragraph: string[] = [];
  const closeParagraph = () => {
    pushParagraph(paragraph);
    paragraph = [];
  };
  const closeList = () => {
    if (inList) {
      out.push(listKind === 'ul' ? '</ul>' : '</ol>');
      inList = false;
    }
  };
  for (const line of lines) {
    const codeFence = line.match(/^```\s*(\S*)\s*$/);
    if (codeFence) {
      if (!inCode) {
        closeParagraph();
        closeList();
        inCode = true;
        codeBuf = [];
      } else {
        out.push(`<pre><code>${escapeHtml(codeBuf.join('\n'))}</code></pre>`);
        inCode = false;
        codeBuf = [];
      }
      continue;
    }
    if (inCode) {
      codeBuf.push(line);
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      closeParagraph();
      closeList();
      const level = Math.min(heading[1].length, 3);
      out.push(`<h${level}>${inlineMd(heading[2].trim())}</h${level}>`);
      continue;
    }
    const olItem = line.match(/^\s*(\d+)\.\s+(.+)$/);
    const ulItem = line.match(/^\s*[-*]\s+(.+)$/);
    if (olItem || ulItem) {
      closeParagraph();
      const nextKind: 'ul' | 'ol' = olItem ? 'ol' : 'ul';
      if (!inList || listKind !== nextKind) {
        closeList();
        out.push(nextKind === 'ul' ? '<ul>' : '<ol>');
        inList = true;
        listKind = nextKind;
      }
      const content = (olItem ? olItem[2] : ulItem![1]).trim();
      out.push(`<li>${inlineMd(content)}</li>`);
      continue;
    }
    if (line.trim() === '') {
      closeParagraph();
      closeList();
      continue;
    }
    paragraph.push(line.trim());
  }
  if (inCode) {
    out.push(`<pre><code>${escapeHtml(codeBuf.join('\n'))}</code></pre>`);
  }
  closeParagraph();
  closeList();
  return out.join('\n');
}

function inlineMd(src: string): string {
  let out = escapeHtml(src);
  out = out.replace(/`([^`]+)`/g, '<code>$1</code>');
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(^|\s)\*([^*\s][^*]*[^*\s]|[^*\s])\*(?=\s|$|[.,;:!?)])/g, '$1<em>$2</em>');
  return out;
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

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 3) + '...';
}
