import * as vscode from 'vscode';
import type { IPty } from 'node-pty';

export interface ActiveTerminal {
  readonly id: string;
  readonly title: string;
  readonly pty: IPty;
  readonly panel: vscode.WebviewPanel;
}

interface TrackedTerminal {
  entry: ActiveTerminal;
  disposeListener: vscode.Disposable;
}

export class PodiumManager implements vscode.Disposable {
  private readonly terminals = new Map<string, TrackedTerminal>();

  register(entry: ActiveTerminal): void {
    // Keep the returned Disposable so manager.dispose() can detach the
    // listener explicitly rather than relying on the panel's dispose
    // chain alone. Closes a potential leak where a future caller might
    // re-register the same id or swap panels without the listener ever
    // being unhooked.
    const disposeListener = entry.panel.onDidDispose(() => {
      this.terminals.delete(entry.id);
      try {
        entry.pty.kill();
      } catch {
        // process may already be dead
      }
    });
    this.terminals.set(entry.id, { entry, disposeListener });
  }

  findByTitle(title: string): ActiveTerminal | undefined {
    for (const t of this.terminals.values()) {
      if (t.entry.title === title) return t.entry;
    }
    return undefined;
  }

  list(): ActiveTerminal[] {
    return Array.from(this.terminals.values()).map((t) => t.entry);
  }

  dispose(): void {
    for (const t of this.terminals.values()) {
      try {
        t.disposeListener.dispose();
      } catch {
        // ignore
      }
      try {
        t.entry.pty.kill();
      } catch {
        // ignore
      }
      try {
        t.entry.panel.dispose();
      } catch {
        // ignore
      }
    }
    this.terminals.clear();
  }
}
