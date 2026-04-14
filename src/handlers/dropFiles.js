// @module handlers/dropFiles — writes dropped file paths into the PTY.

function handleDropFiles(paths, entry) {
  if (!entry.pty) return;
  for (const p of paths) {
    const normalized = p.replace(/\\/g, '/');
    entry.pty.write(normalized + ' ');
  }
}

module.exports = { handleDropFiles };
