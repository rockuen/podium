// @module pty/rawBuffer — per-entry append-only capture of raw PTY output.
// Export uses this (not xterm's render buffer) so soft-wrap + ConPTY reflow
// can't mangle the transcript. Ring-trimmed at MAX_RAW_BUFFER, dropping
// whole lines from the head when over the limit.

const MAX_RAW_BUFFER = 10 * 1024 * 1024; // 10MB

function appendRaw(entry, data) {
  if (!entry.rawOutput) entry.rawOutput = '';
  entry.rawOutput += data;
  if (entry.rawOutput.length > MAX_RAW_BUFFER) {
    const sliced = entry.rawOutput.slice(-MAX_RAW_BUFFER);
    const nl = sliced.indexOf('\n');
    entry.rawOutput = nl >= 0 ? sliced.slice(nl + 1) : sliced;
  }
}

function resetRaw(entry) {
  entry.rawOutput = '';
}

// Strip ANSI escape sequences + handle CR for export as plain text.
// Order matters: OSC/DCS (which can contain '[') before CSI.
function sanitizeForExport(raw) {
  if (!raw) return '';
  let s = raw;
  // OSC: ESC ] ... BEL | ESC \\
  s = s.replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, '');
  // DCS / SOS / PM / APC: ESC P|X|^|_ ... ESC \\
  s = s.replace(/\x1b[PX^_][\s\S]*?\x1b\\/g, '');
  // CSI: ESC [ ... final-byte
  s = s.replace(/\x1b\[[?!>]?[0-9;]*[@-~]/g, '');
  // Charset designators: ESC ( B, ESC ) 0, etc.
  s = s.replace(/\x1b[()*+][A-Za-z0-9]/g, '');
  // Single-char escapes: ESC =, ESC >, ESC 7/8/D/E/M, etc.
  s = s.replace(/\x1b[=>78DEMNOHc]/g, '');
  // Any remaining ESC+char
  s = s.replace(/\x1b./g, '');
  // BEL
  s = s.replace(/\x07/g, '');
  // CR handling: \r\n → \n; lone \r rewinds within the line (progress bar).
  s = s.replace(/\r\n/g, '\n');
  s = s.split('\n').map(line => {
    const parts = line.split('\r');
    return parts[parts.length - 1];
  }).join('\n');
  return s;
}

module.exports = { appendRaw, resetRaw, sanitizeForExport, MAX_RAW_BUFFER };
