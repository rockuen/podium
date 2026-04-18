// src/orchestration/index.ts
//
// Podium 코어 이식을 위한 오케스트레이션 레이어 진입점.
// M0에서는 placeholder. M2에서 실제 구현(SessionDetector, OMCRuntime,
// HookReceiver 등)을 core/ 하위에 이식.

import * as vscode from "vscode";

export interface OrchestrationAPI {
  /** 현재 Podium Mode가 활성화되어 있는지 */
  isActive(): boolean;

  /** Podium Mode 진입 — 팀 오케스트레이션 UI 활성화 */
  enterPodiumMode(): Promise<void>;

  /** Podium Mode 종료 — 단일 세션 UX로 복귀 */
  exitPodiumMode(): Promise<void>;

  /** 팀 생성 (webview 플로우). M2에서 SpawnTeamPanel 이식 후 구현 */
  createTeam(): Promise<void>;

  /** 외부에서 감지된 omc-team-* 세션에 attach. M2에서 SessionDetector 연동 */
  attachTeam(teamId?: string): Promise<void>;

  /** 리소스 정리 (extension deactivate 시 호출) */
  dispose(): void;
}

class NoopOrchestration implements OrchestrationAPI {
  private _active = false;

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
    vscode.window.showInformationMessage(
      "Podium Mode activated (orchestration core: M2에서 실제 구현)"
    );
  }

  async exitPodiumMode(): Promise<void> {
    this._active = false;
    await vscode.commands.executeCommand(
      "setContext",
      "claudeCodeLauncher.podiumModeActive",
      false
    );
  }

  async createTeam(): Promise<void> {
    vscode.window.showInformationMessage(
      "New Team (TODO M2): will spawn OMC team via SpawnTeamPanel"
    );
  }

  async attachTeam(teamId?: string): Promise<void> {
    vscode.window.showInformationMessage(
      `Attach Team (TODO M2): ${teamId ?? "(auto-detect)"}`
    );
  }

  dispose(): void {
    /* no-op */
  }
}

export function activate(_ctx: vscode.ExtensionContext): OrchestrationAPI {
  // M2: SessionDetector, HookReceiver, OMCRuntime 초기화
  return new NoopOrchestration();
}
