// @module panel/webviewStyles — CSS rules as a tagged template.
// Phase 3b: extracted from webviewContent.js. Contains ${} interpolation for theme colors.
// v2.6.0 plan: convert to real static CSS file with custom properties.

function getStyles(ctx) {
  const { isDark, outerBg, bg, fg, cursor, border, scrollThumb,
          scrollTrack, toolbarBg, toolbarBorder, btnBg, btnHover,
          statusGreen, statusOrange, statusGray } = ctx;
  return `
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body {
      width: 100%; height: 100%; overflow: hidden;
      background: ${outerBg};
      display: flex; align-items: center; justify-content: center;
    }
    @keyframes entrance-slide {
      from {
        opacity: 0;
        transform: translateY(12px) scale(0.98);
      }
      to {
        opacity: 1;
        transform: translateY(0) scale(1);
      }
    }
    @keyframes glow-pulse {
      0%   { box-shadow: 0 0 8px var(--glow-color), 0 4px 24px rgba(0,0,0,0.3); }
      50%  { box-shadow: 0 0 20px var(--glow-color), 0 4px 24px rgba(0,0,0,0.3); }
      100% { box-shadow: 0 0 8px var(--glow-color), 0 4px 24px rgba(0,0,0,0.3); }
    }
    @keyframes glow-fade-in {
      from { box-shadow: 0 4px 24px rgba(0,0,0,0.3); }
      to   { box-shadow: 0 0 12px var(--glow-color), 0 4px 24px rgba(0,0,0,0.3); }
    }
    @keyframes glow-error {
      0%   { box-shadow: 0 0 6px var(--glow-color), 0 4px 24px rgba(0,0,0,0.3); }
      30%  { box-shadow: 0 0 25px var(--glow-color), 0 4px 24px rgba(0,0,0,0.3); }
      100% { box-shadow: 0 0 10px var(--glow-color), 0 4px 24px rgba(0,0,0,0.3); }
    }
    #terminal-wrapper {
      width: calc(100% - 24px);
      height: calc(100% - 24px);
      background: ${bg};
      border-radius: 10px;
      border: 1px solid ${border};
      overflow: hidden;
      box-shadow: ${isDark ? '0 4px 24px rgba(0,0,0,0.4)' : '0 4px 24px rgba(0,0,0,0.08)'};
      display: flex;
      flex-direction: column;
      position: relative;
      --glow-color: transparent;
      transition: border-color 0.5s;
      animation: entrance-slide 0.4s cubic-bezier(0.16, 1, 0.3, 1) both;
    }
    #terminal-wrapper.glow-running {
      --glow-color: rgba(232, 163, 23, 0.5);
      border-color: rgba(232, 163, 23, 0.4);
      animation: glow-pulse 2s ease-in-out infinite;
    }
    #terminal-wrapper.glow-done, #terminal-wrapper.glow-needs-attention {
      --glow-color: rgba(76, 175, 80, 0.5);
      border-color: rgba(76, 175, 80, 0.4);
      animation: glow-fade-in 0.5s ease forwards;
    }
    #terminal-wrapper.glow-error {
      --glow-color: rgba(244, 67, 54, 0.6);
      border-color: rgba(244, 67, 54, 0.4);
      animation: glow-error 0.8s ease;
    }
    #terminal-wrapper.glow-waiting {
      --glow-color: transparent;
      border-color: ${border};
      animation: none;
    }

    /* Particle canvas */
    #particle-canvas {
      position: absolute;
      top: 0; left: 0;
      width: 100%; height: 100%;
      pointer-events: none;
      z-index: 0;
      opacity: 0.5;
    }
    #toolbar, #search-bar, #terminal, #input-panel, #restart-bar {
      position: relative;
      z-index: 1;
    }

    /* Toolbar */
    #toolbar {
      display: flex;
      align-items: center;
      height: 36px;
      padding: 0 12px;
      background: ${toolbarBg};
      border-bottom: 1px solid ${toolbarBorder};
      flex-shrink: 0;
      gap: 8px;
      user-select: none;
    }
    #status-dot {
      width: 8px; height: 8px;
      border-radius: 50%;
      background: ${statusGray};
      flex-shrink: 0;
    }
    #toolbar-title {
      font-size: 12px;
      color: ${fg};
      font-family: -apple-system, "Segoe UI", sans-serif;
      flex: 1;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      cursor: pointer;
    }
    #toolbar-title:hover { text-decoration: underline; }
    #toolbar-status {
      font-size: 11px;
      color: ${statusGray};
      font-family: -apple-system, "Segoe UI", sans-serif;
      flex-shrink: 0;
    }
    .toolbar-btn {
      height: 24px;
      padding: 0 8px;
      border: none;
      border-radius: 4px;
      background: ${btnBg};
      color: ${fg};
      font-size: 11px;
      font-family: -apple-system, "Segoe UI", sans-serif;
      cursor: pointer;
      flex-shrink: 0;
    }
    .toolbar-btn:hover { background: ${btnHover}; }
    #toolbar-memo:hover { color: ${fg}; text-decoration: underline; }
    .toolbar-btn.new-tab { font-size: 14px; padding: 0 6px; }

    /* Theme picker */
    #theme-picker {
      display: none;
      position: absolute;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      z-index: 280;
      background: ${isDark ? '#2d2d2d' : '#ffffff'};
      border: 1px solid ${border};
      border-radius: 10px;
      box-shadow: 0 8px 32px rgba(0,0,0,${isDark ? '0.5' : '0.2'});
      padding: 16px;
      width: 280px;
    }
    #theme-picker h4 {
      font-size: 12px;
      color: ${fg};
      font-family: -apple-system, "Segoe UI", sans-serif;
      margin-bottom: 10px;
      text-align: center;
    }
    .theme-item {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 6px 8px;
      border-radius: 6px;
      cursor: pointer;
      font-size: 12px;
      color: ${fg};
      font-family: -apple-system, "Segoe UI", sans-serif;
    }
    .theme-item:hover { background: ${isDark ? '#094771' : '#e8e8e8'}; }
    .theme-preview {
      width: 36px;
      height: 20px;
      border-radius: 4px;
      border: 1px solid ${border};
      flex-shrink: 0;
    }

    /* Settings modal */
    #settings-modal {
      display: none;
      position: absolute;
      top: 50%; left: 50%;
      transform: translate(-50%, -50%);
      z-index: 300;
      background: ${isDark ? '#2d2d2d' : '#ffffff'};
      border: 1px solid ${border};
      border-radius: 10px;
      box-shadow: 0 8px 32px rgba(0,0,0,${isDark ? '0.5' : '0.2'});
      padding: 20px;
      width: 320px;
      max-height: 80vh;
      overflow-y: auto;
      font-family: -apple-system, "Segoe UI", sans-serif;
      color: ${fg};
    }
    #settings-modal h4 {
      font-size: 13px;
      margin: 0 0 14px;
      text-align: center;
    }
    .settings-group {
      margin-bottom: 14px;
    }
    .settings-label {
      font-size: 11px;
      color: ${statusGray};
      margin-bottom: 4px;
      display: block;
    }
    .settings-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 10px;
    }
    .settings-row label {
      font-size: 12px;
    }
    .settings-select, .settings-input {
      height: 28px;
      padding: 0 8px;
      border: 1px solid ${border};
      border-radius: 4px;
      background: ${isDark ? '#1e1e1e' : '#f5f5f5'};
      color: ${fg};
      font-size: 11px;
      font-family: -apple-system, "Segoe UI", sans-serif;
      outline: none;
    }
    .settings-select:focus, .settings-input:focus {
      border-color: #D97757;
    }
    .settings-toggle {
      position: relative;
      width: 36px; height: 18px;
      border-radius: 9px;
      background: ${isDark ? '#555' : '#ccc'};
      cursor: pointer;
      flex-shrink: 0;
      transition: background 0.2s;
    }
    .settings-toggle.on {
      background: #4caf50;
    }
    .settings-toggle::after {
      content: '';
      position: absolute;
      top: 2px; left: 2px;
      width: 14px; height: 14px;
      border-radius: 50%;
      background: #fff;
      transition: transform 0.2s;
    }
    .settings-toggle.on::after {
      transform: translateX(18px);
    }
    .settings-close-btn {
      display: block;
      width: 100%;
      height: 30px;
      margin-top: 8px;
      border: 1px solid ${border};
      border-radius: 6px;
      background: transparent;
      color: ${fg};
      font-size: 12px;
      cursor: pointer;
      font-family: -apple-system, "Segoe UI", sans-serif;
    }
    .settings-close-btn:hover { background: ${btnHover}; }
    .set-item {
      display: flex; align-items: center; gap: 4px;
      padding: 3px 6px; margin-bottom: 3px;
      border-radius: 4px; background: ${isDark ? '#1e1e1e' : '#f5f5f5'};
      font-size: 10px;
    }
    .set-item span { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .set-item-del {
      cursor: pointer; color: #f44336; font-size: 12px; flex-shrink: 0;
      opacity: 0.6; padding: 0 2px;
    }
    .set-item-del:hover { opacity: 1; }
    #settings-modal details summary { user-select: none; }
    #settings-modal details summary:hover { color: #D97757; }

    /* Drop overlay */
    #drop-overlay {
      display: none;
      position: absolute;
      inset: 0;
      background: ${isDark ? 'rgba(76,175,80,0.15)' : 'rgba(76,175,80,0.1)'};
      border: 2px dashed #4caf50;
      border-radius: 10px;
      z-index: 100;
      align-items: center;
      justify-content: center;
      pointer-events: none;
    }
    #drop-overlay span {
      font-size: 16px;
      color: #4caf50;
      font-family: -apple-system, "Segoe UI", sans-serif;
      font-weight: 600;
      background: ${isDark ? 'rgba(0,0,0,0.6)' : 'rgba(255,255,255,0.8)'};
      padding: 8px 20px;
      border-radius: 8px;
    }

    /* Terminal */
    #terminal {
      flex: 1;
      padding: 12px 14px;
      overflow: hidden;
    }
    .xterm { padding: 0; }
    .xterm-viewport::-webkit-scrollbar { width: 8px; }
    .xterm-viewport::-webkit-scrollbar-track { background: ${scrollTrack}; border-radius: 4px; }
    .xterm-viewport::-webkit-scrollbar-thumb { background: ${scrollThumb}; border-radius: 4px; }
    .xterm-viewport::-webkit-scrollbar-thumb:hover { background: ${isDark ? '#777' : '#999'}; }

    /* Search bar */
    #search-bar {
      display: none;
      align-items: center;
      height: 34px;
      padding: 0 12px;
      background: ${toolbarBg};
      border-bottom: 1px solid ${toolbarBorder};
      flex-shrink: 0;
      gap: 6px;
    }
    #search-bar input {
      flex: 1;
      height: 24px;
      padding: 0 8px;
      border: 1px solid ${border};
      border-radius: 4px;
      background: ${bg};
      color: ${fg};
      font-size: 12px;
      font-family: -apple-system, "Segoe UI", sans-serif;
      outline: none;
    }
    #search-bar input:focus { border-color: #007acc; }
    #search-bar .search-btn {
      height: 24px;
      padding: 0 6px;
      border: none;
      border-radius: 4px;
      background: ${btnBg};
      color: ${fg};
      font-size: 12px;
      cursor: pointer;
    }
    #search-bar .search-btn:hover { background: ${btnHover}; }
    #search-count {
      font-size: 11px;
      color: ${statusGray};
      font-family: -apple-system, "Segoe UI", sans-serif;
      min-width: 20px;
    }

    /* Context menu */
    #context-menu {
      display: none;
      position: fixed;
      z-index: 300;
      min-width: 160px;
      background: ${isDark ? '#2d2d2d' : '#ffffff'};
      border: 1px solid ${border};
      border-radius: 6px;
      box-shadow: 0 6px 20px rgba(0,0,0,${isDark ? '0.5' : '0.15'});
      padding: 4px 0;
      font-family: -apple-system, "Segoe UI", sans-serif;
      font-size: 12px;
    }
    .ctx-item {
      padding: 6px 14px;
      color: ${fg};
      cursor: pointer;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .ctx-item:hover { background: ${isDark ? '#094771' : '#e8e8e8'}; }
    .ctx-item .shortcut {
      font-size: 10px;
      color: ${statusGray};
      margin-left: 24px;
    }
    .ctx-sep {
      height: 1px;
      background: ${border};
      margin: 4px 0;
    }

    /* Restart bar */
    #restart-bar {
      display: none;
      align-items: center;
      justify-content: center;
      gap: 12px;
      padding: 10px;
      background: ${isDark ? '#1a1a2e' : '#fff3e0'};
      border-top: 1px solid ${border};
      position: absolute;
      bottom: 0;
      left: 0;
      right: 0;
      z-index: 130;
    }
    #restart-bar span {
      font-size: 12px;
      color: ${fg};
      font-family: -apple-system, "Segoe UI", sans-serif;
    }
    #restart-bar button {
      height: 28px;
      padding: 0 14px;
      border: none;
      border-radius: 4px;
      background: #4caf50;
      color: #fff;
      font-size: 12px;
      font-family: -apple-system, "Segoe UI", sans-serif;
      cursor: pointer;
      font-weight: 600;
    }
    #restart-bar button:hover { background: #43a047; }

    /* Scroll to bottom FAB */
    #scroll-fab {
      display: none;
      position: absolute;
      bottom: 24px;
      right: 24px;
      width: 36px;
      height: 36px;
      border-radius: 50%;
      background: ${isDark ? '#333' : '#e0e0e0'};
      color: ${fg};
      border: 1px solid ${border};
      box-shadow: 0 2px 8px rgba(0,0,0,${isDark ? '0.4' : '0.15'});
      cursor: pointer;
      z-index: 150;
      align-items: center;
      justify-content: center;
      font-size: 16px;
      transition: opacity 0.2s, transform 0.2s;
    }
    #scroll-fab:hover {
      background: ${isDark ? '#444' : '#d0d0d0'};
      transform: scale(1.1);
    }

    /* Input panel (bottom) - Claude theme */
    #input-panel {
      display: block;
      flex-shrink: 0;
      border-top: 1px solid ${isDark ? '#D97757' : '#C96442'};
      background: ${isDark ? '#2a2220' : '#faf5f0'};
      position: relative;
    }
    #editor-textarea {
      display: block;
      width: 100%;
      height: 36px;
      min-height: 36px;
      max-height: 200px;
      padding: 8px 12px;
      border: 1px solid transparent;
      outline: none;
      resize: none;
      overflow: hidden;
      background: ${isDark ? '#1e1a18' : '#ffffff'};
      color: ${fg};
      font-size: 12px;
      font-family: "D2Coding", "D2Coding ligature", Consolas, monospace;
      line-height: 1.5;
      border-radius: 4px;
      transition: border-color 0.3s, box-shadow 0.3s;
    }
    #editor-textarea.typing {
      border-color: ${isDark ? '#D97757' : '#C96442'};
      box-shadow: 0 0 8px ${isDark ? 'rgba(217,119,87,0.3)' : 'rgba(201,100,66,0.2)'};
    }
    #editor-textarea.typing-intense {
      border-color: ${isDark ? '#E8956A' : '#D97757'};
      box-shadow: 0 0 14px ${isDark ? 'rgba(217,119,87,0.5)' : 'rgba(201,100,66,0.35)'};
    }
    #editor-textarea.send-flash {
      animation: sendFlash 0.4s ease;
    }
    @keyframes sendFlash {
      0% { box-shadow: 0 0 0 rgba(217,119,87,0); border-color: transparent; }
      30% { box-shadow: 0 0 20px ${isDark ? 'rgba(217,119,87,0.7)' : 'rgba(201,100,66,0.5)'}; border-color: ${isDark ? '#E8956A' : '#D97757'}; }
      100% { box-shadow: 0 0 0 rgba(217,119,87,0); border-color: transparent; }
    }
    #editor-textarea::placeholder {
      color: ${isDark ? '#8a7060' : '#b8a090'};
    }
    #typing-ripple {
      position: absolute;
      top: 0; left: 0; right: 0; bottom: 0;
      pointer-events: none;
      overflow: hidden;
      border-radius: 4px;
    }
    .ripple-dot {
      position: absolute;
      width: 4px; height: 4px;
      border-radius: 50%;
      background: ${isDark ? '#D97757' : '#C96442'};
      opacity: 0.8;
      animation: rippleFade 0.6s ease forwards;
    }
    @keyframes rippleFade {
      0% { transform: scale(1); opacity: 0.8; }
      100% { transform: scale(3); opacity: 0; }
    }
    #input-panel-footer {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 4px 10px;
      height: 32px !important;
      flex-shrink: 0;
      flex-wrap: nowrap;
      overflow: hidden;
    }
    #input-panel-footer .input-hint {
      font-size: 10px;
      color: ${isDark ? '#8a7060' : '#b8a090'};
      font-family: -apple-system, "Segoe UI", sans-serif;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    /* Slash command dropdown */
    #slash-menu {
      display: none;
      position: absolute;
      bottom: 100%;
      left: 0;
      right: 0;
      max-height: 200px;
      overflow-y: auto;
      background: ${isDark ? '#2a2220' : '#faf5f0'};
      border: 1px solid ${isDark ? '#D97757' : '#C96442'};
      border-bottom: none;
      box-shadow: 0 -4px 12px rgba(0,0,0,${isDark ? '0.4' : '0.15'});
      z-index: 300;
    }
    .slash-item {
      padding: 6px 12px;
      cursor: pointer;
      font-size: 12px;
      font-family: -apple-system, "Segoe UI", sans-serif;
      display: flex;
      justify-content: space-between;
      align-items: center;
      color: ${fg};
    }
    .slash-item:hover, .slash-item.active {
      background: ${isDark ? '#3a2a22' : '#f0e0d0'};
    }
    .slash-item .slash-cmd {
      font-family: monospace;
      color: #D97757;
    }
    .slash-item .slash-desc {
      font-size: 10px;
      color: ${statusGray};
      margin-left: 12px;
    }

    /* Queue */
    #queue-list {
      display: none;
      padding: 4px 10px;
      max-height: 120px;
      overflow-y: auto;
      border-bottom: 1px solid ${isDark ? '#3a2a22' : '#e8d8c8'};
    }
    .queue-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 3px 8px;
      margin: 2px 0;
      background: ${isDark ? '#1e1a18' : '#fff'};
      border: 1px solid ${isDark ? '#3a2a22' : '#e0d0c0'};
      border-radius: 4px;
      font-size: 11px;
      color: ${fg};
      font-family: -apple-system, "Segoe UI", sans-serif;
    }
    .queue-item .qi-num {
      color: #D97757;
      font-weight: 600;
      margin-right: 6px;
      flex-shrink: 0;
    }
    .queue-item .qi-text {
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .queue-item .qi-del {
      cursor: pointer;
      color: ${statusGray};
      margin-left: 6px;
      flex-shrink: 0;
    }
    .queue-item .qi-del:hover { color: #f44336; }
    .queue-item.active {
      border-color: #D97757;
      background: ${isDark ? '#2a2018' : '#fef0e0'};
    }
    #queue-status {
      font-size: 10px;
      color: #D97757;
      font-family: -apple-system, "Segoe UI", sans-serif;
      padding: 2px 10px;
      display: none;
    }

    #editor-send {
      height: 26px;
      padding: 0 14px;
      border: none;
      border-radius: 4px;
      font-size: 11px;
      font-family: -apple-system, "Segoe UI", sans-serif;
      cursor: pointer;
      background: #D97757;
      color: #fff;
      font-weight: 600;
    }
    #editor-send:hover { background: #C96442; }

    /* Shortcut overlay */
    #shortcut-overlay {
      display: none;
      position: absolute;
      inset: 0;
      z-index: 400;
      background: ${isDark ? 'rgba(0,0,0,0.7)' : 'rgba(0,0,0,0.4)'};
      align-items: center;
      justify-content: center;
    }
    #shortcut-box {
      background: ${isDark ? '#2d2d2d' : '#ffffff'};
      border: 1px solid ${border};
      border-radius: 12px;
      box-shadow: 0 8px 32px rgba(0,0,0,${isDark ? '0.6' : '0.2'});
      padding: 20px 28px;
      max-width: 420px;
      width: 90%;
      font-family: -apple-system, "Segoe UI", sans-serif;
    }
    #shortcut-box h3 {
      font-size: 14px;
      color: ${fg};
      margin-bottom: 12px;
      text-align: center;
    }
    .sc-row {
      display: flex;
      justify-content: space-between;
      padding: 4px 0;
      font-size: 12px;
      color: ${fg};
    }
    .sc-row .sc-key {
      font-family: monospace;
      background: ${btnBg};
      padding: 1px 6px;
      border-radius: 3px;
      font-size: 11px;
    }
    .sc-sep {
      height: 1px;
      background: ${border};
      margin: 6px 0;
    }
    #shortcut-box .sc-footer {
      text-align: center;
      font-size: 11px;
      color: ${statusGray};
      margin-top: 10px;
    }

    /* Fullscreen mode indicator */
    #fs-indicator {
      display: none;
      align-items: center;
      gap: 4px;
      font-size: 10px;
      font-family: -apple-system, "Segoe UI", sans-serif;
      color: #e8a317;
      border: 1px solid rgba(232,163,23,0.4);
      border-radius: 4px;
      padding: 2px 7px;
      height: 22px;
      background: ${isDark ? 'rgba(232,163,23,0.1)' : 'rgba(232,163,23,0.08)'};
      cursor: help;
      flex-shrink: 0;
      animation: fs-pulse 2s ease-in-out infinite;
    }
    @keyframes fs-pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.7; }
    }

    /* Toast notification */
    #paste-toast {
      display: none;
      position: fixed;
      bottom: 60px;
      left: 50%;
      transform: translateX(-50%);
      padding: 8px 18px;
      border-radius: 8px;
      font-size: 12px;
      font-family: -apple-system, "Segoe UI", sans-serif;
      background: ${isDark ? 'rgba(60,60,60,0.95)' : 'rgba(240,240,240,0.95)'};
      color: ${fg};
      border: 1px solid ${border};
      box-shadow: 0 4px 16px rgba(0,0,0,0.2);
      z-index: 200;
      transition: opacity 0.3s;
      pointer-events: none;
      white-space: nowrap;
    }
`;
}

module.exports = { getStyles };
