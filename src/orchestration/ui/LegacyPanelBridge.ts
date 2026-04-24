// v0.3.1 · LegacyPanelBridge — now a hybrid host for Summon Team.
//
// Design evolution
// ----------------
// v0.3.1 shipped the first cut: every pane (leader + workers) was a
// standalone legacy `createPanel` webview. That gave every worker the full
// chat UI — toolbar, search, memo, send box — which was more than the
// orchestrator needed. Each worker also lived in its own VSCode tab in
// the right column, clutter-stacked rather than visually grouped.
//
// v0.3.3 refines: the LEADER keeps its full legacy chat UI (it's where
// the user types), but the WORKERS share a single `LiveMultiPanel` in
// the right column, stacked top-to-bottom. LiveMultiPanel uses a simpler
// xterm renderer with no send-box chrome — exactly the display-only look
// the user asked for. The bridge multiplexes both sources into a single
// `OrchestratorPanel` surface so PodiumOrchestrator stays unchanged.
//
// Routing rules
// -------------
//   paneId === `leaderPaneId` → legacy `leaderEntry` (createPanel webview)
//   otherwise                 → `workerPanel` (LiveMultiPanel)
//
// The bridge forwards pty data from both, exits from both, and fires
// `onDidDispose` exactly once when the LEADER pane closes — matching the
// original `LiveMultiPanel.onDidDispose` semantics that index.ts uses to
// tear down the orchestrator registry.

import * as vscode from 'vscode';
import type {
  OrchestratorPanel,
  LivePaneSpec,
  PaneDataEvent,
  PaneExitEvent,
  LiveMultiPanel,
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

export class LegacyPanelBridge implements OrchestratorPanel {
  private readonly paneDataEmitter = new vscode.EventEmitter<PaneDataEvent>();
  private readonly paneExitEmitter = new vscode.EventEmitter<PaneExitEvent>();
  private readonly disposeEmitter = new vscode.EventEmitter<void>();

  public readonly onPaneData = this.paneDataEmitter.event;
  public readonly onPaneExit = this.paneExitEmitter.event;
  public readonly onDidDispose = this.disposeEmitter.event;

  private readonly subs: vscode.Disposable[] = [];
  private leaderDisposed = false;
  private workerPanelDisposed = false;
  /** Worker ids whose pane spec is known — lets us answer `hasPane` without racing the webview. */
  private readonly workerIds = new Set<string>();

  constructor(
    private readonly leaderPaneId: string,
    private readonly leaderEntry: LegacyPanelEntry,
    private readonly workerPanel: LiveMultiPanel,
    private readonly output: vscode.OutputChannel,
  ) {
    // Leader pty data → paneId="leader".
    this.subs.push(
      leaderEntry.onPtyData((data) => {
        this.paneDataEmitter.fire({ paneId: this.leaderPaneId, data });
      }),
    );
    // Leader dispose → emit paneExit, then disposeEmitter (team over).
    this.subs.push(
      leaderEntry.onPaneDispose((exitCode) => {
        this.paneExitEmitter.fire({ paneId: this.leaderPaneId, exitCode });
        if (!this.leaderDisposed) {
          this.leaderDisposed = true;
          this.disposeEmitter.fire();
        }
      }),
    );
    // Worker panel pane data → bubble verbatim.
    this.subs.push(
      workerPanel.onPaneData((e) => {
        this.paneDataEmitter.fire(e);
      }),
    );
    this.subs.push(
      workerPanel.onPaneExit((e) => {
        this.paneExitEmitter.fire(e);
      }),
    );
    // If user closes the WORKER panel (right column tab), the team's
    // worker set collapses. We keep the orchestrator attached — the leader
    // still works standalone — but mark the worker panel as gone so
    // subsequent writeToPane's on it become no-ops.
    this.subs.push(
      workerPanel.onDidDispose(() => {
        this.workerPanelDisposed = true;
        this.output.appendLine('[bridge] worker panel closed — leader remains active');
      }),
    );
    this.output.appendLine(
      `[bridge] constructed: leader="${leaderPaneId}" (session=${leaderEntry.sessionId.slice(0, 8)})`,
    );
  }

  /**
   * Register a worker's paneId so `hasPane` + dynamic addWorker lookups
   * succeed. The actual pane spawn is handled by `workerPanel.addPane(spec)`
   * — this method is the bridge's own ledger.
   */
  registerWorker(paneId: string): void {
    this.workerIds.add(paneId);
  }

  writeToPane(paneId: string, data: string): void {
    if (paneId === this.leaderPaneId) {
      if (!this.leaderEntry.pty) {
        this.output.appendLine('[bridge] writeToPane leader: no pty — dropped');
        return;
      }
      try {
        this.leaderEntry.pty.write(data);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.output.appendLine(`[bridge] writeToPane leader FAILED — ${msg}`);
      }
      return;
    }
    if (this.workerPanelDisposed) {
      this.output.appendLine(
        `[bridge] writeToPane "${paneId}": worker panel disposed — dropped (${data.length}b)`,
      );
      return;
    }
    if (!this.workerPanel.hasPane(paneId)) {
      this.output.appendLine(`[bridge] writeToPane "${paneId}": unknown pane — dropped`);
      return;
    }
    this.workerPanel.writeToPane(paneId, data);
  }

  hasPane(paneId: string): boolean {
    if (paneId === this.leaderPaneId) return !this.leaderDisposed;
    return this.workerPanel.hasPane(paneId);
  }

  removePane(paneId: string): void {
    if (paneId === this.leaderPaneId) {
      try {
        this.leaderEntry.panel.dispose();
      } catch {
        /* already gone */
      }
      return;
    }
    if (this.workerPanelDisposed) return;
    this.workerPanel.removePane(paneId);
    this.workerIds.delete(paneId);
  }

  addPane(spec: LivePaneSpec): void {
    if (spec.paneId === this.leaderPaneId) {
      this.output.appendLine(
        `[bridge] addPane: refusing to overlay leader "${this.leaderPaneId}"`,
      );
      return;
    }
    if (this.workerPanelDisposed) {
      this.output.appendLine(
        `[bridge] addPane "${spec.paneId}": worker panel disposed — ignored`,
      );
      return;
    }
    this.workerPanel.addPane(spec);
    this.workerIds.add(spec.paneId);
  }

  /** Diagnostic counter: live panes visible to the orchestrator. */
  get paneCount(): number {
    return (this.leaderDisposed ? 0 : 1) + (this.workerPanelDisposed ? 0 : this.workerIds.size);
  }

  get isLeaderDisposed(): boolean {
    return this.leaderDisposed;
  }

  dispose(): void {
    for (const s of this.subs) {
      try {
        s.dispose();
      } catch {
        /* ignore */
      }
    }
    this.subs.length = 0;
  }
}
