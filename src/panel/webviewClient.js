// @module panel/webviewClient — client-side JavaScript injected into the webview.
// Phase 3c: extracted from webviewContent.js. Contains ${} interpolation for initial state.
// v2.6.0 plan: convert to real static client.js with __CLAUDE_INIT__ JSON injection.

function getClientScript(ctx) {
  const { T, settings, fontSize, bg, fg, cursor, border, outerBg, statusGray, isDark, memo, customButtons, customSlashCommands } = ctx;
  return `
    const vscode = acquireVsCodeApi();
    const T = ${JSON.stringify(T)};
    const SETTINGS = ${JSON.stringify(settings)};
    // Escape user input before injecting into innerHTML.
    // Phase 5 hotfix for XSS via customButtons.label / customSlashCommands / fileAssociations / taskQueue.
    function escapeHtml(s) {
      return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    }

    // v2.5.5/6: Detect a tab-separated table (Excel selection) and render as
    // Markdown. Strict detector: ≥2 rows, every row has the same number of
    // tab-separated columns (≥2). Returns { markdown, rows, cols } or null.
    function tryConvertTsvToMarkdown(text) {
      const stripped = text.replace(/\\r?\\n+$/, '');
      const lines = stripped.split(/\\r?\\n/);
      if (lines.length < 2) return null;
      const cols = lines[0].split('\\t').length;
      if (cols < 2) return null;
      for (const l of lines) {
        if (l.split('\\t').length !== cols) return null;
      }
      const rows = lines.map(l => l.split('\\t').map(c => c.replace(/\\|/g, '\\\\|').trim()));
      const fmt = r => '| ' + r.join(' | ') + ' |';
      const sep = fmt(rows[0].map(() => '---'));
      return {
        markdown: [fmt(rows[0]), sep, ...rows.slice(1).map(fmt)].join('\\n'),
        rows: rows.length,
        cols: cols
      };
    }
    const fitAddon = new FitAddon.FitAddon();
    const dot = document.getElementById('status-dot');
    const statusText = document.getElementById('toolbar-status');

    const term = new Terminal({
      cursorBlink: true,
      fontSize: ${fontSize},
      fontFamily: '${settings.fontFamily.replace(/'/g, "\\'")}',
      theme: {
        background: '${bg}',
        foreground: '${fg}',
        cursor: '${cursor}',
        // v2.6.0: explicit selection color. Light theme was previously using
        // '#ddd' (border color) which is invisible on a white background.
        selectionBackground: '${isDark ? "rgba(100, 150, 220, 0.4)" : "rgba(30, 100, 200, 0.25)"}'
      },
      allowProposedApi: true
    });

    const webLinksAddon = new WebLinksAddon.WebLinksAddon((event, uri) => {
      vscode.postMessage({ type: 'open-link', url: uri });
    });
    const searchAddon = new SearchAddon.SearchAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(webLinksAddon);
    term.loadAddon(searchAddon);
    term.open(document.getElementById('terminal'));
    fitAddon.fit();

    // ── Fullscreen mode detection + mouse mode suppression (v2.5.7) ──
    // Claude CLI's fullscreen mode uses alternate screen buffer + mouse
    // reporting. Mouse reporting makes xterm.js forward mouse events to the
    // PTY instead of handling selection locally, which breaks drag-select,
    // copy, context-menu, and other launcher features.
    //
    // Strategy: strip mouse-mode escape sequences from the PTY output BEFORE
    // they reach term.write(), so xterm.js never enters mouse mode. We still
    // detect them for the UI indicator. Alternate screen is left intact since
    // the TUI needs it for rendering.
    let isAlternateScreen = false;
    let isMouseMode = false;
    let fsHintShown = false;
    const fsIndicator = document.getElementById('fs-indicator');

    // Detect mouse tracking from raw PTY data (for UI indicator only).
    function checkMouseMode(data) {
      if (/\\x1b\\[\\?100[0-6]h/.test(data) || /\\x1b\\[\\?1015h/.test(data)) {
        if (!isMouseMode) { isMouseMode = true; updateFullscreenUI(); }
      }
      if (/\\x1b\\[\\?100[0-6]l/.test(data) || /\\x1b\\[\\?1015l/.test(data)) {
        if (isMouseMode) { isMouseMode = false; updateFullscreenUI(); }
      }
    }

    // Strip mouse-mode sequences so xterm.js never enters mouse reporting.
    // Covers: 1000-1006 (tracking modes), 1015 (urxvt extended).
    // This preserves normal drag-select, Ctrl+C copy, and context menu.
    function stripMouseMode(data) {
      return data.replace(/\\x1b\\[\\?(?:100[0-6]|1015)[hl]/g, '');
    }

    // Alternate screen buffer detection via xterm.js API.
    term.buffer.onBufferChange((buf) => {
      const alt = buf.type === 'alternate';
      if (alt !== isAlternateScreen) {
        isAlternateScreen = alt;
        updateFullscreenUI();
      }
    });

    function updateFullscreenUI() {
      const active = isAlternateScreen || isMouseMode;
      fsIndicator.style.display = active ? 'inline-flex' : 'none';
      if (active && !fsHintShown) {
        fsHintShown = true;
        showToast(T.fsHintToast);
      }
      if (isAlternateScreen) {
        scrollFab.style.display = 'none';
      }
    }

    // Forward mouse wheel to PTY as SGR mouse reports when fullscreen.
    // Without mouse-mode sequences xterm.js converts wheel→arrow keys in
    // alternate screen, causing input-history cycling instead of scrolling.
    // We intercept wheel in capture phase, construct the SGR report, and
    // send it to the PTY directly. Button 64=up, 65=down per SGR spec.
    //
    // v2.6.0: removed the 1-5x magnitude multiplier. Browsers and trackpads
    // already fire many wheel events per physical gesture (10-20+). The old
    // multiplier could produce 50-100 SGR reports per second, overwhelming
    // the TUI's partial-redraw pipeline and leaving ghost-text artifacts
    // from incomplete frame clears. One report per wheel event matches how
    // xterm.js natively behaves with mouse reporting, and scrolling still
    // feels responsive because the browser supplies plenty of events.
    (function attachWheelForward() {
      const screen = document.querySelector('.xterm-screen');
      if (!screen) { setTimeout(attachWheelForward, 200); return; }
      screen.addEventListener('wheel', (e) => {
        if (!isMouseMode) return; // normal mode: let xterm.js handle
        e.preventDefault();
        e.stopPropagation();
        const rect = screen.getBoundingClientRect();
        const cellW = rect.width / term.cols;
        const cellH = rect.height / term.rows;
        const x = Math.max(1, Math.min(term.cols, Math.floor((e.clientX - rect.left) / cellW) + 1));
        const y = Math.max(1, Math.min(term.rows, Math.floor((e.clientY - rect.top) / cellH) + 1));
        const btn = e.deltaY < 0 ? 64 : 65;
        const seq = '\\x1b[<' + btn + ';' + x + ';' + y + 'M';
        vscode.postMessage({ type: 'input', data: seq });
      }, { passive: false, capture: true });
    })();

    // Apply default theme from settings
    if (SETTINGS.defaultTheme && SETTINGS.defaultTheme !== 'default') {
      setTimeout(() => {
        const item = document.querySelector('.theme-item[data-theme="' + SETTINGS.defaultTheme + '"]');
        if (item) item.click();
      }, 100);
    }

    // Trim trailing whitespace from each line of terminal selection
    function getCleanSelection() {
      const sel = term.getSelection();
      if (!sel) return '';
      return sel.split('\\n').map(line => line.replace(/\\s+$/, '')).join('\\n');
    }

    // v2.5.7: Persistent selection cache. In fullscreen/mouse-reporting mode,
    // xterm.js clears the selection on mousedown BEFORE contextmenu fires.
    // We cache every non-empty selection as it happens via onSelectionChange,
    // so right-click → Open File / Copy still works even after the selection
    // is cleared by the mouse event.
    let ctxSelectionCache = '';
    let lastSelectionCache = '';
    term.onSelectionChange(() => {
      const sel = getCleanSelection().trim();
      if (sel) lastSelectionCache = sel;
    });
    function readSelection() {
      const live = getCleanSelection().trim();
      if (live) return live;
      if (ctxSelectionCache) return ctxSelectionCache;
      return lastSelectionCache;
    }

    // Open selected text as file path
    function openSelectedAsFile() {
      const sel = readSelection();
      if (!sel) {
        showToast(T.selectTextFirst);
        return;
      }
      // Clean up: remove quotes, backticks, trailing punctuation
      const cleaned = sel.replace(/^['"\`]+|['"\`]+$/g, '').replace(/[,;)]+$/, '');
      const lineMatch = cleaned.match(/:([0-9]+)$/);
      const lineNum = lineMatch ? parseInt(lineMatch[1]) : 0;
      const filePath = lineNum ? cleaned.replace(/:([0-9]+)$/, '') : cleaned;
      vscode.postMessage({ type: 'open-file', filePath: filePath, line: lineNum });
      showToast(T.openFileToast + filePath);
    }

    function openSelectedAsFolder() {
      const sel = readSelection();
      if (!sel) {
        showToast(T.selectTextFirst);
        return;
      }
      // Collapse newlines from multi-line drags; strip quotes/backticks and trailing punctuation
      const cleaned = sel.replace(/[\\r\\n]+/g, '').replace(/^['"\\\`]+|['"\\\`]+$/g, '').replace(/[,;)]+$/, '');
      if (!cleaned) {
        showToast(T.selectTextFirst);
        return;
      }
      vscode.postMessage({ type: 'open-folder', filePath: cleaned });
      showToast(T.openFolderToast + cleaned);
    }

    // Context usage indicator
    const ctxIndicator = document.getElementById('context-indicator');
    const ctxBarFill = document.getElementById('ctx-bar-fill');
    const ctxLabel = document.getElementById('ctx-label');

    function updateContextIndicator(used, total, pct) {
      ctxIndicator.style.display = 'inline-flex';
      ctxLabel.textContent = used + '/' + total + (pct != null ? ' ' + pct + '%' : '');
      const p = pct != null ? pct : 0;
      ctxBarFill.style.width = Math.min(p, 100) + '%';
      if (p >= 80) {
        ctxBarFill.style.background = '#f44336';
        ctxLabel.style.color = '#f44336';
      } else if (p >= 50) {
        ctxBarFill.style.background = '#e8a317';
        ctxLabel.style.color = '#e8a317';
      } else {
        ctxBarFill.style.background = '#4caf50';
        ctxLabel.style.color = '#888';
      }
    }

    // v2.6.1: clicking the context indicator now triggers /compact directly.
    // Previously it ran /context to re-query usage, but the bar already
    // auto-updates from output — so clicking was most often used when the
    // bar hit the danger zone (80%+) and the user wanted to compact anyway.
    ctxIndicator.addEventListener('click', () => {
      vscode.postMessage({ type: 'input', data: '/compact' + String.fromCharCode(13) });
      showToast(T.ctxCompacting);
      term.focus();
    });

    // Sound toggle
    let soundEnabled = SETTINGS.soundEnabled !== false;
    const soundBtn = document.getElementById('btn-sound');
    const ctxSoundItem = document.getElementById('ctx-sound');

    function updateSoundUI() {
      soundBtn.textContent = soundEnabled ? '\\u{1F514}' : '\\u{1F515}';
      soundBtn.title = soundEnabled ? T.ctxSoundOff : T.ctxSoundOn;
      ctxSoundItem.innerHTML = (soundEnabled ? T.ctxSoundOff : T.ctxSoundOn) + '<span class="shortcut">' + (soundEnabled ? '\\u{1F514}' : '\\u{1F515}') + '</span>';
    }

    soundBtn.addEventListener('click', () => {
      soundEnabled = !soundEnabled;
      updateSoundUI();
      showToast(soundEnabled ? T.soundOnToast : T.soundOffToast);
      term.focus();
    });

    // Font zoom
    const FONT_MIN = 8;
    const FONT_MAX = 22;
    const FONT_STEP = 1;
    let currentFontSize = ${fontSize};
    const fontLabel = document.getElementById('font-size-label');

    function setFontSize(size) {
      currentFontSize = Math.max(FONT_MIN, Math.min(FONT_MAX, size));
      term.options.fontSize = currentFontSize;
      fontLabel.textContent = currentFontSize + 'px';
      fitAddon.fit();
      vscode.postMessage({ type: 'resize', cols: term.cols, rows: term.rows });
    }

    // Input with history
    const inputHistory = [];
    let historyIndex = -1;
    let editorHistoryIdx = -1;
    let editorHistoryDraft = '';
    let currentLine = '';
    let lineBuffer = '';

    term.onData(data => {
      // Track input for history
      if (data === '\\r') {
        // Enter pressed: save line to history
        if (lineBuffer.trim().length > 0) {
          // Don't add duplicates of the last entry
          if (inputHistory.length === 0 || inputHistory[inputHistory.length - 1] !== lineBuffer.trim()) {
            inputHistory.push(lineBuffer.trim());
            if (inputHistory.length > 100) inputHistory.shift();
          }
        }
        lineBuffer = '';
        historyIndex = -1;
        currentLine = '';
      } else if (data === '\\x7f') {
        // Backspace
        lineBuffer = lineBuffer.slice(0, -1);
      } else if (data.length === 1 && data.charCodeAt(0) >= 32) {
        // Printable character
        lineBuffer += data;
      }
      vscode.postMessage({ type: 'input', data: data });
    });

    // Toolbar buttons
    document.getElementById('btn-new').addEventListener('click', () => {
      vscode.postMessage({ type: 'toolbar', action: 'new-tab' });
    });
    document.getElementById('btn-paste-img').addEventListener('click', () => {
      vscode.postMessage({ type: 'check-clipboard-image' });
      showToast(T.clipboardChecking);
      term.focus();
    });
    document.getElementById('btn-export').addEventListener('click', () => {
      exportConversation();
      term.focus();
    });

    // Settings modal
    const settingsModal = document.getElementById('settings-modal');
    const setTheme = document.getElementById('set-theme');
    const setFontsize = document.getElementById('set-fontsize');
    const setFontsizeLabel = document.getElementById('set-fontsize-label');
    const setFontfamily = document.getElementById('set-fontfamily');
    const setSound = document.getElementById('set-sound');
    const setParticles = document.getElementById('set-particles');

    function toggleSettings() {
      const visible = settingsModal.style.display === 'block';
      settingsModal.style.display = visible ? 'none' : 'block';
      if (!visible) {
        setTheme.value = SETTINGS.defaultTheme || 'default';
        setFontsize.value = currentFontSize;
        setFontsizeLabel.textContent = currentFontSize + 'px';
      }
    }

    document.getElementById('btn-settings').addEventListener('click', () => {
      toggleSettings();
      term.focus();
    });
    document.getElementById('settings-close').addEventListener('click', () => {
      settingsModal.style.display = 'none';
      term.focus();
    });

    setTheme.addEventListener('change', () => {
      const v = setTheme.value;
      SETTINGS.defaultTheme = v;
      vscode.postMessage({ type: 'save-setting', key: 'defaultTheme', value: v });
      const item = document.querySelector('.theme-item[data-theme="' + v + '"]');
      if (item) item.click();
    });

    setFontsize.addEventListener('input', () => {
      const v = parseInt(setFontsize.value);
      setFontsizeLabel.textContent = v + 'px';
      setFontSize(v);
      vscode.postMessage({ type: 'save-setting', key: 'defaultFontSize', value: v });
    });

    let fontFamilyTimer = null;
    setFontfamily.addEventListener('input', () => {
      clearTimeout(fontFamilyTimer);
      fontFamilyTimer = setTimeout(() => {
        const v = setFontfamily.value;
        term.options.fontFamily = v;
        fitAddon.fit();
        vscode.postMessage({ type: 'save-setting', key: 'defaultFontFamily', value: v });
      }, 500);
    });

    setSound.addEventListener('click', () => {
      soundEnabled = !soundEnabled;
      setSound.classList.toggle('on', soundEnabled);
      updateSoundUI();
      vscode.postMessage({ type: 'save-setting', key: 'soundEnabled', value: soundEnabled });
    });

    // Custom Buttons management
    let localButtons = ${JSON.stringify(customButtons || [])};
    const btnListEl = document.getElementById('set-buttons-list');

    function renderBtnList() {
      btnListEl.innerHTML = localButtons.map((b, i) =>
        '<div class="set-item"><span style="font-weight:600;">' + escapeHtml(b.label) + '</span><span style="color:${statusGray};">' + escapeHtml(b.command) + '</span><span class="set-item-del" data-bi="' + i + '">&#x2715;</span></div>'
      ).join('');
    }
    renderBtnList();

    btnListEl.addEventListener('click', (e) => {
      const del = e.target.closest('.set-item-del');
      if (del) {
        localButtons.splice(parseInt(del.dataset.bi), 1);
        renderBtnList();
        vscode.postMessage({ type: 'save-setting', key: 'customButtons', value: localButtons });
        showToast('Reload to apply button changes');
      }
    });

    document.getElementById('set-btn-add').addEventListener('click', () => {
      const label = document.getElementById('set-btn-label').value.trim();
      const cmd = document.getElementById('set-btn-cmd').value.trim();
      if (!label || !cmd) return;
      localButtons.push({ label, command: cmd });
      document.getElementById('set-btn-label').value = '';
      document.getElementById('set-btn-cmd').value = '';
      renderBtnList();
      vscode.postMessage({ type: 'save-setting', key: 'customButtons', value: localButtons });
      showToast('Reload to apply button changes');
    });

    // Custom Slash Commands management
    const CUSTOM_SLASH = ${JSON.stringify(customSlashCommands || [])};
    let localSlash = CUSTOM_SLASH.slice();
    const slashListEl = document.getElementById('set-slash-list');

    function renderSlashList() {
      slashListEl.innerHTML = localSlash.map((s, i) =>
        '<div class="set-item"><span style="font-weight:600;">' + escapeHtml(s.cmd) + '</span><span style="color:${statusGray};">' + escapeHtml(s.desc) + '</span><span class="set-item-del" data-si="' + i + '">&#x2715;</span></div>'
      ).join('');
    }
    renderSlashList();

    slashListEl.addEventListener('click', (e) => {
      const del = e.target.closest('.set-item-del');
      if (del) {
        const idx = parseInt(del.dataset.si);
        localSlash.splice(idx, 1);
        renderSlashList();
        // Also remove from live slashCommands
        const baseLen = 15;
        slashCommands.splice(baseLen + idx, 1);
        vscode.postMessage({ type: 'save-setting', key: 'customSlashCommands', value: localSlash });
      }
    });

    document.getElementById('set-slash-add').addEventListener('click', () => {
      const cmd = document.getElementById('set-slash-cmd').value.trim();
      const desc = document.getElementById('set-slash-desc').value.trim();
      if (!cmd || !desc) return;
      const entry = { cmd, desc };
      localSlash.push(entry);
      slashCommands.push(entry);
      document.getElementById('set-slash-cmd').value = '';
      document.getElementById('set-slash-desc').value = '';
      renderSlashList();
      vscode.postMessage({ type: 'save-setting', key: 'customSlashCommands', value: localSlash });
    });

    // File Associations management
    let localFileAssoc = Object.assign({}, SETTINGS.fileAssociations || {});
    const faListEl = document.getElementById('set-fileassoc-list');
    const FA_LABELS = { excel: 'Excel', system: 'System Default', browser: 'Browser', obsidian: 'Obsidian', editor: 'IDE Editor', auto: 'Auto' };

    function renderFaList() {
      const entries = Object.entries(localFileAssoc).sort((a, b) => a[0].localeCompare(b[0]));
      faListEl.innerHTML = entries.map(([ext, method]) =>
        '<div class="set-item"><span style="font-weight:600;">' + escapeHtml(ext) + '</span><span style="color:${statusGray};">' + escapeHtml(FA_LABELS[method] || method) + '</span><span class="set-item-del" data-faext="' + escapeHtml(ext) + '">&#x2715;</span></div>'
      ).join('');
    }
    renderFaList();

    faListEl.addEventListener('click', (e) => {
      const del = e.target.closest('.set-item-del');
      if (del) {
        delete localFileAssoc[del.dataset.faext];
        renderFaList();
        vscode.postMessage({ type: 'save-setting', key: 'fileAssociations', value: localFileAssoc });
      }
    });

    document.getElementById('set-fa-add').addEventListener('click', () => {
      let ext = document.getElementById('set-fa-ext').value.trim().toLowerCase();
      const method = document.getElementById('set-fa-method').value;
      if (!ext) return;
      if (!ext.startsWith('.')) ext = '.' + ext;
      localFileAssoc[ext] = method;
      document.getElementById('set-fa-ext').value = '';
      renderFaList();
      vscode.postMessage({ type: 'save-setting', key: 'fileAssociations', value: localFileAssoc });
    });

    document.getElementById('settings-export').addEventListener('click', () => {
      vscode.postMessage({ type: 'export-settings' });
    });
    document.getElementById('settings-import').addEventListener('click', () => {
      vscode.postMessage({ type: 'import-settings' });
    });

    setParticles.addEventListener('click', () => {
      particlesEnabled = !particlesEnabled;
      setParticles.classList.toggle('on', particlesEnabled);
      document.getElementById('ctx-particles').innerHTML = (particlesEnabled ? T.ctxParticlesOff : T.ctxParticlesOn) + '<span class="shortcut">&#x2728;</span>';
      vscode.postMessage({ type: 'save-setting', key: 'particlesEnabled', value: particlesEnabled });
      if (particlesEnabled) animateParticles();
    });

    // Tab memo
    const memoEl = document.getElementById('toolbar-memo');
    let currentMemo = \`${memo ? memo.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$/g, '\\$') : ''}\`;

    function updateMemoDisplay() {
      memoEl.textContent = currentMemo ? '| ' + currentMemo : T.addMemo;
      memoEl.style.opacity = currentMemo ? '1' : '0.5';
    }
    updateMemoDisplay();

    document.getElementById('toolbar-title').addEventListener('click', () => {
      vscode.postMessage({ type: 'rename-tab' });
    });

    memoEl.addEventListener('click', () => {
      vscode.postMessage({ type: 'request-edit-memo' });
    });

    // Theme picker
    // v2.6.0: each theme now carries an explicit 'selection' color. The
    // previous code fed the 'border' color to xterm.js selectionBackground,
    // which worked for dark themes but collapsed to near-invisible on the
    // light default (#ddd on #fff).
    const themePicker = document.getElementById('theme-picker');
    const themes = {
      'default':  { outer: '${outerBg}', terminal: '${bg}', fg: '${fg}', cursor: '${cursor}', border: '${border}', shadow: '${isDark ? "rgba(0,0,0,0.4)" : "rgba(0,0,0,0.08)"}', selection: '${isDark ? "rgba(100, 150, 220, 0.4)" : "rgba(30, 100, 200, 0.25)"}' },
      'midnight': { outer: '#15112e', terminal: '#1c1740', fg: '#c8c0f0', cursor: '#9080e0', border: '#3a2d6b', shadow: 'rgba(80,50,180,0.3)',  selection: 'rgba(144, 128, 224, 0.45)' },
      'ocean':    { outer: '#0a1828', terminal: '#0c2240', fg: '#a0d0f0', cursor: '#60a0e0', border: '#1a4070', shadow: 'rgba(30,80,160,0.3)',  selection: 'rgba(96, 160, 224, 0.45)' },
      'forest':   { outer: '#0a1a0a', terminal: '#0e2810', fg: '#a0e0a0', cursor: '#60c060', border: '#1a5020', shadow: 'rgba(30,120,40,0.3)',  selection: 'rgba(96, 192, 96, 0.4)' },
      'sunset':   { outer: '#1e0e08', terminal: '#2a1510', fg: '#f0c8a0', cursor: '#e09060', border: '#5a3020', shadow: 'rgba(180,80,30,0.3)',  selection: 'rgba(224, 144, 96, 0.4)' },
      'aurora':   { outer: '#0e0818', terminal: '#160e2e', fg: '#d0b0f0', cursor: '#b070e0', border: '#3a2060', shadow: 'rgba(120,40,180,0.3)', selection: 'rgba(176, 112, 224, 0.4)' },
      'warm':     { outer: '#1a1408', terminal: '#241c10', fg: '#e8d8b0', cursor: '#d0a860', border: '#4a3818', shadow: 'rgba(160,120,40,0.3)', selection: 'rgba(208, 168, 96, 0.4)' }
    };
    const termWrapper = document.getElementById('terminal-wrapper');

    let themePickerOpenTime = 0;
    function showThemePicker() {
      const visible = themePicker.style.display === 'block';
      themePicker.style.display = visible ? 'none' : 'block';
      if (!visible) themePickerOpenTime = Date.now();
    }

    function applyTheme(themeName) {
      const t = themes[themeName];
      if (!t) return;
      document.body.style.background = t.outer;
      termWrapper.style.background = t.terminal;
      termWrapper.style.borderColor = t.border;
      termWrapper.style.boxShadow = '0 4px 24px ' + t.shadow;
      term.options.theme = { background: t.terminal, foreground: t.fg, cursor: t.cursor, selectionBackground: t.selection };
    }

    themePicker.addEventListener('click', (e) => {
      const item = e.target.closest('.theme-item');
      if (!item) return;
      const themeName = item.dataset.theme;
      applyTheme(themeName);
      themePicker.style.display = 'none';
      showToast(T.themeApplied + item.textContent.trim());
      term.focus();
    });

    document.addEventListener('click', (e) => {
      if (!themePicker.contains(e.target) && Date.now() - themePickerOpenTime > 200) {
        themePicker.style.display = 'none';
      }
    });

    function exportConversation() {
      // v2.5.3: TUI apps (Claude CLI = Ink-based) emit cursor-move + partial
      // writes that look like gibberish once you strip ANSI blindly (which
      // v2.5.2 did). xterm.js already runs a full virtual-terminal state
      // machine — let it do the work, then export the resulting text.
      // term.getSelection() merges isWrapped logical lines correctly.
      //
      // v2.5.7: In alternate screen (fullscreen mode), selectAll only captures
      // the current viewport — scroll history lives in the normal buffer which
      // is not accessible. Warn the user so they know the export is partial.
      if (isAlternateScreen) {
        showToast(T.fsExportWarn);
      }
      term.selectAll();
      const all = term.getSelection();
      term.clearSelection();
      let text = all.split('\\n').map(l => l.replace(/\\s+$/, '')).join('\\n');
      text = text.replace(/\\n+$/, '');
      vscode.postMessage({ type: 'export-conversation', text: text });
      if (!isAlternateScreen) showToast(T.exportingToast);
    }

    document.getElementById('btn-zoom-in').addEventListener('click', () => {
      setFontSize(currentFontSize + FONT_STEP);
      term.focus();
    });
    document.getElementById('btn-zoom-out').addEventListener('click', () => {
      setFontSize(currentFontSize - FONT_STEP);
      term.focus();
    });

    // Search bar
    const searchBar = document.getElementById('search-bar');
    const searchInput = document.getElementById('search-input');
    const searchCount = document.getElementById('search-count');
    let searchVisible = false;

    function toggleSearch(show) {
      searchVisible = show;
      searchBar.style.display = show ? 'flex' : 'none';
      if (show) {
        searchInput.focus();
        searchInput.select();
      } else {
        searchCount.textContent = '';
        searchInput.value = '';
        searchAddon.clearDecorations();
        term.focus();
      }
    }

    searchInput.addEventListener('input', () => {
      const query = searchInput.value;
      if (query) {
        searchAddon.findPrevious(query);
      } else {
        searchAddon.clearDecorations();
        searchCount.textContent = '';
      }
    });
    searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.shiftKey) {
        e.preventDefault();
        if (searchInput.value) searchAddon.findPrevious(searchInput.value);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (searchInput.value) searchAddon.findNext(searchInput.value);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        toggleSearch(false);
      }
    });
    document.getElementById('search-next').addEventListener('click', () => {
      if (searchInput.value) searchAddon.findNext(searchInput.value);
    });
    document.getElementById('search-prev').addEventListener('click', () => {
      if (searchInput.value) searchAddon.findPrevious(searchInput.value);
    });
    document.getElementById('search-close').addEventListener('click', () => {
      toggleSearch(false);
    });

    // Toast notification.
    // v2.5.6: opts.image — prepend a small thumbnail (for image paste preview).
    //         opts.action = { label, onClick } — append ONE clickable "[label]" link.
    // v2.5.7: opts.actions = [{ label, onClick }, ...] — append multiple links.
    //         The toast root has pointer-events:none in CSS so it doesn't block
    //         terminal clicks; we re-enable pointer-events on the links only.
    let toastTimer = null;
    function showToast(message, opts) {
      const toast = document.getElementById('paste-toast');
      toast.innerHTML = '';
      if (opts && opts.image) {
        const thumb = document.createElement('img');
        thumb.src = opts.image;
        thumb.style.cssText = 'max-width:96px;max-height:64px;margin-right:8px;vertical-align:middle;border-radius:4px;border:1px solid rgba(255,255,255,0.2);';
        toast.appendChild(thumb);
      }
      toast.appendChild(document.createTextNode(message));
      const actionList = (opts && opts.actions) || (opts && opts.action ? [opts.action] : []);
      for (const a of actionList) {
        if (typeof a.onClick !== 'function') continue;
        const link = document.createElement('span');
        link.textContent = ' [' + (a.label || 'action') + ']';
        link.style.cssText = 'color:' + (a.color || '#4aa3ff') + ';cursor:pointer;text-decoration:underline;margin-left:6px;pointer-events:auto;';
        link.addEventListener('click', (e) => {
          e.stopPropagation();
          a.onClick();
          toast.style.opacity = '0';
          setTimeout(() => { toast.style.display = 'none'; }, 300);
          if (toastTimer) { clearTimeout(toastTimer); toastTimer = null; }
        });
        toast.appendChild(link);
      }
      toast.style.display = 'block';
      toast.style.opacity = '1';
      if (toastTimer) clearTimeout(toastTimer);
      toastTimer = setTimeout(() => {
        toast.style.opacity = '0';
        setTimeout(() => { toast.style.display = 'none'; }, 300);
      }, 4000);
    }

    // v2.5.7: send N DELs to undo a just-injected attachment path in the PTY.
    // Ink/readline TUIs treat 0x7f (DEL) as backspace. Works only if the user
    // hasn't typed further characters after the injection; if they did, those
    // trailing chars get erased first — a reasonable trade for simplicity.
    function sendBackspaces(count) {
      if (count <= 0) return;
      vscode.postMessage({ type: 'input', data: '\\x7f'.repeat(count) });
    }

    // Notification sound
    function playNotifySound() {
      if (!soundEnabled) return;
      try {
        const ctx = new AudioContext();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.type = 'sine';
        osc.frequency.setValueAtTime(880, ctx.currentTime);
        osc.frequency.setValueAtTime(660, ctx.currentTime + 0.1);
        gain.gain.setValueAtTime(0.3, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.3);
        osc.start(ctx.currentTime);
        osc.stop(ctx.currentTime + 0.3);
        osc.onended = () => ctx.close();
      } catch (_) {}
    }

    // Messages from extension
    window.addEventListener('message', event => {
      const msg = event.data;
      if (msg.type === 'output') {
        checkMouseMode(msg.data);
        const cleaned = stripMouseMode(msg.data);
        const wasAtBottom = term.buffer.active.viewportY >= term.buffer.active.baseY;
        term.write(cleaned, () => {
          if (wasAtBottom) term.scrollToBottom();
        });
      }
      if (msg.type === 'state') {
        // Hide restart bar when active
        if (msg.state === 'running' || msg.state === 'waiting') {
          document.getElementById('restart-bar').style.display = 'none';
        }
        updateState(msg.state);
      }
      if (msg.type === 'notify') {
        playNotifySound();
      }
      if (msg.type === 'title-updated') {
        document.getElementById('toolbar-title').textContent = msg.title;
      }
      if (msg.type === 'memo-updated') {
        currentMemo = msg.memo;
        updateMemoDisplay();
      }
      if (msg.type === 'export-result') {
        showToast(msg.success ? T.exportDone : T.exportFailToast);
      }
      if (msg.type === 'paste-file-ready') {
        if (msg.error) {
          showToast('\\u274C \\uD30C\\uC77C \\uC800\\uC7A5 \\uC2E4\\uD328');
        } else {
          // Inject "@<path> " into the PTY input. Trailing space lets user
          // type a prompt right after without worrying about path boundary.
          const injection = '@' + msg.cliPath + ' ';
          vscode.postMessage({ type: 'input', data: injection });
          const kb = Math.round(msg.size / 1024 * 10) / 10;
          const fsPath = msg.fullPath || msg.cliPath;
          const injectedLen = injection.length;
          showToast(
            '\\uD83D\\uDCCE ' + msg.fileName + ' (' + kb + 'KB) \\uCCA8\\uBD80\\uB428',
            {
              actions: [
                {
                  label: '\\uC5F4\\uAE30',
                  onClick: () => vscode.postMessage({ type: 'open-paste-file', path: fsPath })
                },
                {
                  label: '\\uCDE8\\uC18C',
                  color: '#ff7b7b',
                  onClick: () => {
                    sendBackspaces(injectedLen);
                    vscode.postMessage({ type: 'cancel-paste-file', path: fsPath });
                  }
                }
              ]
            }
          );
        }
      }
      if (msg.type === 'image-paste-result') {
        if (msg.success) {
          const opts = { image: lastImageDataUrl };
          if (msg.fullPath) {
            // Image handler PTY-writes "<forward-slash path> " so backspace
            // count = path.length + 1 (space). char count is the same either
            // way because backslash/forward-slash is 1-char-per-sep.
            const injectedLen = msg.fullPath.length + 1;
            opts.actions = [
              {
                label: '\\uC5F4\\uAE30',
                onClick: () => vscode.postMessage({ type: 'open-paste-file', path: msg.fullPath })
              },
              {
                label: '\\uCDE8\\uC18C',
                color: '#ff7b7b',
                onClick: () => {
                  sendBackspaces(injectedLen);
                  vscode.postMessage({ type: 'cancel-paste-file', path: msg.fullPath });
                }
              }
            ];
          }
          showToast(T.imageDone + msg.filename, opts);
          lastImageDataUrl = null;
        } else if (msg.reason && msg.reason !== 'clipboard-no-image') {
          showToast(T.imageFailToast + msg.reason);
          lastImageDataUrl = null;
        }
      }
      if (msg.type === 'context-usage') {
        updateContextIndicator(msg.used, msg.total, msg.pct);
      }
      if (msg.type === 'process-exited') {
        const isError = msg.exitCode && msg.exitCode !== 0;
        restartMsg.textContent = isError
          ? T.processErrorExit.replace('{0}', msg.exitCode)
          : T.processNormalExit;
        restartBtn.textContent = msg.canResume ? '\\u25B6 ' + T.resumeRestart : '\\u25B6 ' + T.newStart;
        restartBar.style.display = 'flex';
      }
    });

    // Restart bar
    const restartBar = document.getElementById('restart-bar');
    const restartMsg = document.getElementById('restart-msg');
    const restartBtn = document.getElementById('restart-btn');

    restartBtn.addEventListener('click', () => {
      restartBar.style.display = 'none';
      vscode.postMessage({ type: 'restart-session' });
      showToast(T.restartingToast);
    });

    // Response timer
    const timerEl = document.getElementById('toolbar-timer');
    let timerInterval = null;
    let timerStart = 0;

    function startTimer() {
      stopTimer();
      timerStart = Date.now();
      timerEl.style.display = 'inline';
      timerEl.textContent = '0:00';
      timerInterval = setInterval(() => {
        const elapsed = Math.floor((Date.now() - timerStart) / 1000);
        const m = Math.floor(elapsed / 60);
        const s = elapsed % 60;
        timerEl.textContent = m + ':' + String(s).padStart(2, '0');
      }, 1000);
    }

    function stopTimer() {
      if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
      timerEl.style.display = 'none';
    }

    const termWrapperEl = document.getElementById('terminal-wrapper');
    function updateState(state) {
      const states = {
        running:           { color: '#e8a317', text: T.stRunning },
        waiting:           { color: '#888',    text: T.stWaiting },
        'needs-attention': { color: '#4caf50', text: T.stAttention },
        done:              { color: '#4caf50', text: T.stDone },
        error:             { color: '#f44336', text: T.stError }
      };
      const s = states[state];
      if (s) {
        dot.style.background = s.color;
        statusText.textContent = s.text;
        statusText.style.color = s.color;
      }
      // Ambient glow
      termWrapperEl.className = '';
      termWrapperEl.classList.add('glow-' + state);
      if (state === 'running') {
        startTimer();
      } else {
        stopTimer();
      }
      // Track state for queue auto-start
      lastKnownState = state;
      // Queue: auto-send next item when idle
      if (state === 'waiting' || state === 'needs-attention') {
        if (queueRunning && queueCurrentIndex >= 0) {
          queueCurrentIndex++;
          if (queueCurrentIndex < taskQueue.length) {
            queueStatus.textContent = T.queueRunning + (queueCurrentIndex + 1) + '/' + taskQueue.length;
            renderQueue();
            setTimeout(() => sendQueueItem(queueCurrentIndex), 500);
          } else {
            sendQueueItem(queueCurrentIndex); // triggers completion
          }
        } else if (!queueRunning && taskQueue.length > 0) {
          // Auto-start queue when idle and items are pending
          setTimeout(() => startQueue(), 500);
        }
      }
    }

    // ── Clipboard paste (v2.5.5: text priority) ──
    // Capture phase: intercept BEFORE xterm.js processes the paste event.
    //
    // Excel etc. put BOTH tab-separated text AND a rendered PNG on the
    // clipboard. Before v2.5.5 we iterated items[] and caught image first,
    // so table selections became PNG uploads. Now: if text exists, treat as
    // text (optionally converting TSV→Markdown). Image path only kicks in
    // when there is no text (pure screenshot paste).
    let lastWebviewPasteTime = 0;
    document.addEventListener('paste', (e) => {
      const rawText = e.clipboardData?.getData('text') || '';

      if (rawText) {
        const tableOn = SETTINGS.pasteTableAsMarkdown !== false;
        const conv = tableOn ? tryConvertTsvToMarkdown(rawText) : null;
        const text = conv ? conv.markdown : rawText;
        const converted = !!conv;

        const thresholdRaw = SETTINGS.pasteToFileThreshold;
        const threshold = (thresholdRaw === undefined || thresholdRaw === null) ? 2000 : thresholdRaw;

        // Over threshold → paste-to-file (sidesteps PTY write truncation).
        if (threshold > 0 && text.length > threshold) {
          e.preventDefault();
          e.stopPropagation();
          lastWebviewPasteTime = Date.now();
          const kb = Math.round(text.length / 1024 * 10) / 10;
          showToast('\\uD83D\\uDCCE ' + kb + 'KB \\u2192 \\uD30C\\uC77C \\uC800\\uC7A5 \\uC911...');
          vscode.postMessage({ type: 'paste-large-text', text: text });
          return;
        }

        // Converted TSV → inject the Markdown form via term.paste so xterm
        // handles bracketed-paste wrapping if the app requests it.
        if (converted) {
          e.preventDefault();
          e.stopPropagation();
          lastWebviewPasteTime = Date.now();
          term.paste(text);
          showToast('\\uD83D\\uDCCA TSV \\u2192 Markdown: ' + conv.rows + '\\uD589 \\u00D7 ' + conv.cols + '\\uC5F4');
          return;
        }

        // Plain small text: let xterm handle it normally (default browser paste).
        return;
      }

      // No text on clipboard → fall through to image handling (screenshots).
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const item of items) {
        if (item.type.startsWith('image/')) {
          e.preventDefault();
          e.stopPropagation();
          lastWebviewPasteTime = Date.now();
          const blob = item.getAsFile();
          if (!blob) return;
          const reader = new FileReader();
          reader.onload = () => {
            const dataUrl = reader.result;
            const base64 = dataUrl.split(',')[1];
            if (base64) {
              // v2.5.6: preview the pasted image as a thumbnail in the toast
              // so the user can spot a wrong clipboard immediately.
              lastImageDataUrl = dataUrl;
              showToast(T.imagePasting, { image: dataUrl });
              vscode.postMessage({ type: 'paste-image', data: base64 });
            }
          };
          reader.readAsDataURL(blob);
          return;
        }
      }
    }, true); // <-- capture phase

    // v2.5.6: retained between paste-dispatch and the image-paste-result echo
    // so the "done" toast can reuse the same thumbnail without re-encoding.
    let lastImageDataUrl = null;

    // v2.6.2: Ctrl+C copy at document level (capture phase).
    // xterm's attachCustomKeyEventHandler only fires when xterm's internal
    // textarea has focus. Drag-to-select in fullscreen/alternate-screen can
    // leave focus on the viewport div instead, so the xterm handler misses
    // the Ctrl+C. Document capture catches it everywhere.
    //
    // IMPORTANT: xterm.js uses a hidden <textarea class="xterm-helper-textarea">
    // to capture keyboard input, so a naive "skip INPUT/TEXTAREA" guard would
    // silently skip xterm's own textarea and let ^C leak through to the PTY
    // (Claude CLI then starts its "press Ctrl+C again to exit" countdown even
    // after a successful clipboard copy). Instead we check whether the target
    // is inside our xterm container (#terminal). If yes → it's xterm's helper
    // textarea, proceed with copy. If no and target is a real user-facing
    // input → bail so native Ctrl+C (browser-level copy) still works in the
    // search/editor/settings inputs.
    //
    // We also stopImmediatePropagation to make sure no bubble-phase listener
    // (including xterm's own internal hooks) fires ^C forwarding.
    const termContainer = document.getElementById('terminal');
    document.addEventListener('keydown', (e) => {
      if (!(e.ctrlKey || e.metaKey) || e.key !== 'c') return;
      const inTerm = termContainer && e.target && termContainer.contains(e.target);
      if (!inTerm) {
        const tag = (e.target && e.target.tagName) || '';
        if (tag === 'INPUT' || tag === 'TEXTAREA') return; // real user input
      }
      const sel = getCleanSelection() || lastSelectionCache;
      if (!sel) return; // no selection → let ^C pass through to xterm → PTY
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      navigator.clipboard.writeText(sel).catch(() => {});
      showToast(T.copied);
      lastSelectionCache = '';
    }, true);

    // Fallback: on Ctrl+V, ask extension to check system clipboard via PowerShell
    // Handles cases where webview paste event doesn't include image data
    term.attachCustomKeyEventHandler((event) => {
      if (event.type !== 'keydown') return true;
      const mod = event.ctrlKey || event.metaKey;

      // Ctrl+?: toggle shortcut overlay
      if (mod && (event.key === '?' || (event.shiftKey && event.key === '/'))) {
        event.preventDefault();
        toggleShortcutOverlay();
        return false;
      }

      // Ctrl+Up/Down: input history
      if (mod && event.key === 'ArrowUp' && inputHistory.length > 0) {
        event.preventDefault();
        if (historyIndex === -1) {
          currentLine = lineBuffer;
          historyIndex = inputHistory.length - 1;
        } else if (historyIndex > 0) {
          historyIndex--;
        }
        // Clear current line and insert history item
        const clearLen = lineBuffer.length;
        let clear = '';
        for (let i = 0; i < clearLen; i++) clear += '\\x7f';
        vscode.postMessage({ type: 'input', data: clear });
        const text = inputHistory[historyIndex];
        vscode.postMessage({ type: 'input', data: text });
        lineBuffer = text;
        return false;
      }
      if (mod && event.key === 'ArrowDown') {
        event.preventDefault();
        if (historyIndex === -1) return false;
        let text;
        if (historyIndex < inputHistory.length - 1) {
          historyIndex++;
          text = inputHistory[historyIndex];
        } else {
          historyIndex = -1;
          text = currentLine;
        }
        const clearLen = lineBuffer.length;
        let clear = '';
        for (let i = 0; i < clearLen; i++) clear += '\\x7f';
        vscode.postMessage({ type: 'input', data: clear });
        vscode.postMessage({ type: 'input', data: text });
        lineBuffer = text;
        return false;
      }

      // Ctrl+Shift+Enter: multiline editor
      if (mod && event.shiftKey && event.key === 'Enter') {
        event.preventDefault();
        toggleEditor();
        return false;
      }

      // Ctrl+C: document-level capture does the copy, but keep a belt-and-
      // suspenders guard here: if a selection exists, tell xterm NOT to
      // process the event (return false). This blocks xterm from sending
      // ^C to the PTY if the document capture somehow missed it (e.g. the
      // capture phase didn't stop propagation early enough on some hosts).
      // When no selection exists, return true so xterm sends ^C normally —
      // that's the Claude CLI "Ctrl+C twice to exit" prep behavior the user
      // actually wants.
      if (mod && event.key === 'c') {
        if (getCleanSelection() || lastSelectionCache) {
          return false;
        }
        return true;
      }

      // Ctrl+F: toggle search bar
      if (mod && event.key === 'f') {
        event.preventDefault();
        toggleSearch(!searchVisible);
        return false;
      }

      // Ctrl+V: clipboard image fallback
      if (mod && event.key === 'v') {
        setTimeout(() => {
          if (Date.now() - lastWebviewPasteTime > 300) {
            vscode.postMessage({ type: 'check-clipboard-image' });
          }
        }, 150);
        return true;
      }

      // Ctrl+= / Ctrl+-: font zoom
      if (mod && (event.key === '=' || event.key === '+')) {
        event.preventDefault();
        setFontSize(currentFontSize + FONT_STEP);
        return false;
      }
      if (mod && event.key === '-') {
        event.preventDefault();
        setFontSize(currentFontSize - FONT_STEP);
        return false;
      }
      // Ctrl+0: reset font size
      if (mod && event.key === '0') {
        event.preventDefault();
        setFontSize(${fontSize});
        return false;
      }

      return true;
    });

    // ── Context menu ──
    const ctxMenu = document.getElementById('context-menu');

    function showContextMenu(x, y) {
      ctxMenu.style.display = 'block';
      // Keep menu within viewport
      const rect = ctxMenu.getBoundingClientRect();
      const maxX = window.innerWidth - rect.width - 8;
      const maxY = window.innerHeight - rect.height - 8;
      ctxMenu.style.left = Math.min(x, maxX) + 'px';
      ctxMenu.style.top = Math.min(y, maxY) + 'px';
    }

    function hideContextMenu() {
      ctxMenu.style.display = 'none';
    }

    // v2.5.7: capture phase so contextmenu fires even when xterm.js mouse
    // reporting intercepts and stopPropagation's the event in bubble phase.
    document.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      // Snapshot selection before the menu click (mousedown/click may clear xterm selection)
      ctxSelectionCache = getCleanSelection().trim();
      showContextMenu(e.clientX, e.clientY);
    }, true);

    document.addEventListener('click', (e) => {
      if (!ctxMenu.contains(e.target)) hideContextMenu();
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && ctxMenu.style.display === 'block') {
        hideContextMenu();
      }
    });

    ctxMenu.addEventListener('click', (e) => {
      const item = e.target.closest('.ctx-item');
      if (!item) return;
      hideContextMenu();
      const action = item.dataset.action;

      switch (action) {
        case 'copy':
          const sel = getCleanSelection() || ctxSelectionCache || lastSelectionCache;
          if (sel) { navigator.clipboard.writeText(sel); lastSelectionCache = ''; }
          break;
        case 'open-file':
          openSelectedAsFile();
          break;
        case 'open-folder':
          openSelectedAsFolder();
          break;
        case 'paste':
          navigator.clipboard.readText().then(text => {
            if (text) vscode.postMessage({ type: 'input', data: text });
          }).catch(() => {});
          break;
        case 'paste-image':
          vscode.postMessage({ type: 'check-clipboard-image' });
          showToast(T.clipboardChecking);
          break;
        case 'search':
          toggleSearch(!searchVisible);
          break;
        case 'clear':
          vscode.postMessage({ type: 'toolbar', action: 'clear' });
          break;
        case 'zoom-in':
          setFontSize(currentFontSize + FONT_STEP);
          break;
        case 'zoom-out':
          setFontSize(currentFontSize - FONT_STEP);
          break;
        case 'zoom-reset':
          setFontSize(${fontSize});
          break;
        case 'export':
          exportConversation();
          break;
        case 'edit-memo':
          memoEl.click();
          break;
        case 'toggle-particles':
          particlesEnabled = !particlesEnabled;
          pCanvas.style.display = particlesEnabled ? 'block' : 'none';
          document.getElementById('ctx-particles').innerHTML = (particlesEnabled ? T.ctxParticlesOff : T.ctxParticlesOn) + '<span class="shortcut">&#x2728;</span>';
          showToast(particlesEnabled ? T.particlesOnToast : T.particlesOffToast);
          if (particlesEnabled) animateParticles();
          break;
        case 'change-theme':
          showThemePicker();
          break;
        case 'toggle-sound':
          soundEnabled = !soundEnabled;
          updateSoundUI();
          showToast(soundEnabled ? T.soundOnToast : T.soundOffToast);
          break;
        case 'settings':
          toggleSettings();
          break;
        case 'close-resume':
          vscode.postMessage({ type: 'close-resume' });
          break;
      }
      term.focus();
    });

    // ── Drag and drop files ──
    const wrapper = document.getElementById('terminal-wrapper');
    const overlay = document.getElementById('drop-overlay');
    let dragCounter = 0;

    wrapper.addEventListener('dragenter', (e) => {
      e.preventDefault();
      dragCounter++;
      overlay.style.display = 'flex';
    });
    wrapper.addEventListener('dragleave', (e) => {
      e.preventDefault();
      dragCounter--;
      if (dragCounter <= 0) {
        overlay.style.display = 'none';
        dragCounter = 0;
      }
    });
    wrapper.addEventListener('dragover', (e) => {
      e.preventDefault();
    });
    wrapper.addEventListener('drop', (e) => {
      e.preventDefault();
      overlay.style.display = 'none';
      dragCounter = 0;

      const files = e.dataTransfer?.files;
      if (files && files.length > 0) {
        // Webview cannot read full paths from dropped files for security
        // Use dataTransfer text as fallback
        const text = e.dataTransfer.getData('text/plain');
        if (text) {
          vscode.postMessage({ type: 'drop-files', paths: [text] });
        }
      }
      term.focus();
    });

    // Input panel (bottom fixed)
    const inputPanel = document.getElementById('input-panel');
    const editorTextarea = document.getElementById('editor-textarea');
    let inputPanelVisible = true;
    inputPanel.style.display = 'block';

    function toggleEditor() {
      inputPanelVisible = !inputPanelVisible;
      inputPanel.style.display = inputPanelVisible ? 'block' : 'none';
      if (inputPanelVisible) {
        editorTextarea.focus();
      } else {
        term.focus();
      }
      const wasBottom = term.buffer.active.viewportY >= term.buffer.active.baseY;
      fitAddon.fit();
      if (wasBottom) term.scrollToBottom();
      vscode.postMessage({ type: 'resize', cols: term.cols, rows: term.rows });
    }

    function sendEditorContent() {
      const text = editorTextarea.value;
      if (!text.trim()) return;
      flashSend();
      // Send each line followed by newline
      const lines = text.split('\\n');
      for (let i = 0; i < lines.length; i++) {
        if (i > 0) vscode.postMessage({ type: 'input', data: '\\n' });
        vscode.postMessage({ type: 'input', data: lines[i] });
      }
      // Send final Enter to submit
      vscode.postMessage({ type: 'input', data: '\\r' });
      // Add to input history
      if (text.trim().length > 0) {
        if (inputHistory.length === 0 || inputHistory[inputHistory.length - 1] !== text.trim()) {
          inputHistory.push(text.trim());
          if (inputHistory.length > 100) inputHistory.shift();
        }
        historyIndex = -1;
        editorHistoryIdx = -1;
        editorHistoryDraft = '';
      }
      editorTextarea.value = '';
      autoResizeTextarea();
      editorTextarea.focus();
    }

    document.getElementById('editor-send').addEventListener('click', sendEditorContent);

    document.querySelectorAll('.custom-cmd-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const cmd = btn.getAttribute('data-cmd');
        if (cmd) {
          vscode.postMessage({ type: 'input', data: cmd + String.fromCharCode(13) });
        }
        term.focus();
      });
    });

    // Task queue
    const taskQueue = [];
    let queueRunning = false;
    let queueCurrentIndex = -1;
    const queueList = document.getElementById('queue-list');
    const queueStatus = document.getElementById('queue-status');
    const queueRunBtn = document.getElementById('queue-run');
    const queueAddBtn = document.getElementById('queue-add');

    function renderQueue() {
      if (taskQueue.length === 0) {
        queueList.style.display = 'none';
        queueRunBtn.style.display = 'none';
        queueStatus.style.display = 'none';
        return;
      }
      queueList.style.display = 'block';
      queueRunBtn.style.display = 'inline-block';
      queueList.innerHTML = taskQueue.map((item, i) => {
        const active = queueRunning && i === queueCurrentIndex ? ' active' : '';
        const done = queueRunning && i < queueCurrentIndex ? ' style="opacity:0.4"' : '';
        return '<div class="queue-item' + active + '"' + done + '>' +
          '<span class="qi-num">#' + (i + 1) + '</span>' +
          '<span class="qi-text">' + item.replace(/</g, '&lt;') + '</span>' +
          (queueRunning ? '' : '<span class="qi-del" data-qi="' + i + '">&#x2715;</span>') +
          '</div>';
      }).join('');
    }

    let lastKnownState = 'waiting';

    queueAddBtn.addEventListener('click', () => {
      const text = editorTextarea.value.trim();
      if (!text) return;
      taskQueue.push(text);
      editorTextarea.value = '';
      autoResizeTextarea();
      renderQueue();
      editorTextarea.focus();
      // Auto-start if idle
      if (!queueRunning && (lastKnownState === 'waiting' || lastKnownState === 'needs-attention')) {
        startQueue();
      }
    });

    queueList.addEventListener('click', (e) => {
      const del = e.target.closest('.qi-del');
      if (del && !queueRunning) {
        taskQueue.splice(parseInt(del.dataset.qi), 1);
        renderQueue();
      }
    });

    function startQueue() {
      if (queueRunning || taskQueue.length === 0) return;
      queueRunning = true;
      queueCurrentIndex = 0;
      queueStatus.textContent = T.queueRunning + '1/' + taskQueue.length;
      queueStatus.style.display = 'block';
      renderQueue();
      sendQueueItem(0);
    }

    function sendQueueItem(index) {
      if (index >= taskQueue.length) {
        // Queue finished
        queueRunning = false;
        queueCurrentIndex = -1;
        taskQueue.length = 0;
        renderQueue();
        return;
      }
      const text = taskQueue[index];
      const lines = text.split('\\n');
      for (let i = 0; i < lines.length; i++) {
        if (i > 0) vscode.postMessage({ type: 'input', data: '\\n' });
        vscode.postMessage({ type: 'input', data: lines[i] });
      }
      vscode.postMessage({ type: 'input', data: '\\r' });
    }

    // Slash command menu
    const slashMenu = document.getElementById('slash-menu');
    const slashCommands = [
      { cmd: '/compact', desc: T.slashCompact },
      { cmd: '/clear', desc: T.slashClear },
      { cmd: '/context', desc: T.slashContext },
      { cmd: '/model', desc: T.slashModel },
      { cmd: '/cost', desc: T.slashCost },
      { cmd: '/help', desc: T.slashHelp },
      { cmd: '/memory', desc: T.slashMemory },
      { cmd: '/config', desc: T.slashConfig },
      { cmd: '/review', desc: T.slashReview },
      { cmd: '/pr-comments', desc: T.slashPrComments },
      { cmd: '/doctor', desc: T.slashDoctor },
      { cmd: '/init', desc: T.slashInit },
      { cmd: '/login', desc: T.slashLogin },
      { cmd: '/logout', desc: T.slashLogout },
      { cmd: '/terminal-setup', desc: T.slashTerminalSetup },
      ...CUSTOM_SLASH,
    ];
    let slashActiveIndex = 0;
    let slashFiltered = [];

    function showSlashMenu(query) {
      slashFiltered = slashCommands.filter(c =>
        c.cmd.toLowerCase().includes(query.toLowerCase()) ||
        c.desc.toLowerCase().includes(query.toLowerCase())
      );
      if (slashFiltered.length === 0) {
        slashMenu.style.display = 'none';
        return;
      }
      slashActiveIndex = 0;
      renderSlashMenu();
      slashMenu.style.display = 'block';
    }

    function renderSlashMenu() {
      slashMenu.innerHTML = slashFiltered.map((c, i) =>
        '<div class="slash-item' + (i === slashActiveIndex ? ' active' : '') + '" data-index="' + i + '">' +
        '<span class="slash-cmd">' + escapeHtml(c.cmd) + '</span>' +
        '<span class="slash-desc">' + escapeHtml(c.desc) + '</span>' +
        '</div>'
      ).join('');
      // Keep active item visible
      const activeEl = slashMenu.querySelector('.slash-item.active');
      if (activeEl) activeEl.scrollIntoView({ block: 'nearest' });
    }

    function selectSlashCommand(index) {
      const cmd = slashFiltered[index];
      if (!cmd) return;
      // Replace the /query with the full command
      const text = editorTextarea.value;
      const lastSlash = text.lastIndexOf('/');
      editorTextarea.value = text.substring(0, lastSlash) + cmd.cmd;
      slashMenu.style.display = 'none';
      editorTextarea.focus();
    }

    slashMenu.addEventListener('click', (e) => {
      const item = e.target.closest('.slash-item');
      if (item) selectSlashCommand(parseInt(item.dataset.index));
    });

    function autoResizeTextarea() {
      editorTextarea.style.height = 'auto';
      const h = Math.max(36, Math.min(editorTextarea.scrollHeight, 200));
      editorTextarea.style.height = h + 'px';
      editorTextarea.style.overflowY = editorTextarea.scrollHeight > 200 ? 'auto' : 'hidden';
    }

    // Typing effects
    const typingRipple = document.getElementById('typing-ripple');
    let typingTimer = null;
    let keystrokeCount = 0;

    function spawnRipple() {
      const dot = document.createElement('div');
      dot.className = 'ripple-dot';
      const rect = editorTextarea.getBoundingClientRect();
      const parentRect = typingRipple.getBoundingClientRect();
      dot.style.left = (Math.random() * rect.width) + 'px';
      dot.style.top = (Math.random() * rect.height) + 'px';
      typingRipple.appendChild(dot);
      setTimeout(() => dot.remove(), 600);
    }

    function updateTypingGlow() {
      if (editorTextarea.value.length === 0) {
        editorTextarea.classList.remove('typing', 'typing-intense');
        keystrokeCount = 0;
        return;
      }
      keystrokeCount++;
      if (keystrokeCount > 10) {
        editorTextarea.classList.add('typing-intense');
        editorTextarea.classList.remove('typing');
      } else {
        editorTextarea.classList.add('typing');
        editorTextarea.classList.remove('typing-intense');
      }
      if (typingTimer) clearTimeout(typingTimer);
      typingTimer = setTimeout(() => {
        editorTextarea.classList.remove('typing', 'typing-intense');
        keystrokeCount = 0;
      }, 1500);
    }

    function flashSend() {
      editorTextarea.classList.remove('typing', 'typing-intense');
      editorTextarea.classList.add('send-flash');
      setTimeout(() => editorTextarea.classList.remove('send-flash'), 400);
      keystrokeCount = 0;
    }

    editorTextarea.addEventListener('input', () => {
      autoResizeTextarea();
      updateTypingGlow();
      if (editorTextarea.value.length > 0 && Math.random() < 0.4) spawnRipple();
      const text = editorTextarea.value;
      const lastLine = text.split('\\n').pop();
      // Match /command at start of line or after whitespace
      const slashMatch = lastLine.match(/(?:^|\\s)\\/(\\S*)$/);
      if (slashMatch) {
        showSlashMenu('/' + slashMatch[1]);
      } else {
        slashMenu.style.display = 'none';
      }
    });

    editorTextarea.addEventListener('keydown', (e) => {
      // Slash menu navigation
      if (slashMenu.style.display === 'block') {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          slashActiveIndex = Math.min(slashActiveIndex + 1, slashFiltered.length - 1);
          renderSlashMenu();
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          slashActiveIndex = Math.max(slashActiveIndex - 1, 0);
          renderSlashMenu();
          return;
        }
        if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey) {
          e.preventDefault();
          selectSlashCommand(slashActiveIndex);
          return;
        }
        if (e.key === 'Tab') {
          e.preventDefault();
          selectSlashCommand(slashActiveIndex);
          return;
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          slashMenu.style.display = 'none';
          return;
        }
      }

      // Ctrl+ArrowUp/Down: editor input history
      if (e.key === 'ArrowUp' && (e.ctrlKey || e.metaKey) && !e.shiftKey) {
        if (inputHistory.length === 0) return;
        e.preventDefault();
        if (editorHistoryIdx === -1) editorHistoryDraft = editorTextarea.value;
        if (editorHistoryIdx < inputHistory.length - 1) {
          editorHistoryIdx++;
          editorTextarea.value = inputHistory[inputHistory.length - 1 - editorHistoryIdx];
          autoResizeTextarea();
        }
        return;
      }
      if (e.key === 'ArrowDown' && (e.ctrlKey || e.metaKey) && !e.shiftKey) {
        if (editorHistoryIdx < 0) return;
        e.preventDefault();
        editorHistoryIdx--;
        if (editorHistoryIdx < 0) {
          editorTextarea.value = editorHistoryDraft || '';
        } else {
          editorTextarea.value = inputHistory[inputHistory.length - 1 - editorHistoryIdx];
        }
        autoResizeTextarea();
        return;
      }

      // Enter: send, Shift+Enter: newline
      // e.isComposing: IME 조합 중(한글 등) Enter는 무시
      if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.isComposing) {
        e.preventDefault();
        sendEditorContent();
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        toggleEditor();
      }
    });

    // Shortcut overlay
    const scOverlay = document.getElementById('shortcut-overlay');
    function toggleShortcutOverlay() {
      const visible = scOverlay.style.display === 'flex';
      scOverlay.style.display = visible ? 'none' : 'flex';
      if (visible) term.focus();
    }
    scOverlay.addEventListener('click', (e) => {
      if (e.target === scOverlay) toggleShortcutOverlay();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && scOverlay.style.display === 'flex') {
        toggleShortcutOverlay();
      }
    });

    // Scroll to bottom FAB
    const scrollFab = document.getElementById('scroll-fab');
    let isAtBottom = true;

    // xterm viewport scroll detection
    // v2.5.7: suppress in alternate screen — TUI manages own scrolling
    const checkScroll = () => {
      if (isAlternateScreen) { scrollFab.style.display = 'none'; return; }
      const viewport = document.querySelector('.xterm-viewport');
      if (!viewport) return;
      const atBottom = viewport.scrollTop + viewport.clientHeight >= viewport.scrollHeight - 10;
      if (atBottom !== isAtBottom) {
        isAtBottom = atBottom;
        scrollFab.style.display = isAtBottom ? 'none' : 'flex';
      }
    };

    // v2.5.6 (B4): replaced 1s polling with direct scroll listener on xterm's
    // viewport element. The viewport is created by xterm after open(), so we
    // attach once it appears (short retry). No work while the tab is idle.
    (function attachViewportScroll() {
      const viewport = document.querySelector('.xterm-viewport');
      if (!viewport) { setTimeout(attachViewportScroll, 200); return; }
      viewport.addEventListener('scroll', checkScroll, { passive: true });
      checkScroll();
    })();

    scrollFab.addEventListener('click', () => {
      term.scrollToBottom();
      scrollFab.style.display = 'none';
      isAtBottom = true;
      term.focus();
    });

    // Resize (debounced + size-change guard to prevent flicker)
    let resizeTimer = null;
    let lastCols = 0;
    let lastRows = 0;
    let lastObsWidth = 0;
    let lastObsHeight = 0;
    const resizeObserver = new ResizeObserver((entries) => {
      const rect = entries[0].contentRect;
      // Only process if size actually changed by more than 5px
      if (Math.abs(rect.width - lastObsWidth) < 5 && Math.abs(rect.height - lastObsHeight) < 5) return;
      lastObsWidth = rect.width;
      lastObsHeight = rect.height;
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        const wasAtBottom = term.buffer.active.viewportY >= term.buffer.active.baseY;
        fitAddon.fit();
        if (wasAtBottom) term.scrollToBottom();
        if (term.cols !== lastCols || term.rows !== lastRows) {
          lastCols = term.cols;
          lastRows = term.rows;
          vscode.postMessage({ type: 'resize', cols: term.cols, rows: term.rows });
        }
      }, 200);
    });
    resizeObserver.observe(document.getElementById('terminal'));

    // Particle system
    const pCanvas = document.getElementById('particle-canvas');
    const pCtx = pCanvas.getContext('2d');
    let particles = [];
    let particleState = 'waiting';
    let particlesEnabled = SETTINGS.particlesEnabled !== false;
    const PARTICLE_COUNT = 30;

    function resizeCanvas() {
      pCanvas.width = pCanvas.parentElement.clientWidth;
      pCanvas.height = pCanvas.parentElement.clientHeight;
    }
    resizeCanvas();
    window.addEventListener('resize', resizeCanvas);

    function createParticle() {
      return {
        x: Math.random() * pCanvas.width,
        y: Math.random() * pCanvas.height,
        vx: (Math.random() - 0.5) * 0.3,
        vy: (Math.random() - 0.5) * 0.3 - 0.1,
        size: Math.random() * 2 + 0.5,
        alpha: Math.random() * 0.3 + 0.1,
        pulse: Math.random() * Math.PI * 2
      };
    }

    for (let i = 0; i < PARTICLE_COUNT; i++) particles.push(createParticle());

    function animateParticles() {
      if (!particlesEnabled) return;
      pCtx.clearRect(0, 0, pCanvas.width, pCanvas.height);
      const isRunning = particleState === 'running';
      const speed = isRunning ? 3 : 1;
      const baseColor = isRunning ? [232, 163, 23] : (particleState === 'needs-attention' ? [76, 175, 80] : [${isDark ? '160, 160, 180' : '100, 100, 120'}]);

      for (const p of particles) {
        p.pulse += 0.02;
        p.x += p.vx * speed;
        p.y += p.vy * speed;
        const pulseAlpha = p.alpha + Math.sin(p.pulse) * 0.1;

        // Wrap around
        if (p.x < 0) p.x = pCanvas.width;
        if (p.x > pCanvas.width) p.x = 0;
        if (p.y < 0) p.y = pCanvas.height;
        if (p.y > pCanvas.height) p.y = 0;

        const glow = isRunning ? p.size * 3 : p.size * 1.5;
        pCtx.beginPath();
        pCtx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        pCtx.fillStyle = 'rgba(' + baseColor.join(',') + ',' + Math.max(0, pulseAlpha) + ')';
        pCtx.shadowColor = 'rgba(' + baseColor.join(',') + ',0.5)';
        pCtx.shadowBlur = glow;
        pCtx.fill();
        pCtx.shadowBlur = 0;
      }
      requestAnimationFrame(animateParticles);
    }
    animateParticles();

    // Sync particle state with terminal state
    const origUpdateState = updateState;
    updateState = function(state) {
      origUpdateState(state);
      particleState = state;
    };

    term.focus();

    // Signal extension that webview is ready to receive PTY output
    vscode.postMessage({ type: 'webview-ready' });
`;
}

module.exports = { getClientScript };
