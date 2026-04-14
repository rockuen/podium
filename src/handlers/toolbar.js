// @module handlers/toolbar — toolbar button actions.
// new-tab requires createPanel injection (extension.js owns panel creation until Phase 6).

function handleToolbar(action, entry, context, extensionPath, createPanel) {
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

module.exports = { handleToolbar };
