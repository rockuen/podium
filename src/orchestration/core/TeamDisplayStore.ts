// src/orchestration/core/TeamDisplayStore.ts
//
// Display-name layer for Podium Team Conversation panels. OMC team names are
// 48-char ASCII slugs locked to a strict regex (mailbox + worker paths depend
// on that exact name). This module persists a per-team sidecar with a short,
// user-editable label plus the original prompt, so the Conversation panel can
// show something human-friendly while OMC keeps its slug.
//
// File layout:
//   <root>/.omc/state/team/<teamName>/display.json
//
// Writes are atomic: tmp → fsync → rename. If the file is missing or corrupt
// the caller falls back to the raw OMC team name — nothing in this layer is
// load-bearing for the team itself.

import * as fs from 'fs';
import * as path from 'path';

export interface TeamDisplay {
  displayName: string;
  initialPrompt: string;
  createdAt: number;
  renamedAt?: number;
}

const MAX_DISPLAY_CHARS = 40;

/**
 * Derive a short display label from the user's prompt.
 *
 * Rules:
 *   - Use the first non-empty line, trimmed, internal whitespace collapsed.
 *   - Unicode-aware: count / slice on code points so Korean and emoji don't
 *     get mid-surrogate chopped.
 *   - Cap at MAX_DISPLAY_CHARS; append "…" when we truncate.
 */
export function autoDisplayName(prompt: string): string {
  if (typeof prompt !== 'string' || prompt.length === 0) return '';
  const firstLine = prompt.split(/\r?\n/).find((l) => l.trim().length > 0) ?? prompt;
  const trimmed = firstLine.trim().replace(/\s+/g, ' ');
  if (trimmed.length === 0) return '';
  const codepoints = Array.from(trimmed);
  if (codepoints.length <= MAX_DISPLAY_CHARS) return trimmed;
  return codepoints.slice(0, MAX_DISPLAY_CHARS - 1).join('') + '…';
}

function displayFile(root: string, teamName: string): string {
  return path.join(root, '.omc', 'state', 'team', teamName, 'display.json');
}

/**
 * Atomically write the sidecar. Creates parent dirs if needed. Errors bubble.
 */
export function writeTeamDisplay(root: string, teamName: string, data: TeamDisplay): void {
  const target = displayFile(root, teamName);
  const dir = path.dirname(target);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${target}.tmp.${process.pid}.${Date.now()}`;
  const payload = JSON.stringify(data, null, 2) + '\n';
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeFileSync(fd, payload, 'utf8');
    try {
      fs.fsyncSync(fd);
    } catch {
      /* fsync on Windows / network fs can fail; rename is still safer than
         a plain writeFileSync */
    }
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, target);
}

export function readTeamDisplay(root: string, teamName: string): TeamDisplay | null {
  const target = displayFile(root, teamName);
  if (!fs.existsSync(target)) return null;
  try {
    const raw = fs.readFileSync(target, 'utf8');
    if (!raw.trim()) return null;
    const parsed = JSON.parse(raw) as Partial<TeamDisplay>;
    if (typeof parsed.displayName !== 'string') return null;
    if (typeof parsed.initialPrompt !== 'string') return null;
    if (typeof parsed.createdAt !== 'number') return null;
    const out: TeamDisplay = {
      displayName: parsed.displayName,
      initialPrompt: parsed.initialPrompt,
      createdAt: parsed.createdAt,
    };
    if (typeof parsed.renamedAt === 'number') out.renamedAt = parsed.renamedAt;
    return out;
  } catch {
    return null;
  }
}

export function updateTeamDisplay(
  root: string,
  teamName: string,
  patch: Partial<TeamDisplay>,
): TeamDisplay | null {
  const current = readTeamDisplay(root, teamName);
  if (!current) return null;
  const next: TeamDisplay = {
    ...current,
    ...patch,
    // Preserve non-nullable fields even if caller passed undefined.
    displayName: patch.displayName ?? current.displayName,
    initialPrompt: patch.initialPrompt ?? current.initialPrompt,
    createdAt: patch.createdAt ?? current.createdAt,
  };
  writeTeamDisplay(root, teamName, next);
  return next;
}

export function teamDisplayPath(root: string, teamName: string): string {
  return displayFile(root, teamName);
}
