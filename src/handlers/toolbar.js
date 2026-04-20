// @module handlers/toolbar — toolbar button actions.
// new-tab requires createPanel injection (extension.js owns panel creation until Phase 6).

const { autoSendToEntry } = require('../pty/autoSend');

// v2.6.18: route /compact and /clear through autoSendToEntry so Podium-ready
// (tmux-wrapped) sessions use `psmux send-keys Enter` — surviving Claude CLI's
// win32-input-mode, which interprets a raw pty.write('\r') as literal newline
// (Shift+Enter) instead of submit. Supersedes the v2.6.16 split-write hack.
function sendSlashCommand(entry, cmd) {
  autoSendToEntry(entry, cmd);
}

function handleToolbar(action, entry, context, extensionPath, createPanel) {
  switch (action) {
    case 'compact':
      sendSlashCommand(entry, '/compact');
      break;
    case 'clear':
      sendSlashCommand(entry, '/clear');
      break;
    case 'new-tab':
      createPanel(context, extensionPath, null);
      break;
  }
}

module.exports = { handleToolbar };
