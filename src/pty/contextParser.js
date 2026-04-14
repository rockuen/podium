// @module pty/contextParser — parses Claude CLI stdout for context/token usage.
// Stateful per PTY: rolling 300-char buffer to catch cross-chunk patterns.
// Call createContextParser() once per PTY instance (shared by createPanel + restartPty).
//
// Detection priority (4 fallbacks + delta):
//   1.   "ctx:52%"                   — prompt status line (most reliable)
//   1.5. "[████░░░░] 40%"            — progress bar
//   1.6. "컨텍스트/context: ... N%"  — keyword with percent
//   1.7. Broad: keyword + N% within 50 chars
//   2.   "300k/1000k"                — /context command output
//   3.   "± 1.6k tokens"             — delta fallback
//
// Sample inputs (for regression tests):
//   "ctx:52%"                        → { used: '520k', total: '1000k', pct: 52 }
//   "컨텍스트 [░░░░] 6%"             → { used: '60k',  total: '1000k', pct: 6 }
//   "300k/1000k"                     → { used: '300k', total: '1000k', pct: 30 }

function stripAnsi(s) {
  return s
    .replace(/\x1b\[[0-9;:?]*[A-Za-z~@`]/g, '')
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b./g, '')
    .replace(/[\x00-\x1f\x7f]/g, '');
}

function createContextParser() {
  let ctxBuf = '';

  function feed(data, entry) {
    const strippedNow = stripAnsi(data);
    ctxBuf = (ctxBuf + strippedNow).slice(-300);

    if (!entry._ctxSampled && /(?:컨텍스트|context)/i.test(strippedNow)) {
      console.log('[Claude Launcher] ctxBuf:', JSON.stringify(ctxBuf.slice(-200)));
      entry._ctxSampled = true;
    }

    let usage = null;

    // 1. Prompt status line: "ctx:52%"
    const ctxPctMatch = ctxBuf.match(/ctx:(\d+)%/);
    if (ctxPctMatch) {
      const pct = parseInt(ctxPctMatch[1]);
      const modelMatch = ctxBuf.match(/(\d+(?:\.\d+)?)(M|k)\s*context/i);
      let totalK = entry._ctxTotal || 1000;
      if (modelMatch) totalK = modelMatch[2].toUpperCase() === 'M' ? parseFloat(modelMatch[1]) * 1000 : parseFloat(modelMatch[1]);
      const usedK = Math.round(totalK * pct / 100);
      entry._ctxUsed = usedK;
      entry._ctxTotal = totalK;
      usage = { used: usedK + 'k', total: totalK + 'k', pct };
    } else {
      // 1.5. Progress bar
      const barMatch = ctxBuf.match(/\[[^\]\n]{2,}\]\s*(\d+)\s*%/);
      if (barMatch) {
        const pct = parseInt(barMatch[1]);
        const modelMatch = ctxBuf.match(/(\d+(?:\.\d+)?)(M|k)\s*context/i);
        let totalK = entry._ctxTotal || 1000;
        if (modelMatch) totalK = modelMatch[2].toUpperCase() === 'M' ? parseFloat(modelMatch[1]) * 1000 : parseFloat(modelMatch[1]);
        const usedK = Math.round(totalK * pct / 100);
        entry._ctxUsed = usedK;
        entry._ctxTotal = totalK;
        usage = { used: usedK + 'k', total: totalK + 'k', pct };
      } else {
        // 1.6. Keyword fallback
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
            usage = { used: usedK + 'k', total: totalK + 'k', pct };
          }
        } else {
          // 1.7. Broad fallback
          const broad = ctxBuf.match(/(?:컨텍스트|context|ctx)\S*[\s\S]{0,50}?(\d{1,3})\s*%/i);
          if (broad && parseInt(broad[1]) > 0 && parseInt(broad[1]) <= 100) {
            const pct = parseInt(broad[1]);
            const modelMatch = ctxBuf.match(/(\d+(?:\.\d+)?)(M|k)\s*context/i);
            let totalK = entry._ctxTotal || 1000;
            if (modelMatch) totalK = modelMatch[2].toUpperCase() === 'M' ? parseFloat(modelMatch[1]) * 1000 : parseFloat(modelMatch[1]);
            const usedK = Math.round(totalK * pct / 100);
            entry._ctxUsed = usedK;
            entry._ctxTotal = totalK;
            usage = { used: usedK + 'k', total: totalK + 'k', pct };
          }
        }
      }

      // 2. Full context from /context: "300k/1000k"
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
          usage = { used, total, pct };
        }
      }
    }

    // 3. Delta during response: "± 1.6k tokens"
    const deltaMatch = strippedNow.match(/[±+]\s*(\d+(?:\.\d+)?)\s*(k)?\s*token/i);
    if (deltaMatch && entry._ctxTotal > 0 && !ctxPctMatch) {
      const num = parseFloat(deltaMatch[1]);
      const delta = (deltaMatch[2] ? num : num / 1000) * 2; // x2 보정 (누락 보상)
      entry._ctxUsed = (entry._ctxUsed || 0) + delta;
      const used = entry._ctxUsed >= 10 ? Math.round(entry._ctxUsed) + 'k' : entry._ctxUsed.toFixed(1) + 'k';
      const total = Math.round(entry._ctxTotal) + 'k';
      const pct = entry._ctxTotal > 0 ? Math.round(entry._ctxUsed / entry._ctxTotal * 100) : 0;
      usage = { used, total, pct };
    }

    return usage;
  }

  function reset() {
    ctxBuf = '';
  }

  return { feed, reset };
}

module.exports = { createContextParser, stripAnsi };
