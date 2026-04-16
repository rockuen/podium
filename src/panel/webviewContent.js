// @module panel/webviewContent — assembles the webview HTML string.
// Phase 3a: function moved from extension.js. Phase 3b: CSS extracted to webviewStyles.
// Phase 3c (planned): JS → media/client.js, full static HTML split.

const { getStyles } = require('./webviewStyles');
const { getClientScript } = require('./webviewClient');

function getWebviewContent(xtermCssUri, xtermJsUri, fitAddonUri, webLinksAddonUri, searchAddonUri, isDark, fontSize, title, memo, customButtons, T, settings, customSlashCommands) {
  const outerBg = isDark ? '#181818' : '#f0f0f0';
  const bg = isDark ? '#1e1e1e' : '#ffffff';
  const fg = isDark ? '#d4d4d4' : '#333333';
  const cursor = isDark ? '#aeafad' : '#333333';
  const border = isDark ? '#333' : '#ddd';
  const scrollThumb = isDark ? '#555' : '#bbb';
  const scrollTrack = isDark ? '#1e1e1e' : '#f5f5f5';
  const toolbarBg = isDark ? '#252526' : '#f8f8f8';
  const toolbarBorder = isDark ? '#3c3c3c' : '#e0e0e0';
  const btnBg = isDark ? '#333' : '#e8e8e8';
  const btnHover = isDark ? '#444' : '#d0d0d0';
  const statusGreen = '#4caf50';
  const statusOrange = '#e8a317';
  const statusGray = '#888';

  return `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${xtermCssUri}">
  <style>${getStyles({ isDark, outerBg, bg, fg, cursor, border, scrollThumb, scrollTrack, toolbarBg, toolbarBorder, btnBg, btnHover, statusGreen, statusOrange, statusGray })}</style>
</head>
<body>
  <div id="terminal-wrapper">
    <canvas id="particle-canvas"></canvas>
    <div id="toolbar">
      <div id="status-dot"></div>
      <span id="toolbar-title">${title.replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')}</span>
      <span id="toolbar-memo" title="${T.memoEditTip}" style="font-size:10px;color:${statusGray};font-family:-apple-system,'Segoe UI',sans-serif;cursor:pointer;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex-shrink:1;"></span>
      <span id="toolbar-status">${T.starting}</span>
      <span id="toolbar-timer" style="font-size:10px;color:${statusOrange};font-family:monospace;min-width:32px;display:none;"></span>
      <span id="context-indicator" title="${T.ctxUsageTip}" style="display:inline-flex;cursor:pointer;font-size:10px;font-family:-apple-system,'Segoe UI',sans-serif;flex-shrink:0;align-items:center;gap:5px;border:1px solid ${isDark ? '#555' : '#ccc'};border-radius:4px;padding:2px 7px;height:22px;background:${isDark ? '#2a2a2a' : '#f0f0f0'};">
        <span id="ctx-bar-wrap" style="display:inline-block;width:40px;height:5px;background:${isDark ? '#444' : '#ddd'};border-radius:3px;vertical-align:middle;overflow:hidden;">
          <span id="ctx-bar-fill" style="display:block;height:100%;width:0%;border-radius:3px;background:${statusGreen};transition:width 0.5s ease,background 0.3s;"></span>
        </span>
        <span id="ctx-label" style="vertical-align:middle;color:${isDark ? '#bbb' : '#666'};">ctx</span>
      </span>
      <span id="fs-indicator" title="${T.fsTip}">FS</span>
      <button class="toolbar-btn" id="btn-paste-img" title="${T.pasteImageTip}" style="display:none">&#x1F4CE;</button>
      <button class="toolbar-btn" id="btn-zoom-out" title="${T.zoomOutTip}" style="display:none">-</button>
      <span id="font-size-label" style="display:none">${fontSize}px</span>
      <button class="toolbar-btn" id="btn-zoom-in" title="${T.zoomInTip}" style="display:none">+</button>
      <button class="toolbar-btn" id="btn-export" title="${T.exportTip}">&#x1F4BE;</button>
      <button class="toolbar-btn" id="btn-sound" title="${T.soundToggleTip}" style="display:none">&#x1F514;</button>
      <button class="toolbar-btn" id="btn-settings" title="Settings" style="font-size:13px;">&#x2699;</button>
      <button class="toolbar-btn new-tab" id="btn-new" title="${T.newTabTip}">&#x2795;</button>
    </div>
    <div id="search-bar">
      <input type="text" id="search-input" placeholder="${T.searchPlaceholder}" />
      <span id="search-count"></span>
      <button class="search-btn" id="search-prev" title="${T.searchPrevTip}">&#x25B2;</button>
      <button class="search-btn" id="search-next" title="${T.searchNextTip}">&#x25BC;</button>
      <button class="search-btn" id="search-close" title="${T.searchCloseTip}">&#x2715;</button>
    </div>
    <div id="terminal"></div>
    <div id="restart-bar">
      <span id="restart-msg">${T.processExited}</span>
      <button id="restart-btn">&#x25B6; ${T.restartBtn}</button>
    </div>
    <div id="drop-overlay"><span>${T.dropFiles}</span></div>
    <div id="scroll-fab" title="${T.scrollBottomTip}">&#x25BC;</div>
    <div id="theme-picker">
      <h4>${T.themeTitle}</h4>
      <div class="theme-item" data-theme="default"><div class="theme-preview" style="background:${bg}"></div>${T.themeDefault}</div>
      <div class="theme-item" data-theme="midnight"><div class="theme-preview" style="background:#1c1740;border-color:#3a2d6b"></div>${T.themeMidnight}</div>
      <div class="theme-item" data-theme="ocean"><div class="theme-preview" style="background:#0c2240;border-color:#1a4070"></div>${T.themeOcean}</div>
      <div class="theme-item" data-theme="forest"><div class="theme-preview" style="background:#0e2810;border-color:#1a5020"></div>${T.themeForest}</div>
      <div class="theme-item" data-theme="sunset"><div class="theme-preview" style="background:#2a1510;border-color:#5a3020"></div>${T.themeSunset}</div>
      <div class="theme-item" data-theme="aurora"><div class="theme-preview" style="background:#160e2e;border-color:#3a2060"></div>${T.themeAurora}</div>
      <div class="theme-item" data-theme="warm"><div class="theme-preview" style="background:#241c10;border-color:#4a3818"></div>${T.themeWarm}</div>
    </div>
    <div id="settings-modal">
      <h4>&#x2699; Settings</h4>
      <div class="settings-row">
        <label>${T.themeTitle}</label>
        <select class="settings-select" id="set-theme">
          <option value="default">${T.themeDefault}</option>
          <option value="midnight">${T.themeMidnight}</option>
          <option value="ocean">${T.themeOcean}</option>
          <option value="forest">${T.themeForest}</option>
          <option value="sunset">${T.themeSunset}</option>
          <option value="aurora">${T.themeAurora}</option>
          <option value="warm">${T.themeWarm}</option>
        </select>
      </div>
      <div class="settings-row">
        <label>Font Size</label>
        <div style="display:flex;align-items:center;gap:6px;">
          <input type="range" id="set-fontsize" min="8" max="22" step="1" value="${fontSize}" style="width:80px;">
          <span id="set-fontsize-label" style="font-size:11px;min-width:30px;">${fontSize}px</span>
        </div>
      </div>
      <div class="settings-row">
        <label>Font Family</label>
        <input type="text" class="settings-input" id="set-fontfamily" value="${settings.fontFamily.replace(/"/g, '&quot;')}" style="width:160px;font-size:10px;">
      </div>
      <div class="settings-row">
        <label>${T.soundToggleTip}</label>
        <div class="settings-toggle ${settings.soundEnabled !== false ? 'on' : ''}" id="set-sound"></div>
      </div>
      <div class="settings-row">
        <label>${T.ctxParticlesOff.replace(/끄기|Off/i, '')}</label>
        <div class="settings-toggle ${settings.particlesEnabled !== false ? 'on' : ''}" id="set-particles"></div>
      </div>
      <div style="border-top:1px solid ${border};margin:12px 0 8px;"></div>
      <details>
        <summary style="font-size:12px;cursor:pointer;margin-bottom:8px;">Custom Buttons</summary>
        <div id="set-buttons-list" style="margin-bottom:6px;"></div>
        <div style="display:flex;gap:4px;">
          <input type="text" class="settings-input" id="set-btn-label" placeholder="Label" style="flex:1;font-size:10px;">
          <input type="text" class="settings-input" id="set-btn-cmd" placeholder="/command" style="flex:1;font-size:10px;">
          <button class="settings-close-btn" id="set-btn-add" style="width:28px;margin:0;height:28px;font-size:14px;padding:0;">+</button>
        </div>
      </details>
      <details>
        <summary style="font-size:12px;cursor:pointer;margin-bottom:8px;">Slash Commands</summary>
        <div id="set-slash-list" style="margin-bottom:6px;max-height:150px;overflow-y:auto;"></div>
        <div style="display:flex;gap:4px;">
          <input type="text" class="settings-input" id="set-slash-cmd" placeholder="/command" style="flex:1;font-size:10px;">
          <input type="text" class="settings-input" id="set-slash-desc" placeholder="Description" style="flex:1;font-size:10px;">
          <button class="settings-close-btn" id="set-slash-add" style="width:28px;margin:0;height:28px;font-size:14px;padding:0;">+</button>
        </div>
      </details>
      <details>
        <summary style="font-size:12px;cursor:pointer;margin-bottom:8px;">File Associations</summary>
        <div id="set-fileassoc-list" style="margin-bottom:6px;max-height:180px;overflow-y:auto;"></div>
        <div style="display:flex;gap:4px;">
          <input type="text" class="settings-input" id="set-fa-ext" placeholder=".csv" style="width:50px;font-size:10px;">
          <select class="settings-select" id="set-fa-method" style="flex:1;font-size:10px;height:28px;">
            <option value="excel">Excel</option>
            <option value="system">System Default</option>
            <option value="browser">Browser</option>
            <option value="obsidian">Obsidian</option>
            <option value="editor">IDE Editor</option>
            <option value="auto">Auto</option>
          </select>
          <button class="settings-close-btn" id="set-fa-add" style="width:28px;margin:0;height:28px;font-size:14px;padding:0;">+</button>
        </div>
      </details>
      <div style="display:flex;gap:6px;margin-top:10px;">
        <button class="settings-close-btn" id="settings-export" style="flex:1;border-color:#4caf50;color:#4caf50;">Export</button>
        <button class="settings-close-btn" id="settings-import" style="flex:1;border-color:#2196F3;color:#2196F3;">Import</button>
      </div>
      <button class="settings-close-btn" id="settings-close">Close</button>
    </div>
    <div id="input-panel">
      <div id="queue-list"></div>
      <div id="queue-status"></div>
      <div id="slash-menu"></div>
      <div style="position:relative">
        <textarea id="editor-textarea" placeholder="${T.inputPlaceholder}"></textarea>
        <div id="typing-ripple"></div>
      </div>
      <div id="input-panel-footer">
        <span class="input-hint">${T.inputHint}</span>
        <div style="display:flex;align-items:center;gap:6px;margin-left:auto;">
          <button id="queue-add" style="height:26px;padding:0 10px;border:1px solid #D97757;border-radius:4px;font-size:11px;font-family:-apple-system,'Segoe UI',sans-serif;cursor:pointer;background:transparent;color:#D97757;">${T.queueAdd}</button>
          <span id="queue-run" style="display:none"></span>
          ${(customButtons || []).map((b, i) => `<button class="custom-cmd-btn" data-cmd="${b.command.replace(/"/g, '&quot;')}" style="height:26px;padding:0 10px;border:1px solid ${isDark ? '#666' : '#bbb'};border-radius:4px;font-size:11px;font-family:-apple-system,'Segoe UI',sans-serif;cursor:pointer;background:transparent;color:${isDark ? '#aaa' : '#666'};" title="${b.command.replace(/"/g, '&quot;')}">${b.label.replace(/</g, '&lt;')}</button>`).join('\n          ')}
          <button id="editor-send">${T.send}</button>
        </div>
      </div>
    </div>
    <div id="shortcut-overlay">
      <div id="shortcut-box">
        <h3>${T.scTitle}</h3>
        <div class="sc-row"><span>${T.scSearch}</span><span class="sc-key">Ctrl+F</span></div>
        <div class="sc-row"><span>${T.scZoomIn}</span><span class="sc-key">Ctrl+=</span></div>
        <div class="sc-row"><span>${T.scZoomOut}</span><span class="sc-key">Ctrl+-</span></div>
        <div class="sc-row"><span>${T.scZoomReset}</span><span class="sc-key">Ctrl+0</span></div>
        <div class="sc-sep"></div>
        <div class="sc-row"><span>${T.scPasteImage}</span><span class="sc-key">Ctrl+V / &#x1F4CE;</span></div>
        <div class="sc-row"><span>${T.scOpenFile}</span><span>${T.ctxSelectedText} &#x2192; Right-click</span></div>
        <div class="sc-row"><span>${T.scHistory}</span><span class="sc-key">Ctrl+&#x2191;/&#x2193;</span></div>
        <div class="sc-row"><span>${T.scEditorToggle}</span><span class="sc-key">Ctrl+Shift+Enter</span></div>
        <div class="sc-sep"></div>
        <div class="sc-row"><span>${T.scHelp}</span><span class="sc-key">Ctrl+?</span></div>
        <div class="sc-sep"></div>
        <div class="sc-row"><span>${T.scContextMenu}</span><span>${T.scContextActions}</span></div>
        <div class="sc-footer">${T.scClose}</div>
      </div>
    </div>
    <div id="paste-toast"></div>
    <div id="context-menu">
      <div class="ctx-item" data-action="copy">${T.ctxCopy}<span class="shortcut">Ctrl+C</span></div>
      <div class="ctx-item" data-action="open-file">${T.ctxOpenFile}<span class="shortcut">${T.ctxSelectedText}</span></div>
      <div class="ctx-item" data-action="open-folder">${T.ctxOpenFolder}<span class="shortcut">${T.ctxSelectedText}</span></div>
      <div class="ctx-item" data-action="paste">${T.ctxPaste}<span class="shortcut">Ctrl+V</span></div>
      <div class="ctx-item" data-action="paste-image">${T.ctxPasteImage}<span class="shortcut">&#x1F4CE;</span></div>
      <div class="ctx-sep"></div>
      <div class="ctx-item" data-action="search">${T.ctxSearch}<span class="shortcut">Ctrl+F</span></div>
      <div class="ctx-item" data-action="clear">${T.ctxClear}<span class="shortcut">/clear</span></div>
      <div class="ctx-item" data-action="export">${T.ctxExport}<span class="shortcut">&#x1F4BE;</span></div>
      <div class="ctx-sep"></div>
      <div class="ctx-item" data-action="zoom-in">${T.ctxZoomIn}<span class="shortcut">Ctrl+=</span></div>
      <div class="ctx-item" data-action="zoom-out">${T.ctxZoomOut}<span class="shortcut">Ctrl+-</span></div>
      <div class="ctx-item" data-action="zoom-reset">${T.ctxZoomReset}<span class="shortcut">Ctrl+0</span></div>
      <div class="ctx-sep"></div>
      <div class="ctx-item" data-action="edit-memo">${T.ctxEditMemo}<span class="shortcut">&#x1F4DD;</span></div>
      <div class="ctx-item" data-action="change-theme">${T.ctxChangeTheme}<span class="shortcut">&#x1F3A8;</span></div>
      <div class="ctx-item" data-action="toggle-particles" id="ctx-particles">${T.ctxParticlesOff}<span class="shortcut">&#x2728;</span></div>
      <div class="ctx-item" data-action="toggle-sound" id="ctx-sound">${T.ctxSoundOff}<span class="shortcut">&#x1F514;</span></div>
      <div style="border-top:1px solid ${isDark ? '#444' : '#ddd'};margin:4px 0;"></div>
      <div class="ctx-item" data-action="settings">Settings<span class="shortcut">&#x2699;</span></div>
      <div class="ctx-item" data-action="close-resume">${T.ctxCloseResume}<span class="shortcut">&#x1F4BE;</span></div>
    </div>
  </div>

  <script src="${xtermJsUri}"></script>
  <script src="${fitAddonUri}"></script>
  <script src="${webLinksAddonUri}"></script>
  <script src="${searchAddonUri}"></script>
  <script>${getClientScript({ T, settings, fontSize, bg, fg, cursor, border, outerBg, statusGray, isDark, memo, customButtons, customSlashCommands })}</script>
</body>
</html>`;
}

module.exports = { getWebviewContent };
