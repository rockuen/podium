// esbuild.webview.config.mjs
//
// Browser-side bundler for orchestration webviews (HUD dashboard, team
// conversation, spawn-team, multipane, terminal). Node-side TypeScript is
// compiled separately by `tsc -p ./`.
//
// Entries are resolved lazily — missing source files are skipped so this
// config can be committed ahead of gradual ports (M2.C -> M2.E).

import * as esbuild from 'esbuild';
import * as fs from 'fs';

const watch = process.argv.includes('--watch');

const base = {
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2020',
  sourcemap: true,
  logLevel: 'info',
};

const entries = [
  ['src/orchestration/webview/hud-dashboard-main.ts',      'out/orchestration/webview/hud-dashboard.js'],
  ['src/orchestration/webview/team-conversation-main.ts',  'out/orchestration/webview/team-conversation.js'],
  ['src/orchestration/webview/spawn-team-main.ts',         'out/orchestration/webview/spawn-team.js'],
  ['src/orchestration/webview/multipane-main.ts',          'out/orchestration/webview/multipane.js'],
  ['src/orchestration/webview/terminal-main.ts',           'out/orchestration/webview/terminal.js'],
  ['src/orchestration/webview/ccg-viewer-main.ts',         'out/orchestration/webview/ccg-viewer.js'],
  // Phase 1 (v2.7.0) — LiveMultiPanel: N live node-pty panes in one webview.
  ['src/orchestration/webview/live-multipane-main.ts',     'out/orchestration/webview/live-multipane.js'],
];

const configs = entries
  .filter(([src]) => fs.existsSync(src))
  .map(([entry, outfile]) => ({ ...base, entryPoints: [entry], outfile }));

if (configs.length === 0) {
  console.log('[orch] no webview entries present yet, skipping bundle.');
} else if (watch) {
  const ctxs = await Promise.all(configs.map((c) => esbuild.context(c)));
  await Promise.all(ctxs.map((c) => c.watch()));
  console.log(`[orch] esbuild watching ${configs.length} webview entries...`);
} else {
  await Promise.all(configs.map((c) => esbuild.build(c)));
  console.log(`[orch] webview bundle complete (${configs.length} entries).`);
}
