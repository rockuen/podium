// Phase 3 · v2.7.8 — Worker transcript summarizer (Haiku one-shot).
//
// Given the accumulated terminal transcripts of each worker in a dissolved
// team, produce a short summary string that we inject back into the leader's
// stdin. The summary lets the leader continue the conversation with context
// but without the workers alive.
//
// Default implementation shells out to the user's existing `claude` CLI:
//
//     claude -p --model haiku          (prompt piped via stdin)
//
// v2.7.9 · Why stdin instead of arg
// ---------------------------------
// Initial implementation (v2.7.8) passed the prompt as a positional argument.
// On Windows this failed two ways:
//   1. `claude -p` would print `Warning: no stdin data received in 3s,
//      proceeding without it` and then exit 1 — the CLI expects stdin to
//      be either closed explicitly or to carry data.
//   2. Long prompts (3-4KB of worker transcript) bump against cmd.exe's
//      ~8KB argv quoting ceiling and get truncated or corrupted.
// Piping the prompt via stdin + calling `.end()` fixes both.
//
// v2.7.13 · Why we dropped `--bare`
// ---------------------------------
// An earlier revision used `claude -p --model haiku` to skip hooks,
// LSP, plugin sync, CLAUDE.md auto-discovery, memory, keychain reads, and
// background prefetches — nice latency win on paper. But `--bare` explicitly
// disables OAuth and keychain reads (per `claude --help`): auth falls back
// to `ANTHROPIC_API_KEY` / apiKeyHelper only. Subscription users (Claude
// Max / Pro) authenticate via OAuth and have no API key, so every dissolve
// call hit `Not logged in · Please run /login` and exited 1, forcing the
// useless raw-tail fallback. Plain `-p --model haiku` uses the user's live
// OAuth session and bills against the same subscription — slightly slower
// startup, but it actually works.
//
// Why Haiku
// ---------
// The dissolve summary is short, structured, and doesn't need deep reasoning.
// Haiku is plenty and fast. The model name is passed as literal `haiku` —
// the CLI resolves it to the current Haiku generation.
//
// Pluggable for tests
// -------------------
// The orchestrator accepts an optional `Summarizer` function so tests can
// stub the CLI call. Default is `claudeBareSummarizer`.

import { spawn } from 'child_process';

export interface TranscriptItem {
  workerId: string;
  transcript: string;
}

export type Summarizer = (items: readonly TranscriptItem[]) => Promise<string>;

/** Transcript is raw terminal output; keep only the tail since that's where
 *  the final answer lives. Cap total call size to stay well under Windows
 *  ~8 KB command-line limit (we pass the prompt as a single arg). */
const MAX_CHARS_PER_WORKER = 1500;

/**
 * v2.7.16 · Strip TUI chrome from a worker transcript before the summarizer
 * sees it. The raw PTY capture is ~95% status-bar refreshes + bypass hints +
 * box-drawing separators; leaving them in front of Haiku caused it to
 * hallucinate ("Final output is 7") or report "Incomplete transcript".
 *
 * Lines dropped:
 *   - `[OMC#x.y.z]` status rows and their siblings
 *   - `⏵⏵ bypass permissions …` hint banners
 *   - `> ` input prompt echoes (worker hasn't typed anything new)
 *   - pure box-drawing separator rows (`────`, `─→` etc.)
 *   - the CLI startup banner (`Claude Code v2.x.x`, `Opus … context`, cwd)
 *   - `Found N settings issue · /doctor for details`
 *   - v2.7.20: Claude v2.1+ Ink animated status rows (`⠋ Processing…`,
 *     `⠙ Shenaniganing…`, `⠸ Synthesizing…`, etc.) — Braille spinner glyph
 *     (U+2800..U+28FF) + verb + `…`. These re-render many times per second
 *     while the model is thinking AND while it idles at the input prompt
 *     post-answer, so they easily fill the MAX_CHARS_PER_WORKER tail slice
 *     and evict the actual `●` assistant bullet out the front.
 *   - v2.7.20: `(esc to interrupt · ctrl+t to show todos)` keyboard hint
 *     banner Claude renders under the status row.
 *
 * v2.7.20 · Additionally collapses runs of consecutive identical non-empty
 * lines down to their first occurrence. Ink repaints the `●` answer bullet
 * line many times as the pane re-wraps at the terminal width, and without
 * dedup those repaints flood the -MAX_CHARS_PER_WORKER tail with duplicates
 * of post-answer noise rather than the answer itself.
 *
 * Blank lines are preserved as paragraph separators (not deduped — two blank
 * lines in a row stay).
 */
