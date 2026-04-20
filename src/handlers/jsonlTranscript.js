// @module handlers/jsonlTranscript — read Claude Code's own session JSONL and
// render it as Markdown / plain text. Replaces the v2.6.8 shadow-terminal
// approach, which could not faithfully reconstruct Ink-rendered fullscreen
// conversations from PTY bytes. The JSONL is Claude's own persisted record
// of every turn, so it is the authoritative source.
//
// Pure-Node (no vscode import). Consumer resolves cwd + sessionId and passes
// them in. Schema discovery confirmed against a real session file, not guessed:
//   top-level: type ('user'|'assistant'|'system'|'summary'|...), message,
//              timestamp, uuid, parentUuid, isSidechain, cwd, sessionId, version
//   message.content: string | Array<ContentBlock>
//   ContentBlock.type: 'text' | 'thinking' | 'tool_use' | 'tool_result'

const fs = require('fs');
const path = require('path');
const os = require('os');

// Tool_result stdout can grow huge (full build logs, test output, file dumps).
// Keep first HEAD + last TAIL lines and collapse the middle so the Markdown
// stays readable. Configurable here, not a runtime setting.
const TOOL_RESULT_HEAD_LINES = 200;
const TOOL_RESULT_TAIL_LINES = 50;

// Mirrors SessionTreeDataProvider._getProjectDir slug logic: replace every
// non-alphanumeric char with '-'. Claude writes this verbatim for cwd.
// Drive-letter case is preserved as-given on disk — observed both 'C--...' and
// 'c--...' depending on how the cwd was typed at launch. So we try exact,
// case-insensitive, and fuzzy basename contains, in order.
function slugifyCwd(cwd) {
  return String(cwd || '').replace(/[^a-zA-Z0-9]/g, '-');
}

function getProjectsRoot() {
  return path.join(os.homedir(), '.claude', 'projects');
}

function findProjectDir(cwd) {
  if (!cwd) return null;
  const projectsDir = getProjectsRoot();
  if (!fs.existsSync(projectsDir)) return null;

  const dirName = slugifyCwd(cwd);
  const primary = path.join(projectsDir, dirName);
  if (fs.existsSync(primary)) return primary;

  try {
    const dirs = fs.readdirSync(projectsDir);
    const exact = dirs.find(d => d.toLowerCase() === dirName.toLowerCase());
    if (exact) return path.join(projectsDir, exact);
    const base = path.basename(cwd).replace(/[^a-zA-Z0-9]/g, '-').toLowerCase();
    if (base) {
      const partial = dirs.find(d => d.toLowerCase().includes(base));
      if (partial) return path.join(projectsDir, partial);
    }
  } catch (_) { /* ignore */ }
  return null;
}

// Returns an absolute path to <projectDir>/<sessionId>.jsonl if it exists,
// otherwise null. Also probes ./trash/ so a soft-deleted session still exports.
function getSessionJsonlPath(cwd, sessionId) {
  if (!sessionId) return null;
  const projDir = findProjectDir(cwd);
  if (!projDir) return null;
  const direct = path.join(projDir, sessionId + '.jsonl');
  if (fs.existsSync(direct)) return direct;
  const trashed = path.join(projDir, 'trash', sessionId + '.jsonl');
  if (fs.existsSync(trashed)) return trashed;
  return null;
}

// Parse the full file into an array of turns in file order. Bad lines are
// logged and skipped; blanks are silently skipped. Files in practice are a
// few MB at most so a single readFileSync is fine.
function readSessionTurns(jsonlPath) {
  const raw = fs.readFileSync(jsonlPath, 'utf8');
  const lines = raw.split(/\r?\n/);
  const turns = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    try {
      turns.push(JSON.parse(line));
    } catch (e) {
      // Corrupt line; don't abort the whole export.
      console.warn('[jsonlTranscript] skip malformed line', i + 1, '-', e.message);
    }
  }
  return turns;
}

// Internal: normalize message.content to a content-block array. Claude writes
// user turns as a plain string for typed prompts and an array for everything
// else (tool results, hook-injected content, etc).
function toContentBlocks(content) {
  if (content == null) return [];
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (Array.isArray(content)) return content;
  return [];
}

function truncateLongOutput(text) {
  const lines = String(text).split('\n');
  if (lines.length <= TOOL_RESULT_HEAD_LINES + TOOL_RESULT_TAIL_LINES + 3) return text;
  const head = lines.slice(0, TOOL_RESULT_HEAD_LINES);
  const tail = lines.slice(-TOOL_RESULT_TAIL_LINES);
  const dropped = lines.length - head.length - tail.length;
  return [...head, '', `... [${dropped} lines truncated] ...`, '', ...tail].join('\n');
}

// Extract a plain textual representation of a tool_result content field.
// tool_result.content is usually a string but may also be an array of blocks.
function toolResultText(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(b => {
      if (b == null) return '';
      if (typeof b === 'string') return b;
      if (b.type === 'text' && typeof b.text === 'string') return b.text;
      return JSON.stringify(b);
    }).join('\n');
  }
  return JSON.stringify(content);
}

// Heading picker per JSONL top-level type.
function headingFor(turnType, role) {
  if (turnType === 'summary')  return '## Summary';
  if (turnType === 'system')   return '## System';
  if (role === 'user')         return '## User';
  if (role === 'assistant')    return '## Assistant';
  if (turnType === 'user')     return '## User';
  if (turnType === 'assistant')return '## Assistant';
  return '## ' + (turnType || 'Entry');
}

