export type CcgProvider = 'codex' | 'gemini' | 'claude';

export interface CcgArtifact {
  /** Absolute filesystem path. */
  filePath: string;
  /** Basename (for display / sort fallback). */
  fileName: string;
  provider: CcgProvider;
  /** Parsed from `Created at:` frontmatter, or file mtime fallback. */
  createdAt: number;
  /** Epoch ms of file mtime, used for reconcile signature. */
  mtimeMs: number;
  /** Parsed `Exit code:` (0 = success). */
  exitCode: number | null;
  /** `Original task` section (user-visible question as Claude received it). */
  originalTask: string;
  /** `Final prompt` section — advisor-specific prompt Claude actually sent. */
  finalPrompt: string;
  /** `Raw output` section (code-fenced block content). */
  rawOutput: string;
  /**
   * Normalized key for pairing — first 160 chars of originalTask lowered, with
   * whitespace collapsed. Falls back to slug extracted from filename when the
   * Original task section is missing.
   */
  questionKey: string;
  /** Slug parsed from filename between provider prefix and trailing timestamp. */
  slug: string;
}

export interface CcgPair {
  /**
   * Stable ID for the pair — uses earliest createdAt + shortest questionKey so
   * the webview can re-select across re-scans.
   */
  id: string;
  questionKey: string;
  /** Earliest artifact timestamp — primary sort key in the list view. */
  createdAt: number;
  codex: CcgArtifact | null;
  gemini: CcgArtifact | null;
  /** Optional third-party synthesis artifact (future: `claude-*.md`). */
  claude: CcgArtifact | null;
  /** Short human-readable title (trimmed originalTask). */
  title: string;
}

export interface CcgSnapshot {
  pairs: CcgPair[];
  scannedAt: number;
  /** Root directory being watched — for display / debug. */
  root: string | null;
}
