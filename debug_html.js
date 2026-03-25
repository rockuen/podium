const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, 'extension.js'), 'utf8');

// Extract the HTML template from getWebviewContent
const funcMatch = src.match(/function getWebviewContent\([^)]+\)\s*\{/);
if (!funcMatch) { console.error('Function not found'); process.exit(1); }

const funcStart = funcMatch.index;
// Find the return statement with template literal
const returnIdx = src.indexOf("return `<!DOCTYPE html>", funcStart);
const endIdx = src.indexOf("</html>`", returnIdx);
const templateStr = src.substring(returnIdx + 8, endIdx + 7); // skip 'return `'

// Count template lines (without evaluating ${} - just raw)
const rawLines = templateStr.split('\n');
console.log('Raw template lines:', rawLines.length);

// Now find all ${} expressions that could produce multi-line output before raw line ~1080
// Let's count how many extra lines are added by multi-line expressions
let htmlLineCount = 0;
let lastReportedRawLine = 0;

for (let i = 0; i < rawLines.length && htmlLineCount < 1090; i++) {
  const line = rawLines[i];
  // Count ${} expressions that might produce newlines
  // For now, assume 1:1 unless we detect .map() or .join('\n')
  htmlLineCount++;

  if (htmlLineCount >= 1075 && htmlLineCount <= 1085) {
    const marker = htmlLineCount === 1080 ? '>>>' : '   ';
    const trimmed = line.trimEnd();
    console.log(marker + ' HTML~' + htmlLineCount + ' (raw:' + (i+1) + '): ' + trimmed.substring(0, 120));
  }
}

console.log('\n--- Looking for potential syntax issues ---');

// Search for unescaped backticks or problematic patterns in the template
let inTemplate = false;
const lines = src.split('\n');
for (let i = 0; i < lines.length; i++) {
  const lineNum = i + 1;
  if (lineNum === 1365) inTemplate = true; // template start approx
  if (!inTemplate) continue;

  const line = lines[i];

  // Check for potential issues: unescaped backtick, broken ${}, etc.
  // Look for backtick usage that's NOT the template boundary
  if (line.includes('`') && lineNum > 1365) {
    // Check if this backtick is inside a regex or string within the template
    const contexts = [];
    for (let j = 0; j < line.length; j++) {
      if (line[j] === '`' && (j === 0 || line[j-1] !== '\\')) {
        contexts.push({ col: j+1, char: line.substring(Math.max(0,j-20), j+20) });
      }
    }
    if (contexts.length > 0) {
      console.log('Line ' + lineNum + ' has unescaped backtick(s):', JSON.stringify(contexts));
    }
  }

  if (line.includes('</html>`')) { inTemplate = false; break; }
}

// Also check around the known issue areas
console.log('\n--- Lines around potential problem area (JS 2440-2450) ---');
for (let i = 2435; i <= 2455 && i < lines.length; i++) {
  console.log((i+1) + ': ' + lines[i].substring(0, 120));
}
