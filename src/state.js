// @module state — module-local singleton for runtime state shared across modules.
// We deliberately avoid DI/EventEmitter here: the extension runs in a single
// activate() context with no test harness, and singleton readability beats the
// indirection cost of a DI container.

const state = {
  panels: new Map(),       // tabId → entry
  tabCounter: 0,
  statusBar: null,         // vscode.StatusBarItem
  sessionTreeProvider: null,
  context: null,           // ExtensionContext, injected at activate()
  isDeactivating: false,
};

module.exports = state;
