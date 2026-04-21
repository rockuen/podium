// Phase 2 · v2.7.7 — ANSI / VT control sequence stripper with structural
// preservation of cursor movement.
//
// We parse leader output streams (Claude/Codex/Gemini CLIs) to detect
// `@worker-N:` routing tokens and prompt idle states. The raw stream is
// littered with CSI color codes, cursor moves, OSC title sequences, alt-screen
// toggles, and DEC private-mode set/reset — none of which carry text content.
//
// Critical behavior (v2.7.7 fix)
// ------------------------------
// Claude Code v2.1+ uses an Ink TUI that lays out its content grid via
// absolute cursor positioning (`ESC[row;colH`, `ESC[nC`, etc.) instead of
// literal newlines and spaces. If we simply delete those sequences, two
// completely unrelated rows of visible output get concatenated into one
// logical line for our parser — which is how worker-2's routing payload ended
// up polluted with the model's "*Manifesting…" thinking indicator in the
// wild (2026-04-21). We now convert cursor moves to approximate whitespace
// BEFORE the general strip so the parser still sees row/column boundaries:
//
//   ESC[<r>;<c>H, ESC[<r>H, ESC[H          → \n    (row set / cursor home)
//   ESC[<n>B, ESC[<n>E                      → \n    (cursor down / next line)
//   ESC[<n>C                                → N×" " (cursor forward = gap)
//
// After that, the remaining CSI / OSC / DCS / ESC-prefixed sequences are
// dropped as before. This is still not a full VT parser (no cell grid, no
// state), but it's dramatically more faithful for the token-extraction
// purpose — and passes the 2026-04-21 worker-2 regression case.

const ESC = '\\x1b';
const BEL = '\\x07';

const DCS_APC_PM_SOS_RE = new RegExp(`${ESC}[PX\\]^_][\\s\\S]*?(?:${BEL}|${ESC}\\\\)`, 'g');
const OSC_RE = new RegExp(`${ESC}\\][\\s\\S]*?(?:${BEL}|${ESC}\\\\)`, 'g');
const CSI_RE = new RegExp(`${ESC}\\[[0-?]*[ -/]*[@-~]`, 'g');
const TWO_BYTE_ESC_RE = new RegExp(`${ESC}[\\(\\)*+][A-Za-z0-9@]`, 'g');
const SOLO_ESC_RE = new RegExp(`${ESC}[=><78DEHMNOZc]`, 'g');
const NAKED_ESC_RE = new RegExp(ESC, 'g');
// C0 controls minus TAB (0x09), LF (0x0A), CR (0x0D).
const DROP_CTRLS_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;

// Structural cursor-movement sequences (processed BEFORE the general CSI
// strip). Order matters: the more specific two-parameter forms must come
// before single-parameter forms.
const CUP_FULL_RE = new RegExp(`${ESC}\\[(\\d+);(\\d+)H`, 'g'); // ESC[r;cH
const CUP_ROW_RE = new RegExp(`${ESC}\\[(\\d+)H`, 'g');         // ESC[rH
const CUP_HOME_RE = new RegExp(`${ESC}\\[H`, 'g');              // ESC[H
const CURSOR_DOWN_RE = new RegExp(`${ESC}\\[(\\d*)B`, 'g');     // ESC[nB
const CURSOR_NEXTLINE_RE = new RegExp(`${ESC}\\[(\\d*)E`, 'g'); // ESC[nE
const CURSOR_FORWARD_RE = new RegExp(`${ESC}\\[(\\d*)C`, 'g');  // ESC[nC
// Safety cap — a runaway `ESC[9999C` shouldn't balloon the buffer.
const MAX_CURSOR_FORWARD_SPACES = 200;

export function stripAnsi(input: string): string {
  if (!input) return '';
  return input
    // DCS/APC/OSC must go first because their payloads can contain bytes that
    // look like CSI sequences.
    .replace(DCS_APC_PM_SOS_RE, '')
    .replace(OSC_RE, '')
    // Structural cursor-movement conversions.
    .replace(CUP_FULL_RE, '\n')
    .replace(CUP_ROW_RE, '\n')
    .replace(CUP_HOME_RE, '\n')
    .replace(CURSOR_DOWN_RE, '\n')
    .replace(CURSOR_NEXTLINE_RE, '\n')
    .replace(CURSOR_FORWARD_RE, (_, n) => {
      const count = Math.min(
        MAX_CURSOR_FORWARD_SPACES,
        Math.max(1, parseInt(n || '1', 10) || 1),
      );
      return ' '.repeat(count);
    })
    // Remaining (non-structural) CSI / ESC sequences.
    .replace(CSI_RE, '')
    .replace(TWO_BYTE_ESC_RE, '')
    .replace(SOLO_ESC_RE, '')
    .replace(NAKED_ESC_RE, '')
    .replace(DROP_CTRLS_RE, '');
}

/**
 * Normalize stripped output to logical lines. Preserves line boundaries
 * (split on \r?\n) and trims trailing whitespace from each line. Leading
 * whitespace is kept because Claude's UI indents prompt content inside its
 * box drawing and we sometimes want to match on that.
 */
export function stripAnsiLines(input: string): string[] {
  return stripAnsi(input)
    .split(/\r?\n/)
    .map((l) => l.replace(/[ \t]+$/g, ''));
}
