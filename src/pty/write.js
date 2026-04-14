// @module pty/write — chunked PTY write with per-entry serialization queue.
// Prevents Windows ConPTY input buffer overflow on large pastes and interleaving
// when multiple writes fire concurrently (paste + keystrokes).
//
// Tuned values. DO NOT change without regression-testing long paste:
//   PTY_CHUNK_SIZE=256   smaller than ConPTY's ~4KB buffer for safety headroom
//   PTY_CHUNK_DELAY=20   gives Claude CLI time to drain between chunks

const PTY_CHUNK_SIZE = 256;
const PTY_CHUNK_DELAY = 20;

function writePtyChunked(entry, data) {
  if (!entry.pty || !data) return;
  if (!entry._writeQueue) entry._writeQueue = [];
  entry._writeQueue.push(data);
  if (!entry._writing) drainWriteQueue(entry);
}

function drainWriteQueue(entry) {
  if (!entry.pty || entry._disposed) {
    entry._writing = false;
    if (entry._writeQueue) entry._writeQueue.length = 0;
    return;
  }
  const data = entry._writeQueue && entry._writeQueue.shift();
  if (!data) {
    entry._writing = false;
    return;
  }
  entry._writing = true;
  if (data.length <= PTY_CHUNK_SIZE) {
    try { entry.pty.write(data); } catch (_) {}
    setTimeout(() => drainWriteQueue(entry), PTY_CHUNK_DELAY);
    return;
  }
  let offset = 0;
  const writeNext = () => {
    if (!entry.pty || entry._disposed) {
      entry._writing = false;
      if (entry._writeQueue) entry._writeQueue.length = 0;
      return;
    }
    let end = Math.min(offset + PTY_CHUNK_SIZE, data.length);
    // Avoid splitting a UTF-16 surrogate pair across chunks.
    if (end < data.length) {
      const code = data.charCodeAt(end - 1);
      if (code >= 0xD800 && code <= 0xDBFF) end += 1;
    }
    const chunk = data.slice(offset, end);
    try { entry.pty.write(chunk); } catch (_) {
      entry._writing = false;
      return;
    }
    offset = end;
    if (offset < data.length) {
      setTimeout(writeNext, PTY_CHUNK_DELAY);
    } else {
      setTimeout(() => drainWriteQueue(entry), PTY_CHUNK_DELAY);
    }
  };
  writeNext();
}

module.exports = { writePtyChunked, drainWriteQueue, PTY_CHUNK_SIZE, PTY_CHUNK_DELAY };
