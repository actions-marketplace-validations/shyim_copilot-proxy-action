const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
for (const directory of ['src', 'scripts', 'test']) {
  for (const name of fs.readdirSync(directory)) {
    if (!name.endsWith('.cjs')) continue;
    const result = spawnSync(process.execPath, ['--check', path.join(directory, name)], { stdio: 'inherit' });
    if (result.status !== 0) process.exit(result.status || 1);
  }
}
console.log('JavaScript syntax checks passed');
