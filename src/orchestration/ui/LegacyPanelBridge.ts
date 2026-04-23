// v0.3.1 · LegacyPanelBridge — adapts N standalone `createPanel` webviews
// (the classic Claude Code chat UI) to the `OrchestratorPanel` contract.
//
// Why this exists
// ---------------
// Phase A shipped `LiveMultiPanel` — a custom multi-pane webview with its
// own xterm renderer. Phase B summoned a team by disposing the base chat
// window and spawning a `LiveMultiPanel` with leader + workers inside.
//
// v0.3.1 flips the model: keep the base chat UI (with all its polish —
// toolbar, memo, paste handling, search, theme) and simply open **more**
// chat windows in VSCode's native second column. The orchestrator doesn't
// care about rendering; it only needs a surface that fires pane data
// events and accepts pane writes. This bridge provides exactly that over
// existing legacy entries.
//
// Responsibilities
// ----------------
// 1. Per-pane bookkeeping: id → entry, with `attachEntry` on bind.
// 2. `onPaneData` / `onPaneExit` re-emitters sourced from each entry's
//    `onPtyData` / `onPaneDispose` taps (added to createPanel in v0.3.1).
// 3. `writeToPane` → `entry.pty.write(data)`.
// 4. `removePane` → `entry.panel.dispose()`.
// 5. `addPane` → calls the injected `spawnPane` factory so the caller
//    retains control of createPanel's full option surface (viewColumn,
//    title, role, etc.) without coupling this file to the legacy JS.
// 6. `onDidDispose` fires exactly once when the **leader** pane closes —
//    index.ts uses that to tear down the orchestrator registry, matching
//    `LiveMultiPanel`'s own `onDidDispose` semantics.

import * as vscode from 'vscode';
import type {
  OrchestratorPanel,
  LivePaneSpec,
  PaneDataEvent,
  PaneExitEvent,
} from './LiveMultiPanel';

/**
 * Shape of the object returned by the legacy `createPanel`. Declared as
 * structural so TypeScript doesn't need to import the JS module.
 */
export interface LegacyPanelEntry {
  panel: { dispose(): void; reveal?(column?: number, preserveFocus?: boolean): void };
  pty: { write(data: string): void } | undefined;
  title: string;
  cwd: string;
  sessionId: string;
  tabId: number;
  podiumRole?: string;
  podiumPaneId?: string;
  onPtyData: vscode.Event<string>;
  onPaneDispose: vscode.Event<number>;
}

/** Factory that spawns a fresh legacy panel on demand (for dynamic addPane). */
export type LegacyPanelSpawn = (spec: LivePaneSpec) => LegacyPanelEntry | null;

export class LegacyPanelBridge implements OrchestratorPanel {
  private readonly paneDataEmitter = new vscode.EventEmitter<PaneDataEvent>();
  private readonly paneExitEmitter = new vscode.EventEmitter<PaneExitEvent>();
  private readonly disposeEmitter = new vscode.EventEmitter<void>();

  public readonly onPaneData = this.paneDataEmitter.event;
  public readonly onPaneExit = this.paneExitEmitter.event;
  public readonly onDidDispose = this.disposeEmitter.event;

  private readonly entries = new Map<
    string,
    { entry: LegacyPanelEntry; subs: vscode.Disposable[] }
  >();
  private readonly leaderPaneId: string;
  private leaderDisposed = false;

  constructor(
    leaderPaneId: string,
    leaderEntry: LegacyPanelEntry,
    private readonly spawnPane: LegacyPanelSpawn,
    private readonly output: vscode.OutputChannel,
  ) {
    this.leaderPaneId = leaderPaneId;
    this.attachEntry(leaderPaneId, leaderEntry);
  }

  /**
   * Bind an already-spawned legacy panel entry under `paneId`. The caller
   * builds the entry via `createPanel(...)` and hands it over. We wire the
   * pty-data / dispose taps so the orchestrator sees this pane as part of
   * the team.
   */
  attachEntry(paneId: string, entry: LegacyPanelEntry): void {
    if (this.entries.has(paneId)) {
      this.output.appendLine(`[bridge] attachEntry: duplicate paneId "${paneId}" — ignored`);
      return;
    }
    const subs: vscode.Disposable[] = [];
    subs.push(
      entry.onPtyData((data) => {
        this.paneDataEmitter.fire({ paneId, data });
      }),
    );
    subs.push(
      entry.onPaneDispose((exitCode) => {
        this.paneExitEmitter.fire({ paneId, exitCode });
        // Cleanup this entry's subscriptions.
        for (const s of subs) {
          try {
            s.dispose();
          } catch {
            /* ignore */
          }
        }
        this.entries.delete(paneId);
        // Leader close = team over. Fire onDidDispose exactly once.
        if (paneId === this.leaderPaneId && !this.leaderDisposed) {
          this.leaderDisposed = true;
          this.disposeEmitter.fire();
        }
      }),
    );
    this.entries.set(paneId, { entry, subs });
    this.output.appendLine(
      `[bridge] attached pane "${paneId}" (session=${entry.sessionId.slice(0, 8)}, role=${entry.podiumRole ?? '-'})`,
    );
  }

  writeToPane(paneId: string, data: string): void {
    const hit = this.entries.get(paneId);
    if (!hit) {
      this.output.appendLine(`[bridge] writeToPane: unknown paneId "${paneId}" — dropped (${data.length}b)`);
      return;
    }
    if (!hit.entry.pty) {
      this.output.appendLine(`[bridge] writeToPane: pane "${paneId}" has no pty — dropped`);
      return;
    }
    try {
      hit.entry.pty.write(data);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.output.appendLine(`[bridge] writeToPane "${paneId}" FAILED — ${msg}`);
    }
  }

  hasPane(paneId: string): boolean {
    return this.entries.has(paneId);
  }

  removePane(paneId: string): void {
    const hit = this.entries.get(paneId);
    if (!hit) return;
    try {
      hit.entry.panel.dispose();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.output.appendLine(`[bridge] removePane "${paneId}" dispose FAILED — ${msg}`);
    }
    // `onPaneDispose` tap will clean up the Map and subs.
  }

  addPane(spec: LivePaneSpec): void {
    if (this.entries.has(spec.paneId)) {
      this.output.appendLine(
        `[bridge] addPane: "${spec.paneId}" already attached — ignored`,
      );
      return;
    }
    const entry = this.spawnPane(spec);
    if (!entry) {
      this.output.appendLine(`[bridge] addPane: spawn factory returned null for "${spec.paneId}"`);
      return;
    }
    this.attachEntry(spec.paneId, entry);
  }

  /**
   * Reveal (focus) one of the bridge's panes. Optional column lets callers
   * preserve the side-by-side layout across reveals.
   */
  reveal(paneId?: string, column?: number, preserveFocus?: boolean): void {
    const id = paneId ?? this.leaderPaneId;
    const hit = this.entries.get(id);
    if (!hit) return;
    try {
      hit.entry.panel.reveal?.(column, preserveFocus);
    } catch {
      /* ignore */
    }
  }

  /**
   * Summary for diagnostics — matches `LiveMultiPanel.isDisposed` /
   * `listPanes` surface closely enough for logging without locking in API.
   */
  get paneCount(): number {
    return this.entries.size;
  }

  get isLeaderDisposed(): boolean {
    return this.leaderDisposed;
  }
}
