// node-pty ABI smoke test
// Usage: npm run probe:pty
// Expected stdout: "ok"

const pty = require("node-pty");

const shell = process.platform === "win32" ? "bash.exe" : "/bin/sh";
const p = pty.spawn(shell, ["-c", "echo ok"], {
  name: "xterm-color",
  cols: 80,
  rows: 24,
});

p.onData((d) => process.stdout.write(d));
p.onExit((c) => process.exit(c.exitCode ?? 0));