export function filterTranscriptChrome(raw: string): string {
  const CHROME_RE = /^[\s─━│┃╭╮╰╯┌┐└┘┏┓┗┛→←↑↓]+$/;
  const STATUS_RE = /^\s*\[OMC#[\d.]+\].*$/;
  const BYPASS_RE = /^\s*⏵⏵\s+bypass permissions.*$/;
  const PROMPT_RE = /^\s*>\s?.*$/;
  const DOCTOR_RE = /^.*Found \d+ settings? issue.*\/doctor.*$/;
  const BANNER_RE =
    /^\s*(?:Claude Code\s+v[\d.]+|Opus\s+[\d.]+.*context|Sonnet\s+[\d.]+.*context|Haiku\s+[\d.]+.*context|Claude Max|c:\\.*Brain)\s*$/i;
  // v2.7.20: Ink spinner status row.
  // Shape: "<braille-glyph> <word>…[ optional trailing hint]"
  const SPINNER_RE = /^\s*[⠀-⣿]\s+\S.*…/;
  // v2.7.20: Keyboard hint under the status row.
  const ESC_HINT_RE = /^\s*\(\s*esc to interrupt.*\)\s*$/;

  const lines = raw.split(/\r?\n/);
  const kept: string[] = [];
  for (const line of lines) {
    if (!line.trim()) {
      kept.push(line);
      continue;
    }
    if (CHROME_RE.test(line)) continue;
    if (STATUS_RE.test(line)) continue;
    if (BYPASS_RE.test(line)) continue;
    if (PROMPT_RE.test(line)) continue;
    if (DOCTOR_RE.test(line)) continue;
    if (BANNER_RE.test(line)) continue;
    if (SPINNER_RE.test(line)) continue;
    if (ESC_HINT_RE.test(line)) continue;
    if (kept.length > 0 && kept[kept.length - 1] === line) continue;
    kept.push(line);
  }
  return kept.join('\n');
}

export function buildSummaryPrompt(items: readonly TranscriptItem[]): string {
  const header =
    "You are summarizing terminal transcripts from parallel Claude workers. " +
    "Each worker was given one small task. Extract the final answer each worker produced. " +
    "The transcripts have been pre-filtered to remove most CLI chrome, but a few status fragments may remain — ignore them. " +
    "Output in exactly this format, one bullet per worker, 1 short sentence each:\n" +
    "- <workerId>: <answer>\n\n" +
    "Workers:\n\n";
  const body = items
    .map((i) => {
      const filtered = filterTranscriptChrome(i.transcript);
      const t = filtered.slice(-MAX_CHARS_PER_WORKER).trim();
      return `=== ${i.workerId} ===\n${t || '(no output captured)'}`;
    })
    .join('\n\n');
  return header + body;
}

export const claudeBareSummarizer: Summarizer = async (items) => {
  if (items.length === 0) return '';
  const prompt = buildSummaryPrompt(items);
  return callClaudeOneshot(prompt);
};

async function callClaudeOneshot(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const isWin = process.platform === 'win32';
    const bin = isWin ? 'claude.exe' : 'claude';
    // v2.7.9: prompt flows via stdin, not argv. `-p` alone = read prompt from
    // stdin, run one-shot, print to stdout. No shell, no quoting, no cmd.exe
    // length limit, no "no stdin data received in 3s" warning.
    // v2.7.13: dropped `--bare` so subscription (OAuth) users can auth.
    const args = ['-p', '--model', 'haiku'];
    const proc = spawn(bin, args, {
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PYTHONIOENCODING: 'utf-8',
        LANG: process.env.LANG ?? 'en_US.UTF-8',
      },
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };
    const timer = setTimeout(() => {
      try {
        proc.kill();
      } catch {
        /* already dead */
      }
      done(() => reject(new Error('claude -p timed out after 60s')));
    }, 60_000);
    proc.stdout.setEncoding('utf8');
    proc.stderr.setEncoding('utf8');
    proc.stdout.on('data', (d: string) => (stdout += d));
    proc.stderr.on('data', (d: string) => (stderr += d));
    proc.on('error', (err: Error) => {
      clearTimeout(timer);
      done(() => reject(new Error(`spawn claude failed: ${err.message}`)));
    });
    proc.on('close', (code: number | null) => {
      clearTimeout(timer);
      if (code !== 0) {
        done(() =>
          reject(new Error(`claude -p exited ${code}: ${stderr.slice(0, 500)}`)),
        );
        return;
      }
      done(() => resolve(stdout.trim()));
    });
    // stdin.write can EPIPE if claude exits before we finish writing; swallow
    // and let the 'close' handler report the real exit code.
    proc.stdin.on('error', () => {
      /* handled via close/exit */
    });
    try {
      proc.stdin.write(prompt, 'utf8');
      proc.stdin.end();
    } catch (err) {
      clearTimeout(timer);
      const msg = err instanceof Error ? err.message : String(err);
      done(() => reject(new Error(`stdin write failed: ${msg}`)));
    }
  });
}

export const __testing = { MAX_CHARS_PER_WORKER };
