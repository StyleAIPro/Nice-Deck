/** 在 Worker 的独立环境中加载原 Editor；关闭协议等待应用清理结束。 */
import { parentPort, workerData } from 'node:worker_threads';

let app;
let closing;
const ready = (async () => {
  const { startAppServer, pickDeckWithSystemPicker, pickProjectDirectoryWithSystemPicker } = await import('../../scripts/editor/app-server.mjs');
  const { startServer } = await import('../../scripts/editor/server.mjs');
  const { pickPptxSaveWithSystemPicker } = await import('../../scripts/editor/system-picker.mjs');
  const pickerOptions = options => ({ ...options, pythonExecutable:workerData.paths.python, environment:workerData.desktopDialogs });
  app = await startAppServer({
    host:'127.0.0.1', port:0, openBrowser:false, embeddedMode:'dsh',
    pythonExecutable:workerData.paths.python,
    ...(workerData.desktopDialogs ? {
      pickDeck:options => pickDeckWithSystemPicker(pickerOptions(options)),
      pickAgentProjectDirectory:options => pickProjectDirectoryWithSystemPicker(pickerOptions(options)),
      // 打开已有 Deck 与创建流程中的 Editor 共用这个工厂，保存能力不进入脚本环境。
      startEditor:options => startServer({ ...options,
        pickPptxFile:input => pickPptxSaveWithSystemPicker(pickerOptions(input)),
      }),
    } : {}),
  });
  parentPort.postMessage({ type:'ready', appUrl:app.appUrl });
})();

function fail(error) {
  parentPort.postMessage({ type:'failure', message:error instanceof Error ? error.message : 'Editor 运行失败' });
  process.exitCode = 1;
  parentPort.close();
}

parentPort.on('message', message => {
  if (message?.type !== 'close' || closing) return;
  closing = (async () => {
    await ready;
    await app.close();
    parentPort.postMessage({ type:'closed' });
    parentPort.close();
  })();
  closing.catch(fail);
});
ready.catch(fail);
