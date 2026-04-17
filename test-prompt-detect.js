// Standalone test for v2.6.6 interactive prompt detection.
// Mirrors INTERACTIVE_PROMPT_PATTERNS from createPanel.js.
const INTERACTIVE_PROMPT_PATTERNS = [
  /Do you want to/i,
  /\[Y\/n\]/,
  /\[y\/N\]/,
  /\(y\/n\)/i,
  /\(yes\/no\)/i,
  /Press Enter to continue/i,
  /Press \[?Esc\]? to/i,
];
function looksLikePrompt(data) {
  for (let i = 0; i < INTERACTIVE_PROMPT_PATTERNS.length; i++) {
    if (INTERACTIVE_PROMPT_PATTERNS[i].test(data)) return true;
  }
  return false;
}

const cases = [
  // --- expected MATCH (Claude CLI style prompts) ---
  { expect: true,  label: 'user example: launch.json',
    input: 'Do you want to create launch.json?\n > 1. Yes\n   2. Yes, allow all edits during this session (shift+tab)\n   3. No' },
  { expect: true,  label: 'Do you want short',       input: 'Do you want to proceed?' },
  { expect: true,  label: 'ANSI wrapped Do you want', input: '\x1b[2J\x1b[HDo you want to allow the tool?\x1b[0m' },
  { expect: true,  label: 'Y/n capital',              input: 'Continue? [Y/n] ' },
  { expect: true,  label: 'y/N default no',           input: 'Discard changes? [y/N] ' },
  { expect: true,  label: '(y/n) parens',             input: 'Really delete this file (y/n)? ' },
  { expect: true,  label: '(yes/no) full',            input: 'Accept terms (yes/no)?' },
  { expect: true,  label: 'Press Enter',              input: 'Installation complete. Press Enter to continue.' },
  { expect: true,  label: 'Press [Esc]',              input: 'Press [Esc] to cancel the operation' },
  { expect: true,  label: 'chunked — first',          input: '...spinner output... Do you want' },
  { expect: true,  label: 'multi-line mid-output',    input: 'generated 3 files.\n\nDo you want to save them?\n> 1. Yes\n  2. No' },

  // --- expected NO MATCH (normal output, should NOT trigger) ---
  { expect: false, label: 'plain log line',           input: '[info] compiled 42 files in 1.3s' },
  { expect: false, label: 'code review text',         input: 'This function does what you want to with the data.' }, // "want to" but not "Do you want"
  { expect: false, label: 'empty',                    input: '' },
  { expect: false, label: 'just ANSI',                input: '\x1b[2J\x1b[H' },
  { expect: false, label: 'Yes/No in narrative',      input: 'The answer is either Yes or No depending on context.' },
  { expect: false, label: 'press key hint (no esc)',  input: 'press any key' },
  { expect: false, label: 'Python y/n fragment var', input: 'let yn = "y"; // y or n' },
];

let passed = 0, failed = 0;
for (const c of cases) {
  const got = looksLikePrompt(c.input);
  const ok = got === c.expect;
  if (ok) passed++; else failed++;
  console.log(
    (ok ? 'PASS' : 'FAIL').padEnd(5) +
    ' expect=' + String(c.expect).padEnd(5) +
    ' got=' + String(got).padEnd(5) +
    ' ' + c.label
  );
  if (!ok) console.log('       input: ' + JSON.stringify(c.input.slice(0, 80)));
}
console.log('---');
console.log('passed=' + passed + ' failed=' + failed + ' total=' + cases.length);
process.exit(failed === 0 ? 0 : 1);
