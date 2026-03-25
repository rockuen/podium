const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, 'extension.js'), 'utf8');

// Find the return `...` template and extract it
const retIdx = src.indexOf("return `<!DOCTYPE html>");
const endIdx = src.indexOf("</html>`", retIdx);

// Get the raw template string content (between the backticks)
const rawTemplate = src.substring(retIdx + 8, endIdx + 7);

// Find all ${...} expressions and replace them with placeholders
// to get the line structure right, then count
let lineNum = 0;
let col = 0;
const outputLines = [];
let currentLine = '';

// Process the template character by character
let i = 0;
while (i < rawTemplate.length) {
  if (rawTemplate[i] === '\n') {
    outputLines.push(currentLine);
    currentLine = '';
    i++;
  } else if (rawTemplate[i] === '\r') {
    i++; // skip CR
  } else if (rawTemplate[i] === '$' && rawTemplate[i+1] === '{') {
    // Find matching closing brace (account for nested braces, strings, etc.)
    let depth = 1;
    let j = i + 2;
    let inStr = null;
    while (j < rawTemplate.length && depth > 0) {
      const ch = rawTemplate[j];
      if (inStr) {
        if (ch === '\\') { j++; } // skip escaped
        else if (ch === inStr) { inStr = null; }
      } else {
        if (ch === "'" || ch === '"' || ch === '`') { inStr = ch; }
        else if (ch === '{') { depth++; }
        else if (ch === '}') { depth--; }
      }
      j++;
    }
    // Replace the expression with a placeholder
    const expr = rawTemplate.substring(i, j);
    // For map().join('\n') expressions, add approximate newlines
    if (expr.includes('.map(') && expr.includes("join('\\n")) {
      currentLine += '/* DYNAMIC_MULTILINE */';
    } else {
      currentLine += '/* EXPR */';
    }
    i = j;
  } else if (rawTemplate[i] === '\\' && rawTemplate[i+1] === '`') {
    currentLine += '`';
    i += 2;
  } else if (rawTemplate[i] === '\\' && rawTemplate[i+1] === '$') {
    currentLine += '$';
    i += 2;
  } else if (rawTemplate[i] === '\\' && rawTemplate[i+1] === '\\') {
    currentLine += '\\';
    i += 2;
  } else {
    currentLine += rawTemplate[i];
    i++;
  }
}
if (currentLine) outputLines.push(currentLine);

console.log('Total output lines:', outputLines.length);
console.log('\n--- Lines 1075-1090 ---');
for (let k = 1074; k < 1090 && k < outputLines.length; k++) {
  const num = k + 1;
  const marker = num === 1080 ? '>>>' : '   ';
  const line = outputLines[k];
  console.log(marker + ' ' + num + ' (len=' + line.length + '): ' + line.substring(0, 140));
  if (num === 1080 && line.length >= 58) {
    console.log('    col 58: ' + JSON.stringify(line.charAt(57)));
    console.log('    around col 58: ' + JSON.stringify(line.substring(50, 70)));
  }
}

// Also look for potential JS syntax issues in the script section
console.log('\n--- Searching for potential syntax issues in <script> section ---');
const scriptStart = outputLines.findIndex(l => l.trim() === '<script>');
const scriptEnd = outputLines.findIndex((l, idx) => idx > scriptStart && l.trim() === '</script>');
console.log('Script starts at line:', scriptStart + 1, 'ends at:', scriptEnd + 1);

// Find lines with potential issues
for (let k = scriptStart; k <= scriptEnd && k < outputLines.length; k++) {
  const line = outputLines[k];
  // Check for unescaped template literals or problematic chars
  if (line.includes('`') && !line.includes('/* EXPR */')) {
    console.log('  Backtick at line ' + (k+1) + ': ' + line.substring(0, 100));
  }
}