// Render a single JSONL turn as a Markdown string. Skips non-conversation
// bookkeeping entries (file-history-snapshot, attachment, permission-mode,
// last-prompt) since they are tooling metadata, not conversation.
function renderTurnMarkdown(turn) {
  const tt = turn.type;
  if (tt === 'file-history-snapshot' || tt === 'permission-mode' || tt === 'last-prompt' || tt === 'attachment') {
    return null;
  }

  // Summary records have their own shape: { type:'summary', summary, leafUuid }
  if (tt === 'summary') {
    const s = turn.summary || turn.message?.content || '';
    return headingFor(tt) + '\n\n' + String(s).trim() + '\n';
  }

  const role = turn.message?.role;
  const blocks = toContentBlocks(turn.message?.content);
  if (blocks.length === 0) return null;

  const parts = [headingFor(tt, role)];
  const ts = turn.timestamp ? `*${turn.timestamp}*\n` : '';
  if (ts) parts.push(ts);

  for (const b of blocks) {
    if (!b || typeof b !== 'object') continue;
    switch (b.type) {
      case 'text': {
        const text = (b.text || '').trim();
        if (text) parts.push(text + '\n');
        break;
      }
      case 'thinking': {
        // Thinking blocks are usually noise for exports; include only if
        // non-empty and collapsed behind a <details> so the doc stays readable.
        const t = (b.thinking || '').trim();
        if (t) parts.push('<details><summary>thinking</summary>\n\n' + t + '\n\n</details>\n');
        break;
      }
      case 'tool_use': {
        const name = b.name || 'tool';
        let input = '';
        try { input = JSON.stringify(b.input ?? {}, null, 2); } catch (_) { input = String(b.input); }
        parts.push('### Tool: ' + name + '\n\n```json\n' + input + '\n```\n');
        break;
      }
      case 'tool_result': {
        const raw = toolResultText(b.content);
        const body = truncateLongOutput(raw);
        parts.push('### Tool Result\n\n```\n' + body + '\n```\n');
        break;
      }
      default: {
        let dump = '';
        try { dump = JSON.stringify(b, null, 2); } catch (_) { dump = String(b); }
        parts.push('*(unknown content block: `' + (b.type || 'untyped') + '`)*\n\n```json\n' + dump + '\n```\n');
      }
    }
  }

  return parts.join('\n');
}

// Render plain text, same semantic structure, no MD symbols. Used by Copy All
// clipboard path — markdown-heavy text in a clipboard is annoying to paste
// into chat apps / docs, so we emit a clean prose form.
function renderTurnPlain(turn) {
  const tt = turn.type;
  if (tt === 'file-history-snapshot' || tt === 'permission-mode' || tt === 'last-prompt' || tt === 'attachment') {
    return null;
  }

  if (tt === 'summary') {
    const s = turn.summary || turn.message?.content || '';
    return 'SUMMARY:\n' + String(s).trim();
  }

  const role = turn.message?.role;
  const label = (tt === 'system') ? 'SYSTEM'
    : (role === 'user' || tt === 'user') ? 'USER'
    : (role === 'assistant' || tt === 'assistant') ? 'ASSISTANT'
    : (tt || 'ENTRY').toUpperCase();

  const blocks = toContentBlocks(turn.message?.content);
  if (blocks.length === 0) return null;

  const pieces = [];
  for (const b of blocks) {
    if (!b || typeof b !== 'object') continue;
    if (b.type === 'text') {
      const t = (b.text || '').trim();
      if (t) pieces.push(t);
    } else if (b.type === 'thinking') {
      // skip — too noisy for clipboard
    } else if (b.type === 'tool_use') {
      const name = b.name || 'tool';
      let input = '';
      try { input = JSON.stringify(b.input ?? {}); } catch (_) { input = String(b.input); }
      pieces.push('[Tool: ' + name + '] ' + input);
    } else if (b.type === 'tool_result') {
      const raw = toolResultText(b.content);
      pieces.push('[Tool Result]\n' + truncateLongOutput(raw));
    }
  }

  if (pieces.length === 0) return null;
  return label + ':\n' + pieces.join('\n');
}

function renderMarkdown(turns, meta) {
  meta = meta || {};
  const now = new Date();
  const header = [
    '# ' + (meta.title || 'Claude Conversation'),
    '',
    '- Exported: ' + now.toISOString(),
    '- Session: ' + (meta.sessionId || 'N/A'),
    '- Working dir: ' + (meta.cwd || 'N/A'),
    '- Turns: ' + turns.length,
    '',
    '---',
    '',
  ].join('\n');

  const body = [];
  for (const turn of turns) {
    const md = renderTurnMarkdown(turn);
    if (md) body.push(md);
  }
  return header + body.join('\n---\n\n') + '\n';
}

function renderPlainText(turns) {
  const lines = [];
  for (const turn of turns) {
    const p = renderTurnPlain(turn);
    if (p) lines.push(p);
  }
  return lines.join('\n\n----\n\n');
}

// Count only "real" conversation turns (skip tooling metadata). Used for
// status toasts like "Loaded transcript · N turns".
function countConversationTurns(turns) {
  let n = 0;
  for (const t of turns) {
    const tt = t.type;
    if (tt === 'user' || tt === 'assistant' || tt === 'summary' || tt === 'system') n++;
  }
  return n;
}

module.exports = {
  getSessionJsonlPath,
  readSessionTurns,
  renderMarkdown,
  renderPlainText,
  countConversationTurns,
  // exported for tests / debugging
  _internal: { slugifyCwd, findProjectDir, TOOL_RESULT_HEAD_LINES, TOOL_RESULT_TAIL_LINES },
};
