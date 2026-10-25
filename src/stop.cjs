const fs = require('node:fs');
const { markdown } = require('./usage.cjs');
(async () => {
  const pid = Number(process.env['STATE_proxy-pid']);
  if (Number.isInteger(pid) && pid > 0) {
    try {
      process.kill(pid, 'SIGTERM');
      for (let attempt = 0; attempt < 40; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 100));
        try { process.kill(pid, 0); } catch { break; }
      }
      console.log('Stopped Copilot proxy');
    } catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
  const file = process.env['STATE_usage-file'];
  if (file && fs.existsSync(file)) {
    const summary = markdown(JSON.parse(fs.readFileSync(file, 'utf8')));
    console.log(summary);
    if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
