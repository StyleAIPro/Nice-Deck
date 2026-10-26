/** 打包时固定运行代码身份，避免热更新重用 package.json 的 CommonJS 缓存。 */
import {readFile,writeFile} from 'node:fs/promises';
const manifest=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8'));
if(!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.version))throw Error('插件版本无效');
const target=new URL('./editor/runtime-version.mjs',import.meta.url);
const content='// 打包时生成，固定在当前加载的代码中，不随磁盘清单改变。\nexport const runtimeVersion = '+JSON.stringify(manifest.version)+';\n';
if(process.argv.includes('--check')){
 if(await readFile(target,'utf8')!==content)throw Error('运行版本未同步，请执行 npm run prepack');
}else await writeFile(target,content);

// 固定 Client 身份，Host 更新完成前不能沿用旧能力令牌；每个新包都重载 Client。
const clientTarget=new URL('../integrations/dsh/client.js',import.meta.url)
const clientSource=await readFile(clientTarget,'utf8')
const clientPattern=/const CLIENT_RUNTIME_VERSION = "[^"\n]+";/
if(!clientPattern.test(clientSource))throw Error('Client 缺少固定运行版本')
const clientContent=clientSource.replace(clientPattern,'const CLIENT_RUNTIME_VERSION = '+JSON.stringify(manifest.version)+';')
if(process.argv.includes('--check')){
 if(clientContent!==clientSource)throw Error('Client 运行版本未同步，请执行 npm run prepack')
}else if(clientContent!==clientSource)await writeFile(clientTarget,clientContent)
