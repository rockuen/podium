# CLI Launcher for Claude

Run [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code/overview) inside a rich Webview terminal tab — with status icons, session management, and productivity features.

## Features

### Terminal with Status Icons
- **Tab icon changes** based on CLI state: idle (gray), running (yellow), done (green), error (red)
- **Ambient glow** border effect matches the current state
- **Response timer** shows elapsed time while Claude is processing

### Session Management
- **Session save/restore** — sessions persist across IDE restarts
- **Resume Later** — close a session and resume it from the sidebar
- **Session grouping** — "Resume Later" and "Recent Sessions" groups in sidebar
- **Split view** — restore multi-panel layouts

### Context Usage Indicator
- **Toolbar progress bar** shows token usage at a glance
- Click to refresh via `/context` command
- Color changes based on usage: green → orange → red

### Input Panel
- **Rich input area** with Enter to send, Shift+Enter for newlines
- **Slash command autocomplete** — type `/` to see available commands
- **Task queue** — queue multiple prompts and run them sequentially
- **Custom buttons** — add your own shortcut buttons (configurable)
- **Input history** — Ctrl+Up/Down to navigate previous inputs

### Customization
- **7 background themes** — Default, Midnight, Ocean, Forest, Sunset, Aurora, Warm
- **Background particle effects** with state-based animations
- **Configurable font size and family**
- **In-extension Settings UI** — gear icon or right-click menu
- **Export/Import settings** — share your configuration as JSON

### Productivity
- **Ctrl+C smart copy** — copies selected text, sends interrupt when no selection
- **Image paste** — Ctrl+V to attach clipboard images
- **File path click** — click file paths to open in editor, `.md` in Obsidian, `.html` in browser
- **Search** — Ctrl+F to search terminal content
- **Conversation export** — save terminal content as markdown
- **Desktop notifications** — Windows toast / macOS notification on task completion

### i18n
- **English** and **Korean** — auto-detected from IDE language setting

## Requirements

- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code/overview) must be installed
- Node.js (for node-pty terminal backend)

## Installation

1. Install from Open VSX or download `.vsix` from [Releases](https://github.com/rockuen/cli-launcher-for-claude/releases)
2. Open command palette: `Ctrl+Shift+P` → `Open Claude Code`
3. Or use keyboard shortcut: `Ctrl+Shift+;` (`Cmd+Shift+;` on Mac)

## Settings

Access settings via the **gear icon** in the toolbar or **right-click → Settings**.

| Setting | Description | Default |
|---------|-------------|---------|
| `defaultTheme` | Background theme | `default` |
| `defaultFontSize` | Terminal font size (8-22) | `11` |
| `defaultFontFamily` | Terminal font family | `D2Coding, Consolas, monospace` |
| `soundEnabled` | Task completion sound | `true` |
| `particlesEnabled` | Background particle effects | `true` |
| `customButtons` | Input panel shortcut buttons | `[]` |
| `customSlashCommands` | Autocomplete slash commands | `[]` |

### Custom Buttons Example

```json
"claudeCodeLauncher.customButtons": [
  { "label": "WrapUp", "command": "/wrap-up" },
  { "label": "GitSync", "command": "/git-sync" }
]
```

### Custom Slash Commands Example

```json
"claudeCodeLauncher.customSlashCommands": [
  { "cmd": "/daily-note", "desc": "Create daily note" },
  { "cmd": "/code-review", "desc": "Run code review" }
]
```

### Share Settings

Use **Export** button in Settings to copy all settings as JSON, then share with teammates. They can paste and **Import** to apply.

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+Shift+;` | Open Claude Code |
| `Ctrl+C` | Copy selection / Send interrupt |
| `Ctrl+V` | Paste text / Paste image |
| `Ctrl+F` | Search terminal |
| `Ctrl+=` / `Ctrl+-` | Zoom in / out |
| `Ctrl+0` | Reset zoom |
| `Ctrl+Up/Down` | Input history |
| `Ctrl+Shift+Enter` | Toggle input panel |
| `Ctrl+?` | Keyboard shortcuts help |

## License

[MIT](LICENSE)
