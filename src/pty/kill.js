// @module pty/kill — cross-platform PTY process termination.
// On Windows, node-pty.kill() does not cascade to child processes; use taskkill /T
// to kill the entire tree before calling kill() for cleanup.

function killPtyProcess(ptyProcess) {
  if (!ptyProcess) return;
  try {
    const pid = ptyProcess.pid;
    if (process.platform === 'win32' && pid) {
      require('child_process').execFile('taskkill', ['/F', '/T', '/PID', String(pid)], { timeout: 5000 }, () => {});
    }
    ptyProcess.kill();
  } catch (_) {}
}

module.exports = { killPtyProcess };
