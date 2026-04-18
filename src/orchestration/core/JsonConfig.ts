import * as fs from 'fs';
import * as path from 'path';

export interface ReadResult<T> {
  value: T | null;
  /** Non-fatal recoveries applied (e.g., "stripped JSONC comments"). */
  warnings: string[];
  /** Fatal parse error message if value is null and file exists + non-empty. */
  error: string | null;
}

/**
 * Read a config file as JSON, tolerating JSONC (line + block comments, trailing
 * commas) that Claude Code / VSCode ecosystem configs routinely contain. Pure
 * in-house stripping — no `jsonc-parser` dependency to keep the extension
 * bundle lean.
 *
 * Returns `value: null` when:
 *   - file does not exist,
 *   - file is empty,
 *   - or JSON.parse fails even after JSONC sanitisation (in which case
 *     `error` is populated).
 */
export function readJsonConfig<T = unknown>(filePath: string): ReadResult<T> {
  if (!fs.existsSync(filePath)) {
    return { value: null, warnings: [], error: null };
  }
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    return {
      value: null,
      warnings: [],
      error: `read failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return { value: null, warnings: [], error: null };
  }

  // First try strict JSON — cheapest path.
  try {
    return { value: JSON.parse(trimmed) as T, warnings: [], error: null };
  } catch {
    // fall through to lenient path
  }

  // Lenient path: strip comments + trailing commas, retry.
  const { stripped, touched } = sanitizeJsonc(trimmed);
  const warnings: string[] = [];
  if (touched) warnings.push('stripped JSONC comments/trailing commas');
  try {
    return { value: JSON.parse(stripped) as T, warnings, error: null };
  } catch (err) {
    return {
      value: null,
      warnings,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Write a JSON object atomically: serialize → write to temp sibling → rename
 * over the target. On Windows, `renameSync` over a file held open by another
 * process (Claude Code, OMC CLI) can fail with EPERM; in that case we fall
 * back to a direct `writeFileSync` and surface a warning — still better than
 * the old "writeFileSync mid-interrupt = 0 byte file" risk because at least
 * the tmp copy is the full content.
 */
export interface WriteResult {
  path: string;
  wrote: boolean;
  atomic: boolean;
  fallbackReason: string | null;
  tempPath: string | null;
  error: string | null;
}

export function writeJsonConfigAtomic(filePath: string, value: unknown): WriteResult {
  const body = JSON.stringify(value, null, 2) + '\n';
  const dir = path.dirname(filePath);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    return {
      path: filePath,
      wrote: false,
      atomic: false,
      fallbackReason: null,
      tempPath: null,
      error: `mkdir failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const tmpPath = path.join(
    dir,
    `.${path.basename(filePath)}.podium-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.tmp`,
  );
  try {
    fs.writeFileSync(tmpPath, body, 'utf8');
  } catch (err) {
    return {
      path: filePath,
      wrote: false,
      atomic: false,
      fallbackReason: null,
      tempPath: tmpPath,
      error: `tmp write failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  try {
    fs.renameSync(tmpPath, filePath);
    return {
      path: filePath,
      wrote: true,
      atomic: true,
      fallbackReason: null,
      tempPath: tmpPath,
      error: null,
    };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    const reasonDetail = code ?? (err instanceof Error ? err.message : String(err));
    // Fall back to direct write — still safer than no write at all.
    try {
      fs.writeFileSync(filePath, body, 'utf8');
      // Best-effort cleanup of tmp.
      try {
        fs.unlinkSync(tmpPath);
      } catch {
        /* ignore */
      }
      return {
        path: filePath,
        wrote: true,
        atomic: false,
        fallbackReason: `rename failed (${reasonDetail}); used direct write`,
        tempPath: tmpPath,
        error: null,
      };
    } catch (err2) {
      return {
        path: filePath,
        wrote: false,
        atomic: false,
        fallbackReason: null,
        tempPath: tmpPath,
        error: `rename + direct write both failed: ${err2 instanceof Error ? err2.message : String(err2)}`,
      };
    }
  }
}

/**
 * Best-effort JSONC normalizer. Removes `//` line comments and `/* ... * /`
 * block comments that sit OUTSIDE of string literals, then removes trailing
 * commas in objects and arrays. Pure regex-free state machine — ~30 LOC.
 */
export function sanitizeJsonc(input: string): { stripped: string; touched: boolean } {
  let out = '';
  let touched = false;
  let i = 0;
  const n = input.length;
  let inString = false;
  let stringQuote = '';
  let escape = false;

  while (i < n) {
    const c = input[i];
    if (inString) {
      out += c;
      if (escape) {
        escape = false;
      } else if (c === '\\') {
        escape = true;
      } else if (c === stringQuote) {
        inString = false;
        stringQuote = '';
      }
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      inString = true;
      stringQuote = c;
      out += c;
      i++;
      continue;
    }
    if (c === '/' && i + 1 < n) {
      const next = input[i + 1];
      if (next === '/') {
        touched = true;
        // line comment — skip until newline
        i += 2;
        while (i < n && input[i] !== '\n') i++;
        continue;
      }
      if (next === '*') {
        touched = true;
        // block comment — skip until */
        i += 2;
        while (i + 1 < n && !(input[i] === '*' && input[i + 1] === '/')) i++;
        i += 2;
        continue;
      }
    }
    out += c;
    i++;
  }

  // Trailing comma sweep outside strings — small second pass since we've
  // already eliminated comments. A minimal state machine: walk chars, when
  // we see `,` followed (ignoring whitespace) by `}` or `]`, drop the comma.
  const result: string[] = [];
  const src = out;
  inString = false;
  stringQuote = '';
  escape = false;
  for (let j = 0; j < src.length; j++) {
    const c = src[j];
    if (inString) {
      result.push(c);
      if (escape) escape = false;
      else if (c === '\\') escape = true;
      else if (c === stringQuote) {
        inString = false;
        stringQuote = '';
      }
      continue;
    }
    if (c === '"' || c === "'") {
      inString = true;
      stringQuote = c;
      result.push(c);
      continue;
    }
    if (c === ',') {
      let k = j + 1;
      while (k < src.length && /\s/.test(src[k])) k++;
      if (k < src.length && (src[k] === '}' || src[k] === ']')) {
        touched = true;
        continue; // drop the trailing comma
      }
    }
    result.push(c);
  }

  return { stripped: result.join(''), touched };
}
