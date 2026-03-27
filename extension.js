const vscode = require('vscode');
const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');

let statusBar = null;
let tabCounter = 0;
const panels = new Map();
let sessionTreeProvider = null;
let _context = null;
let isDeactivating = false;

const IDLE_DELAY_MS = 3000;

// ── Session Store (JSON file in workspace for cross-device sync) ──
const SESSION_STORE_DIR = '.claude-launcher';
const SESSION_STORE_FILE = 'sessions.json';

function getSessionStorePath() {
  const wsFolder = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath;
  if (!wsFolder) return null;
  return path.join(wsFolder, SESSION_STORE_DIR, SESSION_STORE_FILE);
}

function sessionStoreGet(key, defaultValue) {
  const filePath = getSessionStorePath();
  if (!filePath || !fs.existsSync(filePath)) return defaultValue;
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return data[key] !== undefined ? data[key] : defaultValue;
  } catch (_) {
    return defaultValue;
  }
}

function sessionStoreUpdate(key, value) {
  const filePath = getSessionStorePath();
  if (!filePath) return;
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  let data = {};
  if (fs.existsSync(filePath)) {
    try { data = JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch (_) {}
  }
  data[key] = value;
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

// ── Migrate from workspaceState to JSON file ──
function migrateFromWorkspaceState(context) {
  const filePath = getSessionStorePath();
  if (!filePath) return;
  // Skip if already migrated
  let existing = {};
  if (fs.existsSync(filePath)) {
    try { existing = JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch (_) {}
    if (existing._migrated) return;
  }
  const keys = ['claudeSessions', 'claudeSessionTitles', 'claudeSavedSessions', 'claudeSessionGroups', 'claudeArchivedSessions'];
  let migrated = false;
  for (const key of keys) {
    const val = context.workspaceState.get(key);
    if (val !== undefined && existing[key] === undefined) {
      sessionStoreUpdate(key, val);
      migrated = true;
    }
  }
  if (migrated) {
    sessionStoreUpdate('_migrated', true);
    console.log('[Claude Launcher] Migrated workspaceState to sessions.json');
  }
}

// ── i18n ──
const LOCALES = {
  en: {
    noActiveTab: 'No active Claude Code tab.',
    enterTabName: 'Enter tab name',
    resumeLaterGroup: 'Resume Later',
    recentSessionsGroup: 'Recent Sessions',
    resumeSession: 'Resume Session',
    nodePtyFail: 'Failed to load node-pty: ',
    startFail: 'Failed to start Claude Code: ',
    restartFail: 'Failed to restart Claude Code: ',
    suffixDone: ' [Done]',
    suffixError: ' [Error:{0}]',
    enterMemo: 'Enter tab memo',
    imageSaveFail: 'Failed to save image: ',
    fileNotFound: 'File not found: ',
    conversationSaved: 'Conversation saved: ',
    exportFail: 'Failed to export conversation: ',
    sbIdle: '$(hubot) Claude Idle',
    sbRunning: '$(loading~spin) Claude Running',
    sbAttention: '$(bell) Claude Needs Attention',
    sbDone: '$(check) Claude Done',
    sbError: '$(error) Claude Error',
    exportLabel: 'Export',
    sessionLabel: 'Session',
    sessionWelcome: 'No session history.\\n[Open New Session](command:claudeCodeLauncher.open)',
    // webview
    starting: 'Starting...',
    memoEditTip: 'Click to edit memo',
    ctxUsageTip: 'Context usage (click to refresh)',
    pasteImageTip: 'Paste clipboard image',
    zoomOutTip: 'Zoom out (Ctrl+-)',
    zoomInTip: 'Zoom in (Ctrl+=)',
    exportTip: 'Export conversation',
    soundToggleTip: 'Sound on/off',
    newTabTip: 'New tab',
    searchPlaceholder: 'Search...',
    searchPrevTip: 'Previous (Shift+Enter)',
    searchNextTip: 'Next (Enter)',
    searchCloseTip: 'Close (Escape)',
    processExited: 'Claude has exited.',
    restartBtn: 'Restart',
    dropFiles: 'Drop files here',
    scrollBottomTip: 'Scroll to bottom',
    themeTitle: 'Background Theme',
    themeDefault: 'Default', themeMidnight: 'Midnight', themeOcean: 'Ocean',
    themeForest: 'Forest', themeSunset: 'Sunset', themeAurora: 'Aurora', themeWarm: 'Warm',
    inputPlaceholder: 'Type a message... (Enter: Send / Shift+Enter: Newline / /: Command)',
    inputHint: 'Enter Send · Shift+Enter Newline · / Command',
    queueAdd: 'Queue', queueRun: 'Run Queue', send: 'Send',
    scTitle: 'Keyboard Shortcuts',
    scSearch: 'Search', scZoomIn: 'Zoom in', scZoomOut: 'Zoom out', scZoomReset: 'Reset zoom',
    scPasteImage: 'Paste image', scOpenFile: 'Open file', scHistory: 'Input history',
    scEditorToggle: 'Toggle input panel', scHelp: 'This help',
    scContextMenu: 'Context menu', scContextActions: 'Copy / Paste / Export / Memo / Sound',
    scClose: 'Press ESC or click anywhere to close',
    ctxCopy: 'Copy', ctxOpenFile: 'Open File', ctxSelectedText: 'Selection',
    ctxPaste: 'Paste', ctxPasteImage: 'Paste Image',
    ctxSearch: 'Search', ctxClear: 'Clear Screen', ctxExport: 'Export Conversation',
    ctxZoomIn: 'Zoom In', ctxZoomOut: 'Zoom Out', ctxZoomReset: 'Reset Zoom',
    ctxEditMemo: 'Edit Tab Memo', ctxChangeTheme: 'Background Theme',
    ctxParticlesOff: 'Particles Off', ctxParticlesOn: 'Particles On',
    ctxSoundOff: 'Sound Off', ctxSoundOn: 'Sound On',
    ctxCloseResume: 'Close (Resume Later)',
    selectTextFirst: 'Select text first',
    openFileToast: 'Open file: ',
    ctxQuerying: 'Querying context usage...',
    soundOnToast: 'Sound on', soundOffToast: 'Sound off',
    addMemo: '+ Memo', themeApplied: 'Theme: ',
    exportingToast: 'Exporting conversation...', exportDone: 'Export complete', exportFailToast: 'Export failed',
    imageDone: 'Image attached: ', imageFailToast: 'Image paste failed: ',
    ctxCompacted: 'Context auto-compacted',
    processErrorExit: 'Claude exited with error (code: {0})',
    processNormalExit: 'Claude has exited.',
    resumeRestart: 'Resume conversation', newStart: 'Start new',
    restartingToast: 'Restarting Claude...',
    stRunning: 'Processing...', stWaiting: 'Idle', stAttention: 'Needs attention',
    stDone: 'Done', stError: 'Error',
    queueRunning: 'Queue: ', queueDone: 'Queue done!',
    imagePasting: 'Pasting image...', copied: 'Copied',
    clipboardChecking: 'Checking clipboard for image...',
    particlesOnToast: 'Particles on', particlesOffToast: 'Particles off',
    // slash commands
    slashCompact: 'Compress conversation context', slashClear: 'Clear conversation',
    slashModel: 'Change model', slashCost: 'Check cost', slashHelp: 'Show help',
    slashMemory: 'Manage memory', slashConfig: 'View settings', slashReview: 'Code review',
    slashPrComments: 'Check PR comments', slashDoctor: 'Run diagnostics',
    slashInit: 'Initialize CLAUDE.md', slashLogin: 'Login', slashLogout: 'Logout',
    slashTerminalSetup: 'Terminal setup', slashContext: 'Context usage',
  },
  ko: {
    noActiveTab: '활성화된 Claude Code 탭이 없습니다.',
    enterTabName: '탭 이름을 입력하세요',
    resumeLaterGroup: '나중에 이어서',
    recentSessionsGroup: '최근 세션',
    resumeSession: '세션 이어하기',
    nodePtyFail: 'node-pty 로드 실패: ',
    startFail: 'Claude Code 시작 실패: ',
    restartFail: 'Claude Code 재시작 실패: ',
    suffixDone: ' [종료]',
    suffixError: ' [오류:{0}]',
    enterMemo: '탭 메모를 입력하세요',
    imageSaveFail: '이미지 저장 실패: ',
    fileNotFound: '파일을 찾을 수 없습니다: ',
    conversationSaved: '대화가 저장되었습니다: ',
    exportFail: '대화 내보내기 실패: ',
    sbIdle: '$(hubot) Claude 대기 중',
    sbRunning: '$(loading~spin) Claude 처리 중',
    sbAttention: '$(bell) Claude 확인 필요',
    sbDone: '$(check) Claude 종료',
    sbError: '$(error) Claude 오류',
    exportLabel: '내보내기',
    sessionLabel: '세션',
    sessionWelcome: '세션 기록이 없습니다.\\n[새 세션 열기](command:claudeCodeLauncher.open)',
    // webview
    starting: '시작 중...',
    memoEditTip: '클릭하여 메모 편집',
    ctxUsageTip: '컨텍스트 사용량 (클릭하여 새로고침)',
    pasteImageTip: '클립보드 이미지 붙여넣기',
    zoomOutTip: '글자 축소 (Ctrl+-)',
    zoomInTip: '글자 확대 (Ctrl+=)',
    exportTip: '대화 내보내기',
    soundToggleTip: '알림음 켜기/끄기',
    newTabTip: '새 탭',
    searchPlaceholder: '검색...',
    searchPrevTip: '이전 (Shift+Enter)',
    searchNextTip: '다음 (Enter)',
    searchCloseTip: '닫기 (Escape)',
    processExited: 'Claude가 종료되었습니다.',
    restartBtn: '재시작',
    dropFiles: '파일을 여기에 놓으세요',
    scrollBottomTip: '맨 아래로',
    themeTitle: '배경 테마',
    themeDefault: '기본', themeMidnight: '미드나이트', themeOcean: '오션',
    themeForest: '포레스트', themeSunset: '선셋', themeAurora: '오로라', themeWarm: '따뜻한',
    inputPlaceholder: '메시지를 입력하세요... (Enter: 전송 / Shift+Enter: 줄바꿈 / /: 명령어)',
    inputHint: 'Enter 전송 · Shift+Enter 줄바꿈 · / 명령어',
    queueAdd: 'Queue', queueRun: '순차 실행', send: '전송',
    scTitle: '키보드 단축키',
    scSearch: '검색', scZoomIn: '글자 확대', scZoomOut: '글자 축소', scZoomReset: '글자 초기화',
    scPasteImage: '이미지 붙여넣기', scOpenFile: '파일 열기', scHistory: '입력 히스토리',
    scEditorToggle: '입력 패널 토글', scHelp: '이 도움말',
    scContextMenu: '우클릭 메뉴', scContextActions: '복사 / 붙여넣기 / 내보내기 / 메모 / 알림음',
    scClose: 'ESC 또는 아무 곳 클릭하여 닫기',
    ctxCopy: '복사', ctxOpenFile: '파일 열기', ctxSelectedText: '선택 텍스트',
    ctxPaste: '붙여넣기', ctxPasteImage: '이미지 붙여넣기',
    ctxSearch: '검색', ctxClear: '화면 지우기', ctxExport: '대화 내보내기',
    ctxZoomIn: '글자 확대', ctxZoomOut: '글자 축소', ctxZoomReset: '글자 초기화',
    ctxEditMemo: '탭 메모 편집', ctxChangeTheme: '배경 테마',
    ctxParticlesOff: '입자 효과 끄기', ctxParticlesOn: '입자 효과 켜기',
    ctxSoundOff: '알림음 끄기', ctxSoundOn: '알림음 켜기',
    ctxCloseResume: '닫기 (나중에 이어서)',
    selectTextFirst: '텍스트를 먼저 선택하세요',
    openFileToast: '파일 열기: ',
    ctxQuerying: '컨텍스트 사용량 조회 중...',
    soundOnToast: '알림음 켜짐', soundOffToast: '알림음 꺼짐',
    addMemo: '+ 메모', themeApplied: '테마 적용: ',
    exportingToast: '대화 내보내기 중...', exportDone: '대화 내보내기 완료', exportFailToast: '내보내기 실패',
    imageDone: '이미지 첨부 완료: ', imageFailToast: '이미지 붙여넣기 실패: ',
    ctxCompacted: '컨텍스트 자동 압축됨',
    processErrorExit: 'Claude가 오류로 종료되었습니다 (코드: {0})',
    processNormalExit: 'Claude가 종료되었습니다.',
    resumeRestart: '대화 이어서 재시작', newStart: '새로 시작',
    restartingToast: 'Claude 재시작 중...',
    stRunning: '처리 중...', stWaiting: '대기 중', stAttention: '확인 필요',
    stDone: '종료', stError: '오류',
    queueRunning: '큐 실행 중: ', queueDone: '큐 완료!',
    imagePasting: '이미지 붙여넣는 중...', copied: '복사됨',
    clipboardChecking: '클립보드에서 이미지 확인 중...',
    particlesOnToast: '입자 효과 켜짐', particlesOffToast: '입자 효과 꺼짐',
    // slash commands
    slashCompact: '대화 컨텍스트 압축', slashClear: '대화 초기화',
    slashModel: '모델 변경', slashCost: '비용 확인', slashHelp: '도움말 보기',
    slashMemory: '메모리 관리', slashConfig: '설정 보기', slashReview: '코드 리뷰',
    slashPrComments: 'PR 코멘트 확인', slashDoctor: '진단 실행',
    slashInit: 'CLAUDE.md 초기 설정', slashLogin: '로그인', slashLogout: '로그아웃',
    slashTerminalSetup: '터미널 설정', slashContext: '컨텍스트 사용량',
  }
};

function getLocale() {
  const lang = vscode.env.language || 'en';
  return lang.startsWith('ko') ? 'ko' : 'en';
}

function t(key) {
  const locale = getLocale();
  return LOCALES[locale]?.[key] || LOCALES.en[key] || key;
}

function activate(context) {
  _context = context;
  isDeactivating = false;
  const extensionPath = context.extensionPath;

  // Migrate legacy workspaceState data to JSON file
  migrateFromWorkspaceState(context);

  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.command = 'claudeCodeLauncher.open';
  setStatusBar('idle');
  statusBar.show();
  context.subscriptions.push(statusBar);

  context.subscriptions.push(
    vscode.commands.registerCommand('claudeCodeLauncher.open', () => {
      createPanel(context, extensionPath, null);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('claudeCodeLauncher.renameTab', async () => {
      let activeEntry = null;
      for (const [, entry] of panels) {
        if (entry.panel.active) { activeEntry = entry; break; }
      }
      if (!activeEntry) {
        vscode.window.showWarningMessage(t('noActiveTab'));
        return;
      }
      const newName = await vscode.window.showInputBox({
        prompt: t('enterTabName'),
        value: activeEntry.title
      });
      if (newName) {
        activeEntry.title = newName;
        activeEntry.panel.title = newName;
        saveSessions(context);
      }
    })
  );

  // Session tree view
  sessionTreeProvider = new SessionTreeDataProvider(context);
  const treeView = vscode.window.createTreeView('claudeCodeLauncher.sessionList', {
    treeDataProvider: sessionTreeProvider
  });
  context.subscriptions.push(treeView);

  // Track expanded groups
  treeView.onDidExpandElement(e => {
    if (e.element.label) sessionTreeProvider._expandedGroups.add(String(e.element.label).replace(/\s*\(\d+\)$/, ''));
  });
  treeView.onDidCollapseElement(e => {
    if (e.element.label) sessionTreeProvider._expandedGroups.delete(String(e.element.label).replace(/\s*\(\d+\)$/, ''));
  });

  context.subscriptions.push(
    vscode.commands.registerCommand('claudeCodeLauncher.refreshSessions', () => {
      sessionTreeProvider.refresh();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('claudeCodeLauncher.resumeSession', (sessionId) => {
      const titleMap = sessionStoreGet('claudeSessionTitles', {});
      const title = titleMap[sessionId] || undefined;
      // Remove from saved sessions list when resuming
      const saved = sessionStoreGet('claudeSavedSessions', []);
      const filtered = saved.filter(s => s.sessionId !== sessionId);
      if (filtered.length !== saved.length) {
        sessionStoreUpdate('claudeSavedSessions', filtered);
      }
      createPanel(context, extensionPath, { sessionId, title });
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('claudeCodeLauncher.moveToGroup', async (item) => {
      const sessionId = item?._sessionId;
      if (!sessionId) return;
      const groups = sessionStoreGet('claudeSessionGroups', {});
      const groupNames = Object.keys(groups);
      const picks = [...groupNames, '$(add) New Group...', '$(close) Remove from Group'];
      const choice = await vscode.window.showQuickPick(picks, { placeHolder: 'Move session to group...' });
      if (!choice) return;
      // Remove from all existing groups first
      for (const g of Object.keys(groups)) {
        groups[g] = groups[g].filter(id => id !== sessionId);
        if (groups[g].length === 0) delete groups[g];
      }
      // Also remove from legacy saved/archived
      const saved = sessionStoreGet('claudeSavedSessions', []);
      sessionStoreUpdate('claudeSavedSessions', saved.filter(s => s.sessionId !== sessionId));
      const archived = sessionStoreGet('claudeArchivedSessions', []);
      sessionStoreUpdate('claudeArchivedSessions', archived.filter(s => s.sessionId !== sessionId));
      if (choice === '$(close) Remove from Group') {
        // Just remove, already done above
      } else if (choice === '$(add) New Group...') {
        const name = await vscode.window.showInputBox({ prompt: 'Group name' });
        if (name) {
          if (!groups[name]) groups[name] = [];
          groups[name].push(sessionId);
        }
      } else {
        if (!groups[choice]) groups[choice] = [];
        groups[choice].push(sessionId);
      }
      sessionStoreUpdate('claudeSessionGroups', groups);
      if (sessionTreeProvider) sessionTreeProvider.refresh();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('claudeCodeLauncher.deleteGroup', async (item) => {
      const groups = sessionStoreGet('claudeSessionGroups', {});
      const choice = item?._groupName;
      if (!choice || !groups[choice]) return;
      delete groups[choice];
      sessionStoreUpdate('claudeSessionGroups', groups);
      if (sessionTreeProvider) sessionTreeProvider.refresh();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('claudeCodeLauncher.renameGroup', async (item) => {
      const groups = sessionStoreGet('claudeSessionGroups', {});
      const choice = item?._groupName;
      if (!choice || !groups[choice]) return;
      const newName = await vscode.window.showInputBox({ prompt: 'New group name', value: choice });
      if (!newName || newName === choice) return;
      groups[newName] = groups[choice];
      delete groups[choice];
      // Update expanded state
      if (sessionTreeProvider._expandedGroups.has(choice)) {
        sessionTreeProvider._expandedGroups.delete(choice);
        sessionTreeProvider._expandedGroups.add(newName);
      }
      sessionStoreUpdate('claudeSessionGroups', groups);
      if (sessionTreeProvider) sessionTreeProvider.refresh();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('claudeCodeLauncher.renameGroup', async (item) => {
      const groups = context.workspaceState.get('claudeSessionGroups', {});
      const choice = item?._groupName;
      if (!choice || !groups[choice]) return;
      const newName = await vscode.window.showInputBox({ prompt: 'New group name', value: choice });
      if (!newName || newName === choice) return;
      groups[newName] = groups[choice];
      delete groups[choice];
      // Update expanded state
      if (sessionTreeProvider._expandedGroups.has(choice)) {
        sessionTreeProvider._expandedGroups.delete(choice);
        sessionTreeProvider._expandedGroups.add(newName);
      }
      context.workspaceState.update('claudeSessionGroups', groups);
      if (sessionTreeProvider) sessionTreeProvider.refresh();
    })
  );

  // Trash: delete session (move .jsonl to trash/)
  context.subscriptions.push(
    vscode.commands.registerCommand('claudeCodeLauncher.trashSession', async (item) => {
      const sessionId = item?._sessionId;
      if (!sessionId) return;
      const projDir = sessionTreeProvider._getProjectDir();
      if (!projDir) return;
      const src = path.join(projDir, sessionId + '.jsonl');
      if (!fs.existsSync(src)) return;
      const trashDir = path.join(projDir, 'trash');
      if (!fs.existsSync(trashDir)) fs.mkdirSync(trashDir, { recursive: true });
      fs.renameSync(src, path.join(trashDir, sessionId + '.jsonl'));
      // Remove from all groups
      const groups = sessionStoreGet('claudeSessionGroups', {});
      for (const g of Object.keys(groups)) {
        groups[g] = groups[g].filter(id => id !== sessionId);
        if (groups[g].length === 0) delete groups[g];
      }
      sessionStoreUpdate('claudeSessionGroups', groups);
      const saved = sessionStoreGet('claudeSavedSessions', []);
      sessionStoreUpdate('claudeSavedSessions', saved.filter(s => s.sessionId !== sessionId));
      if (sessionTreeProvider) sessionTreeProvider.refresh();
    })
  );

  // Trash: restore session
  context.subscriptions.push(
    vscode.commands.registerCommand('claudeCodeLauncher.restoreSession', async (item) => {
      const sessionId = item?._sessionId;
      if (!sessionId) return;
      const projDir = sessionTreeProvider._getProjectDir();
      if (!projDir) return;
      const trashDir = path.join(projDir, 'trash');
      const src = path.join(trashDir, sessionId + '.jsonl');
      if (!fs.existsSync(src)) return;
      fs.renameSync(src, path.join(projDir, sessionId + '.jsonl'));
      if (sessionTreeProvider) sessionTreeProvider.refresh();
    })
  );

  // Trash: empty all
  context.subscriptions.push(
    vscode.commands.registerCommand('claudeCodeLauncher.emptyTrash', async () => {
      const projDir = sessionTreeProvider._getProjectDir();
      if (!projDir) return;
      const trashDir = path.join(projDir, 'trash');
      if (!fs.existsSync(trashDir)) return;
      const files = fs.readdirSync(trashDir).filter(f => f.endsWith('.jsonl'));
      if (files.length === 0) return;
      const confirm = await vscode.window.showWarningMessage(
        `Delete ${files.length} session(s) permanently?`, { modal: true }, 'Delete'
      );
      if (confirm === 'Delete') {
        for (const f of files) fs.unlinkSync(path.join(trashDir, f));
        if (sessionTreeProvider) sessionTreeProvider.refresh();
      }
    })
  );

  // Restore previous sessions
  restoreSessions(context, extensionPath);
}

// ── Session tree view ──

class SessionTreeDataProvider {
  constructor(context) {
    this._context = context;
    this._onDidChangeTreeData = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChangeTreeData.event;
    this._cache = null;
    this._expandedGroups = new Set([t('resumeLaterGroup')]);
  }

  refresh() {
    this._cache = null;
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element) {
    return element;
  }

  getChildren(element) {
    if (!element) {
      // Root level: return groups
      if (this._cache) return this._cache;
      this._cache = this._buildGroups();
      return this._cache;
    }
    // Child level: return items stored in the group
    return element._children || [];
  }

  _getProjectDir() {
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath;
    if (!cwd) return null;
    const projectsDir = path.join(os.homedir(), '.claude', 'projects');
    if (!fs.existsSync(projectsDir)) return null;
    // Replace all non-alphanumeric chars with - (matches Claude CLI behavior)
    const dirName = cwd.replace(/[^a-zA-Z0-9]/g, '-');
    const projDir = path.join(projectsDir, dirName);
    if (fs.existsSync(projDir)) return projDir;
    // Fallback: find folder containing the workspace basename
    try {
      const wsName = path.basename(cwd).replace(/[^a-zA-Z0-9]/g, '-').toLowerCase();
      const dirs = fs.readdirSync(projectsDir);
      // 1. Exact match (case-insensitive)
      const exact = dirs.find(d => d.toLowerCase() === dirName.toLowerCase());
      if (exact) return path.join(projectsDir, exact);
      // 2. Basename match
      const partial = dirs.find(d => d.toLowerCase().includes(wsName));
      if (partial) return path.join(projectsDir, partial);
    } catch (_) {}
    return null;
  }

  _buildGroups() {
    const projDir = this._getProjectDir();
    console.log('[Session] _getProjectDir:', projDir);
    const customGroups = sessionStoreGet('claudeSessionGroups', {});
    // Also support legacy saved sessions
    const savedSessions = sessionStoreGet('claudeSavedSessions', []);
    const allItems = this._loadSessions();

    // Build set of all grouped session IDs
    const groupedSet = new Set();
    for (const ids of Object.values(customGroups)) {
      for (const id of ids) groupedSet.add(id);
    }
    for (const s of savedSessions) groupedSet.add(s.sessionId);

    // Map sessionId → item
    const itemMap = new Map();
    for (const item of allItems) itemMap.set(item._sessionId, item);

    const groups = [];

    const exp = this._expandedGroups;
    const state = (name) => exp.has(name) ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed;

    // Legacy "Resume Later" group (from close-resume)
    const rlName = t('resumeLaterGroup');
    const savedItems = savedSessions.map(s => itemMap.get(s.sessionId)).filter(Boolean);
    if (savedItems.length > 0) {
      const savedGroup = new vscode.TreeItem(`${rlName} (${savedItems.length})`, state(rlName));
      savedGroup.iconPath = new vscode.ThemeIcon('pin');
      savedGroup._children = savedItems;
      groups.push(savedGroup);
    }

    // Custom groups
    for (const [name, ids] of Object.entries(customGroups)) {
      const items = ids.map(id => itemMap.get(id)).filter(Boolean);
      if (items.length === 0) continue;
      for (const item of items) {
        item.iconPath = new vscode.ThemeIcon('folder');
      }
      const group = new vscode.TreeItem(`${name} (${items.length})`, state(name));
      group.iconPath = new vscode.ThemeIcon('folder');
      group.contextValue = 'customGroup';
      group._groupName = name;
      group._children = items;
      groups.push(group);
    }

    // Recent Sessions (ungrouped)
    const rsName = t('recentSessionsGroup');
    const recentItems = allItems.filter(item => !groupedSet.has(item._sessionId));
    if (recentItems.length > 0) {
      const recentGroup = new vscode.TreeItem(`${rsName} (${recentItems.length})`, state(rsName));
      recentGroup.iconPath = new vscode.ThemeIcon('history');
      recentGroup._children = recentItems;
      groups.push(recentGroup);
    }

    // Trash group
    if (projDir) {
      const trashDir = path.join(projDir, 'trash');
      if (fs.existsSync(trashDir)) {
        const trashFiles = fs.readdirSync(trashDir).filter(f => f.endsWith('.jsonl'));
        if (trashFiles.length > 0) {
          const titleMap = sessionStoreGet('claudeSessionTitles', {});
          const trashItems = [];
          for (const f of trashFiles) {
            const sid = f.replace('.jsonl', '');
            const fullPath = path.join(trashDir, f);
            const mtime = fs.statSync(fullPath).mtimeMs;
            const date = new Date(mtime);
            const dateStr = `${String(date.getMonth() + 1).padStart(2, '0')}/${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
            const savedTitle = titleMap[sid];
            const firstMsg = this._extractFirstUserMessage(fullPath);
            if (!savedTitle && !firstMsg) continue;
            const displayText = savedTitle || firstMsg;
            const label = displayText.length > 40 ? displayText.substring(0, 40) + '...' : displayText;
            const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
            item.description = dateStr;
            item.iconPath = new vscode.ThemeIcon('trash');
            item.contextValue = 'trashed';
            item._sessionId = sid;
            item.command = { command: 'claudeCodeLauncher.resumeSession', title: 'Resume', arguments: [sid] };
            trashItems.push(item);
          }
          if (trashItems.length > 0) {
            const trashGroup = new vscode.TreeItem(`Trash (${trashItems.length})`, state('Trash'));
            trashGroup.iconPath = new vscode.ThemeIcon('trash');
            trashGroup.contextValue = 'trashGroup';
            trashGroup._children = trashItems;
            groups.push(trashGroup);
          }
        }
      }
    }

    return groups;
  }

  _loadSessions() {
    const projDir = this._getProjectDir();
    if (!projDir) return [];

    let files;
    try {
      files = fs.readdirSync(projDir)
        .filter(f => f.endsWith('.jsonl'))
        .map(f => {
          const fullPath = path.join(projDir, f);
          return { name: f, path: fullPath, mtime: fs.statSync(fullPath).mtimeMs };
        })
        .sort((a, b) => b.mtime - a.mtime)
        .slice(0, 30);
    } catch {
      return [];
    }

    const titleMap = sessionStoreGet('claudeSessionTitles', {});

    const items = [];
    for (const file of files) {
      const sessionId = file.name.replace('.jsonl', '');
      const savedTitle = titleMap[sessionId];
      const firstMsg = this._extractFirstUserMessage(file.path);
      if (!savedTitle && !firstMsg) continue;

      const date = new Date(file.mtime);
      const dateStr = `${String(date.getMonth() + 1).padStart(2, '0')}/${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;

      const displayText = savedTitle || firstMsg;
      const label = displayText.length > 40 ? displayText.substring(0, 40) + '...' : displayText;

      const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
      item.description = dateStr;
      item.tooltip = `${savedTitle ? savedTitle + '\n\n' : ''}${firstMsg || ''}\n\nSession: ${sessionId}\n${date.toLocaleString()}`;
      item.iconPath = new vscode.ThemeIcon(savedTitle ? 'bookmark' : 'comment-discussion');
      item.command = {
        command: 'claudeCodeLauncher.resumeSession',
        title: t('resumeSession'),
        arguments: [sessionId]
      };
      item._sessionId = sessionId;
      items.push(item);
    }
    return items;
  }

  _extractFirstUserMessage(filePath) {
    try {
      const fd = fs.openSync(filePath, 'r');
      const buf = Buffer.alloc(32768);
      const bytesRead = fs.readSync(fd, buf, 0, 32768, 0);
      fs.closeSync(fd);
      const chunk = buf.toString('utf-8', 0, bytesRead);
      const lines = chunk.split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const d = JSON.parse(line);
          if (d.type !== 'user') continue;
          const msg = d.message;
          if (!msg || msg.role !== 'user') continue;
          let text = '';
          if (typeof msg.content === 'string') {
            text = msg.content;
          } else if (Array.isArray(msg.content)) {
            for (const c of msg.content) {
              if (c.type === 'text' && c.text) {
                text = c.text;
                break;
              }
            }
          }
          text = text.replace(/<[^>]+>/g, '').trim().split('\n')[0].trim();
          if (text) return text;
        } catch {}
      }
    } catch {}
    return null;
  }
}

// ── Session persistence ──

function saveSessions(context) {
  const sessions = [];
  let order = 0;
  for (const [, entry] of panels) {
    if (entry.pty) {
      sessions.push({
        title: entry.title,
        memo: entry.memo || '',
        cwd: entry.cwd,
        sessionId: entry.sessionId,
        order: order++,
        viewColumn: entry.panel.viewColumn || 1
      });
    }
  }
  sessionStoreUpdate('claudeSessions', sessions);

  // sessionId → title 매핑 저장 (사이드바 세션 목록용)
  const titleMap = sessionStoreGet('claudeSessionTitles', {});
  for (const s of sessions) {
    if (s.sessionId && s.title) {
      // 기본 탭 이름(Claude Code, Claude Code (N))이면 저장하지 않음
      if (/^Claude Code( \(\d+\))?$/.test(s.title)) {
        // 기본 이름이면 기존 매핑 제거하지 않음 (이전에 지정된 이름 유지)
        continue;
      }
      titleMap[s.sessionId] = s.title;
    }
  }
  sessionStoreUpdate('claudeSessionTitles', titleMap);
  if (sessionTreeProvider) sessionTreeProvider.refresh();
}

function restoreSessions(context, extensionPath) {
  const sessions = sessionStoreGet('claudeSessions', []);
  if (sessions.length === 0) return;

  // Clear saved sessions immediately to avoid double-restore
  sessionStoreUpdate('claudeSessions', []);

  // Restore in saved order with delay between panels for proper column placement
  const sorted = [...sessions].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  sorted.forEach((session, i) => {
    setTimeout(() => {
      createPanel(context, extensionPath, session);
    }, i * 500);
  });
}

// ── Claude CLI resolution ──

function resolveClaudeCli() {
  const isWin = process.platform === 'win32';
  // 1) ~/.local/bin/claude(.exe) — official standalone install
  const localBin = isWin
    ? path.join(os.homedir(), '.local', 'bin', 'claude.exe')
    : path.join(os.homedir(), '.local', 'bin', 'claude');
  if (fs.existsSync(localBin)) return { shell: localBin, args: [] };

  // 2) npm global install — Windows needs cmd.exe /c wrapper for .cmd shims
  if (isWin) {
    const npmCli = path.join(process.env.APPDATA || '', 'npm', 'claude.cmd');
    if (fs.existsSync(npmCli)) return { shell: 'cmd.exe', args: ['/c', 'claude'] };
  }

  // 3) Fallback — hope it's on PATH (works on macOS/Linux where shell scripts are directly executable)
  try {
    require('child_process').execSync('claude --version', { timeout: 3000, stdio: 'ignore' });
    return { shell: 'claude', args: [] };
  } catch (_) {
    return null;
  }
}

// ── Panel creation ──

function createPanel(context, extensionPath, session) {
  let pty;
  try {
    pty = require('node-pty');
  } catch (e) {
    vscode.window.showErrorMessage(t('nodePtyFail') + e.message);
    return;
  }

  tabCounter++;
  const tabId = tabCounter;
  const tabTitle = session?.title || (tabCounter === 1 ? 'Claude Code' : `Claude Code (${tabCounter})`);

  const panel = vscode.window.createWebviewPanel(
    'claudeCode',
    tabTitle,
    { viewColumn: session?.viewColumn || vscode.ViewColumn.One, preserveFocus: !!session },
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [
        vscode.Uri.file(path.join(extensionPath, 'node_modules')),
        vscode.Uri.file(path.join(extensionPath, 'icons'))
      ]
    }
  );

  setTabIcon(panel, 'running', extensionPath);
  setStatusBar('running');

  const config = vscode.workspace.getConfiguration('claudeCodeLauncher');
  const fontSize = config.get('defaultFontSize', 11);
  const fontFamily = config.get('defaultFontFamily', '"D2Coding", "D2Coding ligature", Consolas, monospace');
  const defaultTheme = config.get('defaultTheme', 'default');
  const soundEnabled = config.get('soundEnabled', true);
  const particlesEnabled = config.get('particlesEnabled', true);

  const xtermCssUri = panel.webview.asWebviewUri(
    vscode.Uri.file(path.join(extensionPath, 'node_modules', 'xterm', 'css', 'xterm.css'))
  );
  const xtermJsUri = panel.webview.asWebviewUri(
    vscode.Uri.file(path.join(extensionPath, 'node_modules', 'xterm', 'lib', 'xterm.js'))
  );
  const fitAddonUri = panel.webview.asWebviewUri(
    vscode.Uri.file(path.join(extensionPath, 'node_modules', 'xterm-addon-fit', 'lib', 'xterm-addon-fit.js'))
  );
  const webLinksAddonUri = panel.webview.asWebviewUri(
    vscode.Uri.file(path.join(extensionPath, 'node_modules', 'xterm-addon-web-links', 'lib', 'xterm-addon-web-links.js'))
  );
  const searchAddonUri = panel.webview.asWebviewUri(
    vscode.Uri.file(path.join(extensionPath, 'node_modules', 'xterm-addon-search', 'lib', 'xterm-addon-search.js'))
  );

  const isDark = vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Dark
    || vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.HighContrast;

  const initialMemo = session?.memo || '';
  const customButtons = config.get('customButtons', []);
  const customSlashCommands = config.get('customSlashCommands', []);
  const locale = getLocale();
  const T = LOCALES[locale] || LOCALES.en;
  const settings = { fontFamily, defaultTheme, soundEnabled, particlesEnabled };
  panel.webview.html = getWebviewContent(xtermCssUri, xtermJsUri, fitAddonUri, webLinksAddonUri, searchAddonUri, isDark, fontSize, tabTitle, initialMemo, customButtons, T, settings, customSlashCommands);

  // Spawn claude CLI
  const cwd = session?.cwd || vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath || os.homedir();
  const sessionId = session?.sessionId || crypto.randomUUID();
  const resolved = resolveClaudeCli();
  if (!resolved) {
    const install = 'Install Claude Code';
    vscode.window.showErrorMessage(
      'Claude Code CLI not found. Please install it first: npm install -g @anthropic-ai/claude-code',
      install
    ).then(choice => {
      if (choice === install) {
        vscode.env.openExternal(vscode.Uri.parse('https://docs.anthropic.com/en/docs/claude-code/overview'));
      }
    });
    panel.dispose();
    return;
  }

  const shell = resolved.shell;
  const claudeArgs = session?.sessionId
    ? ['--resume', session.sessionId]
    : ['--session-id', sessionId];
  const args = [...resolved.args, ...claudeArgs];

  console.log('[Claude Launcher] Spawning:', shell, args.join(' '), '| cwd:', cwd);
  console.log('[Claude Launcher] resolved shell:', shell, '| args prefix:', resolved.args);

  let ptyProcess;
  try {
    ptyProcess = pty.spawn(shell, args, {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      cwd: cwd,
      env: { ...process.env, FORCE_COLOR: '1' }
    });
    console.log('[Claude Launcher] PTY spawned OK, pid:', ptyProcess.pid);
  } catch (e) {
    console.error('[Claude Launcher] PTY spawn FAILED:', e.message, e.stack);
    if (e.message && e.message.includes('posix_spawnp')) {
      const fix = 'Run npm rebuild';
      vscode.window.showErrorMessage(
        t('startFail') + 'node-pty native module incompatible. Run: cd ' + extensionPath + ' && npm rebuild node-pty',
        fix
      ).then(choice => {
        if (choice === fix) {
          const terminal = vscode.window.createTerminal('Fix node-pty');
          terminal.sendText('cd "' + extensionPath + '" && npm rebuild node-pty');
          terminal.show();
        }
      });
    } else {
      vscode.window.showErrorMessage(t('startFail') + e.message);
    }
    panel.dispose();
    return;
  }

  const entry = {
    panel,
    pty: ptyProcess,
    title: tabTitle,
    memo: session?.memo || '',
    cwd: cwd,
    sessionId: sessionId,
    state: 'running',
    idleTimer: null
  };
  panels.set(tabId, entry);
  saveSessions(context);

  // PTY → Webview + activity detection
  let runningDelayTimer = null;
  let dataCount = 0;
  // context parsing — rolling buffer for cross-chunk patterns
  let ctxBuf = '';
  let webviewReady = false;
  const outputBuffer = [];

  ptyProcess.onData(data => {
    dataCount++;
    if (dataCount <= 3) console.log('[Claude Launcher] PTY data #' + dataCount + ' (' + data.length + ' bytes):', data.substring(0, 100));
    if (!webviewReady) {
      outputBuffer.push(data);
    } else {
      try {
        panel.webview.postMessage({ type: 'output', data: data });
      } catch (_) {}
    }

    // Parse context/token usage from PTY output
    // Immediate check on each PTY chunk
    const strippedNow = data.replace(/\x1b\[[0-9;:?]*[A-Za-z~@`]/g, '').replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '').replace(/\x1b./g, '').replace(/[\x00-\x1f\x7f]/g, '');
    ctxBuf = (ctxBuf + strippedNow).slice(-300);
    if (!entry._ctxSampled && /(?:컨텍스트|context)/i.test(strippedNow)) {
      console.log('[Claude Launcher] ctxBuf:', JSON.stringify(ctxBuf.slice(-200)));
      entry._ctxSampled = true;
    }
    // 1. Prompt status line: "ctx:52%" (most reliable, appears after every response)
    const ctxPctMatch = ctxBuf.match(/ctx:(\d+)%/);
    if (ctxPctMatch) {
      const pct = parseInt(ctxPctMatch[1]);
      // Extract total from context model info (e.g., "1M context")
      const modelMatch = ctxBuf.match(/(\d+(?:\.\d+)?)(M|k)\s*context/i);
      let totalK = entry._ctxTotal || 1000;
      if (modelMatch) totalK = modelMatch[2].toUpperCase() === 'M' ? parseFloat(modelMatch[1]) * 1000 : parseFloat(modelMatch[1]);
      const usedK = Math.round(totalK * pct / 100);
      entry._ctxUsed = usedK;
      entry._ctxTotal = totalK;
      try {
        panel.webview.postMessage({ type: 'context-usage', used: usedK + 'k', total: totalK + 'k', pct });
      } catch (_) {}
    }
    // 1.5. Progress bar: [████░░░░░░] 40% or 컨텍스트 [░░░░░░░░░░] 6%
    if (!ctxPctMatch) {
      const barMatch = ctxBuf.match(/\[[^\]\n]{2,}\]\s*(\d+)\s*%/);
      if (barMatch) {
        const pct = parseInt(barMatch[1]);
        const modelMatch = ctxBuf.match(/(\d+(?:\.\d+)?)(M|k)\s*context/i);
        let totalK = entry._ctxTotal || 1000;
        if (modelMatch) totalK = modelMatch[2].toUpperCase() === 'M' ? parseFloat(modelMatch[1]) * 1000 : parseFloat(modelMatch[1]);
        const usedK = Math.round(totalK * pct / 100);
        entry._ctxUsed = usedK;
        entry._ctxTotal = totalK;
        try {
          panel.webview.postMessage({ type: 'context-usage', used: usedK + 'k', total: totalK + 'k', pct });
        } catch (_) {}
      }
      // 1.6. Keyword fallback: "컨텍스트 ... N%" or "context ... N%" without bar
      if (!barMatch) {
        const kwMatch = ctxBuf.match(/(?:컨텍스트|context[eo]?|kontext|コンテキスト|上下文|kontekst|kontextu?|contexte):?\s+.*?(\d+)\s*%/i);
        if (kwMatch) {
          const pct = parseInt(kwMatch[1]);
          if (pct <= 100) {
            const modelMatch = ctxBuf.match(/(\d+(?:\.\d+)?)(M|k)\s*context/i);
            let totalK = entry._ctxTotal || 1000;
            if (modelMatch) totalK = modelMatch[2].toUpperCase() === 'M' ? parseFloat(modelMatch[1]) * 1000 : parseFloat(modelMatch[1]);
            const usedK = Math.round(totalK * pct / 100);
            entry._ctxUsed = usedK;
            entry._ctxTotal = totalK;
            try {
              panel.webview.postMessage({ type: 'context-usage', used: usedK + 'k', total: totalK + 'k', pct });
            } catch (_) {}
          }
        }
        // 1.7. Broad fallback: N% near context keywords (ignores formatting artifacts)
        if (!kwMatch) {
          const broad = ctxBuf.match(/(?:컨텍스트|context|ctx)\S*[\s\S]{0,50}?(\d{1,3})\s*%/i);
          if (broad && parseInt(broad[1]) > 0 && parseInt(broad[1]) <= 100) {
            const pct = parseInt(broad[1]);
            const modelMatch = ctxBuf.match(/(\d+(?:\.\d+)?)(M|k)\s*context/i);
            let totalK = entry._ctxTotal || 1000;
            if (modelMatch) totalK = modelMatch[2].toUpperCase() === 'M' ? parseFloat(modelMatch[1]) * 1000 : parseFloat(modelMatch[1]);
            const usedK = Math.round(totalK * pct / 100);
            entry._ctxUsed = usedK;
            entry._ctxTotal = totalK;
            try {
              panel.webview.postMessage({ type: 'context-usage', used: usedK + 'k', total: totalK + 'k', pct });
            } catch (_) {}
          }
        }
      }
    }
    // 2. Full context from /context command: "300k/1000k"
    if (!ctxPctMatch) {
      const immediateMatch = ctxBuf.match(/(\d+(?:\.\d+)?k?)\/(\d+(?:\.\d+)?k)/);
      if (immediateMatch) {
        const used = immediateMatch[1];
        const total = immediateMatch[2];
        const usedNum = parseFloat(used) * (used.endsWith('k') ? 1 : 0.001);
        const totalNum = parseFloat(total) * (total.endsWith('k') ? 1 : 0.001);
        if (totalNum >= 100) {
          const pct = totalNum > 0 ? Math.round(usedNum / totalNum * 100) : 0;
          entry._ctxUsed = usedNum;
          entry._ctxTotal = totalNum;
          try {
            panel.webview.postMessage({ type: 'context-usage', used, total, pct });
          } catch (_) {}
        }
      }
    }
    // 3. Delta during response: "± 1.6k tokens" (fallback)
    const deltaMatch = strippedNow.match(/[±+]\s*(\d+(?:\.\d+)?)\s*(k)?\s*token/i);
    if (deltaMatch && entry._ctxTotal > 0 && !ctxPctMatch) {
      const num = parseFloat(deltaMatch[1]);
      const delta = (deltaMatch[2] ? num : num / 1000) * 2; // x2 보정 (누락 보상)
      entry._ctxUsed = (entry._ctxUsed || 0) + delta;
      const used = entry._ctxUsed >= 10 ? Math.round(entry._ctxUsed) + 'k' : entry._ctxUsed.toFixed(1) + 'k';
      const total = Math.round(entry._ctxTotal) + 'k';
      const pct = entry._ctxTotal > 0 ? Math.round(entry._ctxUsed / entry._ctxTotal * 100) : 0;
      try {
        panel.webview.postMessage({ type: 'context-usage', used, total, pct });
      } catch (_) {}
    }

    // Only transition to 'running' if output persists for 3s+
    if (entry.state !== 'running' && entry.state !== 'done' && entry.state !== 'error') {
      if (!runningDelayTimer) {
        runningDelayTimer = setTimeout(() => {
          if (entry.state !== 'running' && entry.state !== 'done' && entry.state !== 'error') {
            entry.state = 'running';
            entry.runningStartedAt = Date.now();
            setTabIcon(panel, 'running', extensionPath);
            panel.webview.postMessage({ type: 'state', state: 'running' });
            updateStatusBar();
          }
          runningDelayTimer = null;
        }, IDLE_DELAY_MS);
      }
    }

    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    entry.idleTimer = setTimeout(() => {
      if (runningDelayTimer) { clearTimeout(runningDelayTimer); runningDelayTimer = null; }
      if (!entry.pty || entry.state === 'done' || entry.state === 'error') return;

      // Brief outputs (< 3s, never reached 'running') stay as-is
      if (entry.state !== 'running') return;

      // Check how long running lasted
      const runningDuration = Date.now() - entry.runningStartedAt;

      if (runningDuration >= 7000) {
        // 10s+ total (3s delay + 7s running) → 완료 표시
        entry.state = 'needs-attention';
        setTabIcon(panel, 'done', extensionPath);
        panel.webview.postMessage({ type: 'state', state: 'needs-attention' });
        // Windows native toast notification
        showDesktopNotification(entry.title);
        if (!panel.active) {
          panel.webview.postMessage({ type: 'notify' });
        }
      } else {
        // 3~10s → 대기로 복귀
        entry.state = 'waiting';
        setTabIcon(panel, 'idle', extensionPath);
        panel.webview.postMessage({ type: 'state', state: 'waiting' });
      }
      updateStatusBar();
      // Refresh session list (picks up newly created .jsonl files)
      if (sessionTreeProvider) sessionTreeProvider.refresh();
    }, IDLE_DELAY_MS);
  });

  // Tab focus → acknowledge + save viewColumn on move
  let lastViewColumn = panel.viewColumn;
  panel.onDidChangeViewState(e => {
    if (e.webviewPanel.active && entry.state === 'needs-attention') {
      entry.state = 'waiting';
      setTabIcon(panel, 'idle', extensionPath);
      panel.webview.postMessage({ type: 'state', state: 'waiting' });
      updateStatusBar();
    }
    // Save when panel moves to different column
    if (panel.viewColumn !== lastViewColumn) {
      lastViewColumn = panel.viewColumn;
      saveSessions(context);
    }
  }, undefined, context.subscriptions);

  // PTY exit
  ptyProcess.onExit(({ exitCode }) => {
    console.log('[Claude Launcher] PTY exited, code:', exitCode, '| dataCount:', dataCount);
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    const isSuccess = exitCode === 0 || exitCode === null || exitCode === undefined;

    if (isSuccess) {
      entry.state = 'done';
      setTabIcon(panel, 'done', extensionPath);
      panel.title = entry.title + t('suffixDone');
      panel.webview.postMessage({ type: 'state', state: 'done' });
    } else {
      entry.state = 'error';
      setTabIcon(panel, 'error', extensionPath);
      panel.title = entry.title + t('suffixError').replace('{0}', exitCode);
      panel.webview.postMessage({ type: 'state', state: 'error' });
    }

    entry.pty = null;
    saveSessions(context);
    updateStatusBar();
    // Offer restart
    panel.webview.postMessage({ type: 'process-exited', exitCode: exitCode, canResume: !!entry.sessionId });
  });

  // Webview → Extension
  panel.webview.onDidReceiveMessage(msg => {
    if (msg.type === 'webview-ready') {
      webviewReady = true;
      console.log('[Claude Launcher] Webview ready, flushing', outputBuffer.length, 'buffered chunks');
      for (const chunk of outputBuffer) {
        try { panel.webview.postMessage({ type: 'output', data: chunk }); } catch (_) {}
      }
      outputBuffer.length = 0;
      return;
    }
    if (msg.type === 'input' && entry.pty) {
      entry.pty.write(msg.data);
    }
    if (msg.type === 'resize' && entry.pty) {
      try { entry.pty.resize(msg.cols, msg.rows); } catch (_) {}
    }
    if (msg.type === 'toolbar') {
      handleToolbar(msg.action, entry, context, extensionPath);
    }
    if (msg.type === 'paste-image' && entry.pty) {
      handlePasteImage(msg.data, entry, panel);
    }
    if (msg.type === 'check-clipboard-image' && entry.pty) {
      readClipboardImageFromSystem(entry, panel);
    }
    if (msg.type === 'drop-files' && entry.pty) {
      handleDropFiles(msg.paths, entry);
    }
    if (msg.type === 'open-link') {
      vscode.env.openExternal(vscode.Uri.parse(msg.url));
    }
    if (msg.type === 'rename-tab') {
      vscode.window.showInputBox({ prompt: t('enterTabName'), value: entry.title }).then(newName => {
        if (newName) {
          entry.title = newName;
          panel.title = newName;
          panel.webview.postMessage({ type: 'title-updated', title: newName });
          saveSessions(context);
        }
      });
    }
    if (msg.type === 'save-setting') {
      const cfg = vscode.workspace.getConfiguration('claudeCodeLauncher');
      cfg.update(msg.key, msg.value, true);
    }
    if (msg.type === 'export-settings') {
      const cfg = vscode.workspace.getConfiguration('claudeCodeLauncher');
      const exportData = {
        defaultTheme: cfg.get('defaultTheme'),
        defaultFontSize: cfg.get('defaultFontSize'),
        defaultFontFamily: cfg.get('defaultFontFamily'),
        soundEnabled: cfg.get('soundEnabled'),
        particlesEnabled: cfg.get('particlesEnabled'),
        customButtons: cfg.get('customButtons'),
        customSlashCommands: cfg.get('customSlashCommands'),
      };
      const json = JSON.stringify(exportData, null, 2);
      vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(path.join(os.homedir(), 'claude-launcher-settings.json')),
        filters: { 'JSON': ['json'] }
      }).then(uri => {
        if (uri) {
          fs.writeFileSync(uri.fsPath, json, 'utf8');
          vscode.window.showInformationMessage('Settings exported: ' + path.basename(uri.fsPath));
        }
      });
    }
    if (msg.type === 'import-settings') {
      vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectMany: false,
        filters: { 'JSON': ['json'] }
      }).then(uris => {
        if (!uris || uris.length === 0) return;
        try {
          const text = fs.readFileSync(uris[0].fsPath, 'utf8');
          const data = JSON.parse(text);
          const cfg = vscode.workspace.getConfiguration('claudeCodeLauncher');
          const keys = ['defaultTheme','defaultFontSize','defaultFontFamily','soundEnabled','particlesEnabled','customButtons','customSlashCommands'];
          for (const k of keys) {
            if (data[k] !== undefined) cfg.update(k, data[k], true);
          }
          vscode.window.showInformationMessage('Settings imported from ' + path.basename(uris[0].fsPath) + '. Reload window to apply.');
        } catch (e) {
          vscode.window.showErrorMessage('Invalid settings file: ' + e.message);
        }
      });
    }
    if (msg.type === 'close-resume') {
      // Save session title mapping before closing
      const titleMap = sessionStoreGet('claudeSessionTitles', {});
      if (entry.sessionId && entry.title && !/^Claude Code( \(\d+\))?$/.test(entry.title)) {
        titleMap[entry.sessionId] = entry.title;
      }
      sessionStoreUpdate('claudeSessionTitles', titleMap);
      // Add to saved sessions list (for sidebar grouping)
      if (entry.sessionId) {
        const saved = sessionStoreGet('claudeSavedSessions', []);
        if (!saved.some(s => s.sessionId === entry.sessionId)) {
          saved.unshift({ sessionId: entry.sessionId, title: entry.title, savedAt: Date.now() });
          sessionStoreUpdate('claudeSavedSessions', saved);
        }
      }
      // Close the panel — session remains resumable from sidebar
      panel.dispose();
      if (sessionTreeProvider) sessionTreeProvider.refresh();
      return;
    }
    if (msg.type === 'open-file') {
      handleOpenFile(msg.filePath, msg.line, entry);
    }
    if (msg.type === 'export-conversation') {
      handleExportConversation(msg.text, entry, panel);
    }
    if (msg.type === 'restart-session') {
      restartPty(entry, panel, context, extensionPath);
    }
    if (msg.type === 'set-memo') {
      entry.memo = msg.memo;
      saveSessions(context);
    }
    if (msg.type === 'request-edit-memo') {
      vscode.window.showInputBox({
        prompt: t('enterMemo'),
        value: entry.memo || ''
      }).then(value => {
        if (value !== undefined) {
          entry.memo = value;
          saveSessions(context);
          panel.webview.postMessage({ type: 'memo-updated', memo: value });
        }
      });
    }
  }, undefined, context.subscriptions);

  // Panel closed
  panel.onDidDispose(() => {
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    killPtyProcess(entry.pty);
    panels.delete(tabId);
    if (!isDeactivating) {
      saveSessions(context);
    }
    updateStatusBar();
  }, undefined, context.subscriptions);
}

// ── Kill PTY process tree (Windows-safe) ──

function killPtyProcess(ptyProcess) {
  if (!ptyProcess) return;
  try {
    const pid = ptyProcess.pid;
    if (process.platform === 'win32' && pid) {
      // taskkill /T kills entire process tree, /F forces
      require('child_process').exec(`taskkill /F /T /PID ${pid}`, { timeout: 5000 }, () => {});
    }
    ptyProcess.kill();
  } catch (_) {}
}

// ── Desktop notification (cross-platform) ──

function showDesktopNotification(tabTitle) {
  const { exec } = require('child_process');
  const msg = (tabTitle || 'Claude Code').replace(/[^a-zA-Z0-9가-힣ㄱ-ㅎㅏ-ㅣ\s\-_().]/g, '');
  if (process.platform === 'win32') {
    const psCmd = `
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null;
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom, ContentType = WindowsRuntime] | Out-Null;
$t = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02);
$n = $t.GetElementsByTagName('text');
$n.Item(0).AppendChild($t.CreateTextNode('Claude Code')) | Out-Null;
$n.Item(1).AppendChild($t.CreateTextNode('${msg}')) | Out-Null;
$toast = [Windows.UI.Notifications.ToastNotification]::new($t);
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('Claude Code').Show($toast)
`.replace(/\n/g, ' ');
    exec(`powershell -NoProfile -ExecutionPolicy Bypass -Command "${psCmd}"`, { timeout: 5000 }, () => {});
  } else if (process.platform === 'darwin') {
    exec(`osascript -e 'display notification "${msg}" with title "Claude Code"'`, { timeout: 5000 }, () => {});
  }
}

// ── Restart PTY ──

function restartPty(entry, panel, context, extensionPath) {
  let pty;
  try {
    pty = require('node-pty');
  } catch (e) {
    vscode.window.showErrorMessage(t('nodePtyFail') + e.message);
    return;
  }

  const resolved = resolveClaudeCli();
  if (!resolved) {
    vscode.window.showErrorMessage('Claude Code CLI not found.');
    return;
  }
  const shell = resolved.shell;
  const args = [...resolved.args, ...(entry.sessionId ? ['--resume', entry.sessionId] : [])];

  try {
    const ptyProcess = pty.spawn(shell, args, {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      cwd: entry.cwd,
      env: { ...process.env, FORCE_COLOR: '1' }
    });

    entry.pty = ptyProcess;
    entry.state = 'running';
    setTabIcon(panel, 'running', extensionPath);
    panel.title = entry.title;
    panel.webview.postMessage({ type: 'state', state: 'running' });
    saveSessions(context);
    updateStatusBar();

    // Re-attach PTY events
    // context parsing — rolling buffer for cross-chunk patterns
    let ctxBuf = '';
    ptyProcess.onData(data => {
      try {
        panel.webview.postMessage({ type: 'output', data: data });
      } catch (_) {}

      // Parse context/token usage (immediate on each chunk)
      const sNow = data.replace(/\x1b\[[0-9;:?]*[A-Za-z~@`]/g, '').replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '').replace(/\x1b./g, '').replace(/[\x00-\x1f\x7f]/g, '');
      ctxBuf = (ctxBuf + sNow).slice(-300);
      if (!entry._ctxSampled && /(?:컨텍스트|context)/i.test(sNow)) {
        console.log('[Claude Launcher] ctxBuf:', JSON.stringify(ctxBuf.slice(-200)));
        entry._ctxSampled = true;
      }
      // 1. Prompt status line: "ctx:52%"
      const cp = ctxBuf.match(/ctx:(\d+)%/);
      if (cp) {
        const pct = parseInt(cp[1]);
        const mm = ctxBuf.match(/(\d+(?:\.\d+)?)(M|k)\s*context/i);
        let tK = entry._ctxTotal || 1000;
        if (mm) tK = mm[2].toUpperCase() === 'M' ? parseFloat(mm[1]) * 1000 : parseFloat(mm[1]);
        const uK = Math.round(tK * pct / 100);
        entry._ctxUsed = uK; entry._ctxTotal = tK;
        try { panel.webview.postMessage({ type: 'context-usage', used: uK + 'k', total: tK + 'k', pct }); } catch (_) {}
      }
      // 1.5. Progress bar: [████░░░░░░] 40% or 컨텍스트 [░░░░░░░░░░] 6%
      if (!cp) {
        const bp = ctxBuf.match(/\[[^\]\n]{2,}\]\s*(\d+)\s*%/);
        if (bp) {
          const pct = parseInt(bp[1]);
          const mm = ctxBuf.match(/(\d+(?:\.\d+)?)(M|k)\s*context/i);
          let tK = entry._ctxTotal || 1000;
          if (mm) tK = mm[2].toUpperCase() === 'M' ? parseFloat(mm[1]) * 1000 : parseFloat(mm[1]);
          const uK = Math.round(tK * pct / 100);
          entry._ctxUsed = uK; entry._ctxTotal = tK;
          try { panel.webview.postMessage({ type: 'context-usage', used: uK + 'k', total: tK + 'k', pct }); } catch (_) {}
        }
        // 1.6. Keyword fallback: "컨텍스트 ... N%" or "context ... N%"
        if (!bp) {
          const kw = ctxBuf.match(/(?:컨텍스트|context[eo]?|kontext|コンテキスト|上下文|kontekst|kontextu?|contexte):?\s+.*?(\d+)\s*%/i);
          if (kw && parseInt(kw[1]) <= 100) {
            const pct = parseInt(kw[1]);
            const mm = ctxBuf.match(/(\d+(?:\.\d+)?)(M|k)\s*context/i);
            let tK = entry._ctxTotal || 1000;
            if (mm) tK = mm[2].toUpperCase() === 'M' ? parseFloat(mm[1]) * 1000 : parseFloat(mm[1]);
            const uK = Math.round(tK * pct / 100);
            entry._ctxUsed = uK; entry._ctxTotal = tK;
            try { panel.webview.postMessage({ type: 'context-usage', used: uK + 'k', total: tK + 'k', pct }); } catch (_) {}
          }
          // 1.7. Broad fallback
          if (!kw) {
            const bd = ctxBuf.match(/(?:컨텍스트|context|ctx)\S*[\s\S]{0,50}?(\d{1,3})\s*%/i);
            if (bd && parseInt(bd[1]) > 0 && parseInt(bd[1]) <= 100) {
              const pct = parseInt(bd[1]);
              const mm = ctxBuf.match(/(\d+(?:\.\d+)?)(M|k)\s*context/i);
              let tK = entry._ctxTotal || 1000;
              if (mm) tK = mm[2].toUpperCase() === 'M' ? parseFloat(mm[1]) * 1000 : parseFloat(mm[1]);
              const uK = Math.round(tK * pct / 100);
              entry._ctxUsed = uK; entry._ctxTotal = tK;
              try { panel.webview.postMessage({ type: 'context-usage', used: uK + 'k', total: tK + 'k', pct }); } catch (_) {}
            }
          }
        }
      }
      // 2. Full context: "300k/1000k"
      if (!cp) {
        const im = ctxBuf.match(/(\d+(?:\.\d+)?k?)\/(\d+(?:\.\d+)?k)/);
        if (im) {
          const uN = parseFloat(im[1]) * (im[1].endsWith('k') ? 1 : 0.001);
          const tN = parseFloat(im[2]) * (im[2].endsWith('k') ? 1 : 0.001);
          if (tN >= 100) {
            const pct = tN > 0 ? Math.round(uN / tN * 100) : 0;
            entry._ctxUsed = uN; entry._ctxTotal = tN;
            try { panel.webview.postMessage({ type: 'context-usage', used: im[1], total: im[2], pct }); } catch (_) {}
          }
        }
      }

      if (entry.state !== 'running' && entry.state !== 'done' && entry.state !== 'error') {
        entry.state = 'running';
        setTabIcon(panel, 'running', extensionPath);
        panel.webview.postMessage({ type: 'state', state: 'running' });
        updateStatusBar();
      }

      if (entry.idleTimer) clearTimeout(entry.idleTimer);
      entry.idleTimer = setTimeout(() => {
        if (!entry.pty || entry.state === 'done' || entry.state === 'error') return;
        if (panel.active) {
          entry.state = 'waiting';
          setTabIcon(panel, 'idle', extensionPath);
          panel.webview.postMessage({ type: 'state', state: 'waiting' });
        } else {
          entry.state = 'needs-attention';
          setTabIcon(panel, 'done', extensionPath);
          panel.webview.postMessage({ type: 'state', state: 'needs-attention' });
          panel.webview.postMessage({ type: 'notify' });
        }
        updateStatusBar();
        if (sessionTreeProvider) sessionTreeProvider.refresh();
      }, IDLE_DELAY_MS);
    });

    ptyProcess.onExit(({ exitCode }) => {
      if (entry.idleTimer) clearTimeout(entry.idleTimer);
      const isSuccess = exitCode === 0 || exitCode === null || exitCode === undefined;
      if (isSuccess) {
        entry.state = 'done';
        setTabIcon(panel, 'done', extensionPath);
        panel.title = entry.title + t('suffixDone');
        panel.webview.postMessage({ type: 'state', state: 'done' });
      } else {
        entry.state = 'error';
        setTabIcon(panel, 'error', extensionPath);
        panel.title = entry.title + t('suffixError').replace('{0}', exitCode);
        panel.webview.postMessage({ type: 'state', state: 'error' });
      }
      entry.pty = null;
      saveSessions(context);
      updateStatusBar();
      panel.webview.postMessage({ type: 'process-exited', exitCode, canResume: !!entry.sessionId });
    });

  } catch (e) {
    vscode.window.showErrorMessage(t('restartFail') + e.message);
  }
}

// ── Toolbar actions ──

function handleToolbar(action, entry, context, extensionPath) {
  switch (action) {
    case 'compact':
      if (entry.pty) entry.pty.write('/compact\r');
      break;
    case 'clear':
      if (entry.pty) entry.pty.write('/clear\r');
      break;
    case 'new-tab':
      createPanel(context, extensionPath, null);
      break;
  }
}

// ── Image handling ──

function handlePasteImage(base64Data, entry, panel) {
  try {
    const tmpDir = path.join(os.tmpdir(), 'claude-code-images');
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

    const filename = `clipboard-${Date.now()}.png`;
    const filepath = path.join(tmpDir, filename);

    const buffer = Buffer.from(base64Data, 'base64');
    fs.writeFileSync(filepath, buffer);

    const normalized = filepath.replace(/\\/g, '/');
    entry.pty.write(normalized + ' ');
    panel.webview.postMessage({ type: 'image-paste-result', success: true, filename });
  } catch (e) {
    vscode.window.showErrorMessage(t('imageSaveFail') + e.message);
    panel.webview.postMessage({ type: 'image-paste-result', success: false, reason: e.message });
  }
}

function handleDropFiles(paths, entry) {
  for (const p of paths) {
    const normalized = p.replace(/\\/g, '/');
    entry.pty.write(normalized + ' ');
  }
}

// Open file: .md → Obsidian, others → IDE editor
function handleOpenFile(filePath, line, entry) {
  // Resolve relative paths against cwd
  let absPath = filePath;
  if (!path.isAbsolute(filePath)) {
    absPath = path.join(entry.cwd, filePath);
  }
  absPath = absPath.replace(/\\/g, '/');

  // If not found, try searching subdirectories
  if (!fs.existsSync(absPath.replace(/\//g, path.sep))) {
    const suffix = filePath.replace(/\\/g, '/');
    const basename = path.basename(filePath);
    const found = [];
    function searchDir(dir, depth) {
      if (depth > 6 || found.length >= 5) return;
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const e of entries) {
          if (e.name === 'node_modules' || e.name === '.git') continue;
          const full = path.join(dir, e.name);
          if (e.isFile() && e.name === basename) found.push(full);
          else if (e.isDirectory()) searchDir(full, depth + 1);
        }
      } catch (_) {}
    }
    searchDir(entry.cwd, 0);
    const match = found.find(f => f.replace(/\\/g, '/').endsWith(suffix)) || found[0];
    if (match) absPath = match.replace(/\\/g, '/');
  }

  if (!fs.existsSync(absPath.replace(/\//g, path.sep))) {
    vscode.window.showWarningMessage(t('fileNotFound') + filePath);
    return;
  }

  if (absPath.endsWith('.md')) {
    // Open in Obsidian via URI scheme — detect vault from workspace
    const wsFolder = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath?.replace(/\\/g, '/');
    const vaultRoot = wsFolder ? wsFolder + '/' : '';
    const vaultName = wsFolder ? path.basename(wsFolder) : '';
    let relativePath = absPath;
    if (vaultRoot && absPath.toLowerCase().startsWith(vaultRoot.toLowerCase())) {
      relativePath = absPath.substring(vaultRoot.length);
    }
    const obsidianUri = `obsidian://open?vault=${encodeURIComponent(vaultName)}&file=${encodeURIComponent(relativePath)}`;
    vscode.env.openExternal(vscode.Uri.parse(obsidianUri));
  } else if (/\.(html?|xlsx?|csv|pptx?|docx?|pdf|png|jpe?g|gif|svg|zip|tar|gz)$/i.test(absPath)) {
    // Open with OS default program (browser, Excel, etc.)
    const fileUri = vscode.Uri.file(absPath.replace(/\//g, path.sep));
    vscode.env.openExternal(fileUri);
  } else {
    // Open in IDE editor
    const fileUri = vscode.Uri.file(absPath.replace(/\//g, path.sep));
    const options = line ? { selection: new vscode.Range(line - 1, 0, line - 1, 0) } : {};
    vscode.window.showTextDocument(fileUri, options);
  }
}

// Export conversation to .md file
async function handleExportConversation(text, entry, panel) {
  try {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const dateStr = `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}`;
    const timeStr = `${pad(now.getHours())}${pad(now.getMinutes())}`;
    const safeName = entry.title.replace(/[<>:"/\\|?*]/g, '_');
    const defaultName = `${dateStr}_${timeStr}_${safeName}.md`;

    const uri = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(path.join(entry.cwd, defaultName)),
      filters: { 'Markdown': ['md'], 'Text': ['txt'] }
    });

    if (!uri) return;

    const header = `# ${entry.title}\n\n- ${t('exportLabel')}: ${dateStr} ${pad(now.getHours())}:${pad(now.getMinutes())}\n- ${t('sessionLabel')}: ${entry.sessionId || 'N/A'}\n\n---\n\n`;
    const content = header + '```\n' + text + '\n```\n';

    fs.writeFileSync(uri.fsPath, content, 'utf8');
    panel.webview.postMessage({ type: 'export-result', success: true });
    vscode.window.showInformationMessage(t('conversationSaved') + path.basename(uri.fsPath));
  } catch (e) {
    panel.webview.postMessage({ type: 'export-result', success: false });
    vscode.window.showErrorMessage(t('exportFail') + e.message);
  }
}

// Read clipboard image from system (cross-platform)
function readClipboardImageFromSystem(entry, panel) {
  const tmpDir = path.join(os.tmpdir(), 'claude-code-images');
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

  const filename = `clipboard-${Date.now()}.png`;
  const filepath = path.join(tmpDir, filename);
  const { exec } = require('child_process');

  let command;
  if (process.platform === 'win32') {
    const escapedPath = filepath.replace(/'/g, "''");
    command = `powershell -NoProfile -Command "Add-Type -AssemblyName System.Windows.Forms; $img = [System.Windows.Forms.Clipboard]::GetImage(); if($img){ $img.Save('${escapedPath}', [System.Drawing.Imaging.ImageFormat]::Png); 'OK' } else { 'NO' }"`;
  } else if (process.platform === 'darwin') {
    command = `osascript -e 'try' -e 'set imgData to the clipboard as «class PNGf»' -e 'set f to open for access POSIX file "${filepath}" with write permission' -e 'write imgData to f' -e 'close access f' -e 'return "OK"' -e 'on error' -e 'return "NO"' -e 'end try'`;
  } else {
    panel.webview.postMessage({ type: 'image-paste-result', success: false, reason: 'unsupported-platform' });
    return;
  }

  exec(command, { timeout: 5000 }, (err, stdout) => {
    if (err) {
      panel.webview.postMessage({ type: 'image-paste-result', success: false, reason: 'clipboard-no-image' });
      return;
    }

    const result = stdout.trim();
    if (result === 'OK' && fs.existsSync(filepath)) {
      const normalized = filepath.replace(/\\/g, '/');
      if (entry.pty) entry.pty.write(normalized + ' ');
      panel.webview.postMessage({ type: 'image-paste-result', success: true, filename });
    } else {
      panel.webview.postMessage({ type: 'image-paste-result', success: false, reason: 'clipboard-no-image' });
    }
  });
}

// ── Icon & status ──

function setTabIcon(panel, state, extensionPath) {
  if (!panel) return;
  const iconFile = {
    idle: 'claude-idle.svg',
    running: 'claude-running.svg',
    done: 'claude-done.svg',
    error: 'claude-error.svg'
  }[state] || 'claude-idle.svg';

  try {
    const iconUri = vscode.Uri.file(path.join(extensionPath, 'icons', iconFile));
    panel.iconPath = { light: iconUri, dark: iconUri };
  } catch (_) {}
}

function updateStatusBar() {
  let hasRunning = false;
  let hasNeedsAttention = false;
  let hasWaiting = false;

  for (const [, entry] of panels) {
    if (entry.state === 'running') hasRunning = true;
    if (entry.state === 'needs-attention') hasNeedsAttention = true;
    if (entry.state === 'waiting') hasWaiting = true;
  }

  if (hasRunning) setStatusBar('running');
  else if (hasNeedsAttention) setStatusBar('needs-attention');
  else if (hasWaiting) setStatusBar('waiting');
  else if (panels.size > 0) setStatusBar('done');
  else setStatusBar('idle');
}

function setStatusBar(state) {
  if (!statusBar) return;
  const config = {
    idle:              { text: '$(hubot) Claude Code',            bg: undefined },
    waiting:           { text: t('sbIdle'),      bg: undefined },
    running:           { text: t('sbRunning'),   bg: 'statusBarItem.warningBackground' },
    'needs-attention': { text: t('sbAttention'), bg: 'statusBarItem.prominentBackground' },
    done:              { text: t('sbDone'),      bg: undefined },
    error:             { text: t('sbError'),     bg: 'statusBarItem.errorBackground' }
  }[state];

  statusBar.text = config.text;
  statusBar.backgroundColor = config.bg ? new vscode.ThemeColor(config.bg) : undefined;
}

// ── Webview HTML ──

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
  <style>
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
  </style>
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
  <script>
    const vscode = acquireVsCodeApi();
    const T = ${JSON.stringify(T)};
    const SETTINGS = ${JSON.stringify(settings)};
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
        cursor: '${cursor}'
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

    // Apply default theme from settings
    if (SETTINGS.defaultTheme && SETTINGS.defaultTheme !== 'default') {
      setTimeout(() => {
        const item = document.querySelector('.theme-item[data-theme="' + SETTINGS.defaultTheme + '"]');
        if (item) item.click();
      }, 100);
    }

    // Open selected text as file path
    function openSelectedAsFile() {
      const sel = term.getSelection().trim();
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

    ctxIndicator.addEventListener('click', () => {
      vscode.postMessage({ type: 'input', data: '/context' + String.fromCharCode(13) });
      showToast(T.ctxQuerying);
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
        '<div class="set-item"><span style="font-weight:600;">' + b.label + '</span><span style="color:${statusGray};">' + b.command + '</span><span class="set-item-del" data-bi="' + i + '">&#x2715;</span></div>'
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
        '<div class="set-item"><span style="font-weight:600;">' + s.cmd + '</span><span style="color:${statusGray};">' + s.desc + '</span><span class="set-item-del" data-si="' + i + '">&#x2715;</span></div>'
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
    const themePicker = document.getElementById('theme-picker');
    const themes = {
      'default':  { outer: '${outerBg}', terminal: '${bg}', fg: '${fg}', cursor: '${cursor}', border: '${border}', shadow: '${isDark ? "rgba(0,0,0,0.4)" : "rgba(0,0,0,0.08)"}' },
      'midnight': { outer: '#15112e', terminal: '#1c1740', fg: '#c8c0f0', cursor: '#9080e0', border: '#3a2d6b', shadow: 'rgba(80,50,180,0.3)' },
      'ocean':    { outer: '#0a1828', terminal: '#0c2240', fg: '#a0d0f0', cursor: '#60a0e0', border: '#1a4070', shadow: 'rgba(30,80,160,0.3)' },
      'forest':   { outer: '#0a1a0a', terminal: '#0e2810', fg: '#a0e0a0', cursor: '#60c060', border: '#1a5020', shadow: 'rgba(30,120,40,0.3)' },
      'sunset':   { outer: '#1e0e08', terminal: '#2a1510', fg: '#f0c8a0', cursor: '#e09060', border: '#5a3020', shadow: 'rgba(180,80,30,0.3)' },
      'aurora':   { outer: '#0e0818', terminal: '#160e2e', fg: '#d0b0f0', cursor: '#b070e0', border: '#3a2060', shadow: 'rgba(120,40,180,0.3)' },
      'warm':     { outer: '#1a1408', terminal: '#241c10', fg: '#e8d8b0', cursor: '#d0a860', border: '#4a3818', shadow: 'rgba(160,120,40,0.3)' }
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
      term.options.theme = { background: t.terminal, foreground: t.fg, cursor: t.cursor, selectionBackground: t.border };
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
      const buf = term.buffer.active;
      const lines = [];
      for (let i = 0; i <= buf.length - 1; i++) {
        const line = buf.getLine(i);
        if (line) lines.push(line.translateToString(true));
      }
      // Trim trailing empty lines
      while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
      const text = lines.join('\\n');
      vscode.postMessage({ type: 'export-conversation', text: text });
      showToast(T.exportingToast);
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

    // Toast notification
    let toastTimer = null;
    function showToast(message) {
      const toast = document.getElementById('paste-toast');
      toast.textContent = message;
      toast.style.display = 'block';
      toast.style.opacity = '1';
      if (toastTimer) clearTimeout(toastTimer);
      toastTimer = setTimeout(() => {
        toast.style.opacity = '0';
        setTimeout(() => { toast.style.display = 'none'; }, 300);
      }, 2500);
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
        term.write(msg.data);
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
      if (msg.type === 'image-paste-result') {
        if (msg.success) {
          showToast(T.imageDone + msg.filename);
        } else if (msg.reason && msg.reason !== 'clipboard-no-image') {
          showToast(T.imageFailToast + msg.reason);
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

    // ── Clipboard image paste ──
    // Capture phase: intercept BEFORE xterm.js processes the paste event
    let lastWebviewPasteTime = 0;
    document.addEventListener('paste', (e) => {
      const items = e.clipboardData?.items;
      if (!items) return;

      for (const item of items) {
        if (item.type.startsWith('image/')) {
          e.preventDefault();
          e.stopPropagation();
          lastWebviewPasteTime = Date.now();
          const blob = item.getAsFile();
          if (!blob) return;
          showToast(T.imagePasting);
          const reader = new FileReader();
          reader.onload = () => {
            const base64 = reader.result.split(',')[1];
            if (base64) {
              vscode.postMessage({ type: 'paste-image', data: base64 });
            }
          };
          reader.readAsDataURL(blob);
          return;
        }
      }
      // No image found — let xterm handle normal text paste
    }, true); // <-- capture phase

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

      // Ctrl+C: copy selected text (if selection exists), otherwise send ^C
      if (mod && event.key === 'c') {
        const sel = term.getSelection();
        if (sel) {
          event.preventDefault();
          navigator.clipboard.writeText(sel);
          showToast(T.copied);
          return false;
        }
        // No selection: let ^C pass through to PTY
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

    document.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showContextMenu(e.clientX, e.clientY);
    });

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
          const sel = term.getSelection();
          if (sel) navigator.clipboard.writeText(sel);
          break;
        case 'open-file':
          openSelectedAsFile();
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
        '<span class="slash-cmd">' + c.cmd + '</span>' +
        '<span class="slash-desc">' + c.desc + '</span>' +
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

      // ArrowUp/Down: editor input history (only when textarea is single-line)
      if (e.key === 'ArrowUp' && !e.shiftKey && !editorTextarea.value.includes('\\n')) {
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
      if (e.key === 'ArrowDown' && !e.shiftKey && !editorTextarea.value.includes('\\n')) {
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
    const checkScroll = () => {
      const viewport = document.querySelector('.xterm-viewport');
      if (!viewport) return;
      const atBottom = viewport.scrollTop + viewport.clientHeight >= viewport.scrollHeight - 10;
      if (atBottom !== isAtBottom) {
        isAtBottom = atBottom;
        scrollFab.style.display = isAtBottom ? 'none' : 'flex';
      }
    };

    // Poll scroll position (xterm doesn't expose scroll events reliably)
    setInterval(checkScroll, 1000);

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
  </script>
</body>
</html>`;
}

function deactivate() {
  isDeactivating = true;

  // Save sessions BEFORE cleanup so they survive reload
  if (_context && panels.size > 0) {
    const sessions = [];
    let order = 0;
    for (const [, entry] of panels) {
      sessions.push({
        title: entry.title,
        memo: entry.memo || '',
        cwd: entry.cwd,
        sessionId: entry.sessionId,
        order: order++,
        viewColumn: entry.panel.viewColumn || 1
      });
    }
    _sessionStoreUpdate('claudeSessions', sessions);
  }

  for (const [, entry] of panels) {
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    killPtyProcess(entry.pty);
  }
  panels.clear();
}

module.exports = { activate, deactivate };
