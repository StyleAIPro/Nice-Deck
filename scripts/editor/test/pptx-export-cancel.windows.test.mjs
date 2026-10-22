import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { exportPptxSnapshot } from '../pptx-exporter.mjs';

const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
for (const reason of ['cancel','timeout']) test(`Windows ${reason} 完成前必须终止转换器的真实子进程`, { skip:process.platform !== 'win32' }, async () => {
  const controller = new AbortController();
  let descendant;
  const result = exportPptxSnapshot({
    htmlBytes:Buffer.from('<html>取消进程树验收</html>'), signal:controller.signal, timeoutMs:reason === 'timeout' ? 3000 : 30000,
    spawnProcess:(_exe, _args, options) => {
      const child = spawn(process.execPath, ['-e', `
        const {spawn}=require('node:child_process');
        const child=spawn(process.execPath,['-e','console.log(process.pid);setInterval(()=>{},1000)'],{stdio:['ignore','pipe','ignore']});
        child.stdout.once('data',data=>console.log(data.toString().trim()));setInterval(()=>{},1000);
      `], options);
      child.stdout.once('data', data => { descendant=Number(data.toString().trim());if (reason === 'cancel') controller.abort(); });
      return child;
    },
  });
  try {
    await assert.rejects(result, { code:reason === 'cancel' ? 'PPTX_EXPORT_CANCELLED' : 'PPTX_EXPORT_TIMEOUT' });
    assert.ok(Number.isSafeInteger(descendant));
    assert.equal(alive(descendant), false, '导出取消返回后不得留下转换子进程');
  } finally {
    if (descendant && alive(descendant)) {
      try { await promisify(execFile)('taskkill.exe',['/PID',String(descendant),'/T','/F']); }
      catch (error) { if (alive(descendant)) throw error; }
    }
  }
});
