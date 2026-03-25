const fs = require('fs');
const html = fs.readFileSync('debug_output.html', 'utf8');

const scriptStart = html.indexOf('<script>') + 8;
const scriptEnd = html.indexOf('</script>', scriptStart);
const script = html.substring(scriptStart, scriptEnd);

try {
  new Function(script);
  console.log('Script parsed OK');
} catch(e) {
  console.error('SYNTAX ERROR:', e.message);
  const match = e.stack.match(/<anonymous>:(\d+):(\d+)/);
  if (match) {
    const errLine = parseInt(match[1]);
    const errCol = parseInt(match[2]);
    console.log('Script line:', errLine, 'col:', errCol);
    console.log('HTML line:', errLine + 893);
    const lines = script.split('\n');
    for (let i = Math.max(0, errLine - 5); i <= Math.min(lines.length - 1, errLine + 3); i++) {
      const marker = (i + 1) === errLine ? '>>>' : '   ';
      const line = lines[i];
      console.log(marker + ' L' + (i + 1) + ' (htmlL' + (i + 1 + 893) + '): ' + line.substring(0, 200));
      if ((i + 1) === errLine && errCol <= line.length + 5) {
        const pointer = '    ' + ' '.repeat(Math.min(errCol - 1, 100)) + '^';
        console.log(pointer);
      }
    }
    // Show chars around error
    if (errLine > 0 && errLine <= lines.length) {
      const line = lines[errLine - 1];
      console.log('\nChar at col ' + errCol + ':', JSON.stringify(line[errCol - 1]));
      console.log('Context (col ' + Math.max(1, errCol-10) + '-' + (errCol+10) + '):', JSON.stringify(line.substring(Math.max(0, errCol - 11), errCol + 10)));
      // Show char codes
      const start = Math.max(0, errCol - 5);
      const end = Math.min(line.length, errCol + 5);
      const codes = [];
      for (let j = start; j < end; j++) {
        codes.push('col' + (j+1) + '=' + line.charCodeAt(j).toString(16));
      }
      console.log('Char codes:', codes.join(' '));
    }
  } else {
    console.log('Could not parse error location from stack:', e.stack.substring(0, 300));
  }
}
