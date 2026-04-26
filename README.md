> ## ⚠️ This project is no longer maintained
>
> **Podium has been frozen at v0.16.0** and will not receive further updates.
>
> Active development has returned to its predecessor:
> **[rockuen/cli-launcher-for-claude](https://github.com/rockuen/cli-launcher-for-claude)**.
>
> After working on Podium for a few weeks, we decided that **adding OMC
> (Oh-My-Claudecode) integration on top of `CLI launcher for claude` is a
> cleaner path than maintaining Podium as a separate product**. The launcher
> already provides everything Podium tried to be — session management, themes,
> rich terminal — and OMC features will land there instead.
>
> 👉 **Latest stable build:** [CLI launcher for claude releases](https://github.com/rockuen/cli-launcher-for-claude/releases)
>
> ---
>
> ### 🇰🇷 한국어
>
> Podium 프로젝트는 **v0.16.0 시점에서 동결**되었으며 더 이상 업데이트되지 않습니다.
>
> 개발은 원래의 모태인 **[CLI launcher for claude](https://github.com/rockuen/cli-launcher-for-claude)**
> 로 돌아갑니다. Podium에서 시도했던 멀티 에이전트 / OMC 기능들을
> **별도 제품이 아니라 CLI launcher for claude의 확장 기능으로 추가**하는 것이
> 더 좋은 방향이라고 판단했습니다. 런처 자체가 이미 충분한 베이스(세션 관리,
> 테마, 리치 터미널)를 갖추고 있어 OMC 기능을 그 위에 얹는 것이 자연스럽습니다.
>
> 👉 **최신 빌드:** [CLI launcher for claude releases](https://github.com/rockuen/cli-launcher-for-claude/releases)

---

<p align="center">
  <img src="icons/icon-128.png" alt="Podium" width="96" height="96"/>
</p>

<h1 align="center">Podium</h1>

<p align="center">
  <strong>Orchestrate multi-agent Claude teams from one stage — or run a single session in a rich Webview tab.</strong>
</p>

<p align="center">
  <em>A VSCode / Antigravity extension for <a href="https://docs.anthropic.com/en/docs/claude-code/overview">Claude Code CLI</a>.</em>
</p>

---

**Podium** lifts Claude Code from a single-terminal tool into a multi-agent stage. A **leader** agent coordinates **worker** agents through structured `@worker-N:` directives, tracks their idle state, captures transcripts, and summarizes the round back to the leader when the team dissolves. Snapshot-and-restore keeps multi-hour orchestration work across IDE restarts.

For solo runs, Podium still bundles everything you'd want from a rich CLI wrapper: status-aware tab icons, session save/restore with groups, seven themes, context usage bar, smart Ctrl+C copy/interrupt, image paste, file-path click, desktop notifications.

---

## 🎭 Orchestration Mode — "Podium" (the stage)

A leader and worker panes share one Webview multi-pane terminal, with the orchestrator watching each pane's output for directives.

- **Leader + worker panes** in a single multi-pane Webview terminal — each pane owns a native node-pty process directly; no external multiplexer required
- **Structured routing** — leader emits `@worker-1: task` and Podium auto-dispatches to the matching pane
- **Per-worker idle detection** — dispatches queue while the worker is busy, flush when it goes idle
- **Dynamic team shape** — add, remove, or rename workers at runtime via the Teams tree view context menu
- **Team snapshot / restore** — save a team's leader and worker session UUIDs to OneDrive; load it later with `--resume` on each pane
- **Dissolve with summary** — extract the last `●` bullet from each worker, inject a consolidated summary back into the leader (deterministic hybrid, with Haiku fallback)
- **Scrollback replay grace** — 15 s window after restore drops stale directives from Claude's Ink repaint
- **Task-tool block on leader** — `--disallowedTools Task` + Podium system prompt keeps the leader delegating externally rather than spawning subagents

## ⚡ Solo Mode — "Launcher" (single tab)

The original Claude Code experience, in a Webview tab.

- **Status icons on the tab** — idle / running / done / needs-attention / error
- **Ambient glow** border matching the current state, response timer while Claude is processing
- **Tab title blink** when the tab is `needs-attention` and unfocused
- **Session save / restore + groups** — close a session, resume it from the sidebar; organize with "Resume Later" / "Recent Sessions" groups
- **Context usage bar** — reads `ctx:XX%` from Claude's status line, color gradient green → orange → red
- **Rich input panel** — slash command autocomplete, task queue, custom buttons, input history (Ctrl+Up/Down)
- **7 themes** — Default / Midnight / Ocean / Forest / Sunset / Aurora / Warm, with state-driven particle effects
- **Productivity** — smart Ctrl+C (copy selection or send interrupt), image paste, file-path click to open in editor, terminal search, desktop notifications
- **i18n** — English / Korean auto-detected from IDE language

## Install

1. Install from **Open VSX** — search `rockuen.podium`, or drag-drop the `.vsix` from [Releases](https://github.com/rockuen/podium/releases) into VSCode / Antigravity
2. Install [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code/overview)

No external multiplexer (tmux / psmux) required — Podium spawns and manages each pane's pty natively inside the extension.

## Quick start

**Solo session** — `Ctrl+Shift+;` (`Cmd+Shift+;` on Mac) opens Claude Code in a Webview tab.

**Orchestrated team** — Command Palette → `Podium: Orchestrated Team (leader + 2 workers)`. A leader pane spawns with the Podium protocol; type a natural-language request and the leader automatically routes `@worker-N:` directives to the right worker panes.

**Resume a saved team** — Command Palette → `Podium: Open Saved Team...` picks from your last 10 snapshots and resumes each pane with its original session.

**Dissolve a team** — Command Palette → `Podium: Dissolve Team`. Podium extracts the last assistant bullet from each worker, injects a summary into the leader, and kills the worker panes.

## Settings

Gear icon in the toolbar or **right-click → Settings**. The `claudeCodeLauncher.*` prefix is retained for back-compat with legacy keybindings and user settings.

| Setting | Default | Purpose |
|---|---|---|
| `claudeCodeLauncher.defaultTheme` | `default` | Background theme (7 choices) |
| `claudeCodeLauncher.defaultFontSize` | `11` | Terminal font size (8–22) |
| `claudeCodeLauncher.defaultFontFamily` | `D2Coding, Consolas, monospace` | Terminal font family |
| `claudeCodeLauncher.soundEnabled` | `true` | Task completion sound |
| `claudeCodeLauncher.particlesEnabled` | `true` | Background particle effects |
| `claudeCodeLauncher.customButtons` | `[]` | Toolbar shortcut buttons |
| `claudeCodeLauncher.customSlashCommands` | `[]` | Autocomplete entries |

### Custom Buttons

```json
"claudeCodeLauncher.customButtons": [
  { "label": "WrapUp", "command": "/wrap-up" },
  { "label": "GitSync", "command": "/git-sync" }
]
```

### Custom Slash Commands

```json
"claudeCodeLauncher.customSlashCommands": [
  { "cmd": "/daily-note", "desc": "Create daily note" },
  { "cmd": "/code-review", "desc": "Run code review" }
]
```

### Share Settings

Use **Export** in the Settings panel to copy your full configuration as JSON, then **Import** on another machine.

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl+Shift+;` | Open Podium (solo Claude Code tab) |
| `Ctrl+C` | Copy selection / send interrupt if no selection |
| `Ctrl+V` | Paste text / attach clipboard image |
| `Ctrl+F` | Search terminal content |
| `Ctrl+=` / `Ctrl+-` / `Ctrl+0` | Zoom in / out / reset |
| `Ctrl+Up` / `Ctrl+Down` | Input history |
| `Ctrl+Shift+Enter` | Toggle input panel |
| `Ctrl+?` | Keyboard shortcuts help |

## History

Podium was rebranded from [`rockuen/cli-launcher-for-claude`](https://github.com/rockuen/cli-launcher-for-claude) (final release v2.7.33) on 2026-04-22 after the orchestration layer grew into the product's center of gravity. All prior v2.x history is preserved in this repository's `main` branch; the legacy repo is frozen at a v2.7.25 deprecation release.

## License

[MIT](LICENSE)
