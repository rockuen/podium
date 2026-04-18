// src/orchestration/index.ts
//
// Orchestration entry (M2.B.2) — replaces NoopOrchestration with a real
// composition of the Podium core modules.
//
// M0:   scaffold + Noop
// M1:   context key toggle + status bar entry point
// M2.A: podium types + backends + json/token utils
// M2.B.1: podium core modules copied (no wiring)
// M2.B.2: NoopOrchestration -> Orchestration (this file)
// M2.B.3: activation.js wires team.* / system.* commands to orch API
// M2.C+:  HookReceiver, mission/conversation/history watchers, UI panels

import * as vscode from "vscode";
import { OMCRuntime } from "./core/OMCRuntime";
import { SessionDetector } from "./core/SessionDetector";
import { PodiumManager } from "./core/PodiumManager";
import { ProviderHealthChecker } from "./core/ProviderHealthChecker";
import type { IMultiplexerBackend } from "./backends/IMultiplexerBackend";
import { TmuxBackend } from "./backends/TmuxBackend";
import { PsmuxBackend } from "./backends/PsmuxBackend";

export interface OrchestrationAPI {
  isActive(): boolean;
  enterPodiumMode(): Promise<void>;
  exitPodiumMode(): Promise<void>;
  createTeam(): Promise<void>;
  attachTeam(teamId?: string): Promise<void>;
  dispose(): void;
}

async function resolveBackend(
  choice: string,
  output: vscode.OutputChannel
): Promise<IMultiplexerBackend> {
  const psmux = new PsmuxBackend();
  const tmux = new TmuxBackend();

  if (choice === "psmux") return psmux;
  if (choice === "tmux") return tmux;

  // auto: platform default, with fallback if primary is unavailable
  const primary = process.platform === "win32" ? psmux : tmux;
  const fallback = process.platform === "win32" ? tmux : psmux;

  try {
    if (await primary.isAvailable()) {
      output.appendLine(
        `[orch] backend: ${primary.name} (auto on ${process.platform})`
      );
      return primary;
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    output.appendLine(`[orch] ${primary.name} isAvailable threw: ${msg}`);
  }
  try {
    if (await fallback.isAvailable()) {
      output.appendLine(
        `[orch] backend: ${fallback.name} (fallback — ${primary.name} unavailable)`
      );
      return fallback;
    }
  } catch {
    /* ignore, fall through */
  }
  output.appendLine(
    `[orch] backend: ${primary.name} (none available; commands will fail until installed)`
  );
  return primary;
}

class Orchestration implements OrchestrationAPI {
  private _active = false;
  private _output: vscode.OutputChannel;
  private _runtime: OMCRuntime;
  private _manager: PodiumManager;
  private _providerHealth: ProviderHealthChecker;
  private _backendPromise: Promise<IMultiplexerBackend>;
  private _detectorPromise: Promise<SessionDetector>;
  private _prefix: string;
  private _disposables: vscode.Disposable[] = [];

  constructor(
    output: vscode.OutputChannel,
    config: vscode.WorkspaceConfiguration
  ) {
    this._output = output;
    const claudeOverride = config.get<string>("claudeCommand", "") || undefined;
    const backendChoice = config.get<string>("backend", "auto");
    this._prefix = config.get<string>("sessionPrefix", "omc-team-");
    const filter = config.get<string>("sessionFilter", "") || "";

    this._runtime = new OMCRuntime(claudeOverride);
    this._manager = new PodiumManager();
    this._providerHealth = new ProviderHealthChecker((msg) =>
      this._output.appendLine(msg)
    );

    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath;
    if (cwd) this._providerHealth.setCwd(cwd);
    this._providerHealth.start();

    this._backendPromise = resolveBackend(backendChoice, output);
    this._detectorPromise = this._backendPromise.then((backend) => {
      const d = new SessionDetector(backend, this._prefix);
      if (filter) d.setNameFilter(filter);
      return d;
    });

    this._disposables.push(this._manager);
    this._disposables.push({ dispose: () => this._providerHealth.stop() });

    output.appendLine(
      `[orch] initialized (prefix=${this._prefix}, backend=${backendChoice})`
    );
  }

  isActive(): boolean {
    return this._active;
  }

  async enterPodiumMode(): Promise<void> {
    this._active = true;
    await vscode.commands.executeCommand(
      "setContext",
      "claudeCodeLauncher.podiumModeActive",
      true
    );
    try {
      const detector = await this._detectorPromise;
      const sessions = await detector.detect();
      await vscode.commands.executeCommand(
        "setContext",
        "claudeCodeLauncher.hasAnyTeam",
        sessions.length > 0
      );
      this._output.appendLine(
        `[orch] podium mode ENTER (${sessions.length} team(s) detected)`
      );
      vscode.window.showInformationMessage(
        sessions.length > 0
          ? `Podium Mode activated — ${sessions.length} team(s) detected.`
          : "Podium Mode activated — no teams found yet."
      );
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      this._output.appendLine(`[orch] detect error: ${msg}`);
      vscode.window.showWarningMessage(
        "Podium Mode activated but multiplexer backend unavailable. Install tmux or psmux."
      );
    }
  }

  async exitPodiumMode(): Promise<void> {
    this._active = false;
    await vscode.commands.executeCommand(
      "setContext",
      "claudeCodeLauncher.podiumModeActive",
      false
    );
    await vscode.commands.executeCommand(
      "setContext",
      "claudeCodeLauncher.hasAnyTeam",
      false
    );
    this._output.appendLine("[orch] podium mode EXIT");
  }

  async createTeam(): Promise<void> {
    vscode.window.showInformationMessage(
      "New Team: SpawnTeamPanel porting pending (M2.D)."
    );
  }

  async attachTeam(teamId?: string): Promise<void> {
    try {
      const detector = await this._detectorPromise;
      const sessions = await detector.detect();
      if (sessions.length === 0) {
        vscode.window.showInformationMessage(
          "No orchestration sessions detected yet."
        );
        return;
      }
      const target = teamId ?? sessions[0].session.name;
      vscode.window.showInformationMessage(
        `Attach Team "${target}" — TerminalPanel porting pending (M3).`
      );
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      vscode.window.showErrorMessage(`Attach failed: ${msg}`);
    }
  }

  dispose(): void {
    for (const d of this._disposables) {
      try {
        d.dispose();
      } catch {
        /* ignore */
      }
    }
    this._disposables = [];
  }
}

export function activate(ctx: vscode.ExtensionContext): OrchestrationAPI {
  const output = vscode.window.createOutputChannel(
    "Claude Launcher - Orchestration"
  );
  ctx.subscriptions.push(output);
  output.appendLine("[orch] activating...");

  const config = vscode.workspace.getConfiguration(
    "claudeCodeLauncher.orchestration"
  );
  return new Orchestration(output, config);
}
