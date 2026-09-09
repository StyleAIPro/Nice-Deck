/**
 * AICO-PPT 的 DSH Host 入口。
 *
 * 注册规范 Skill，并按显式桌面配置选择独立 Worker 或源码 Editor。
 * 可视化入口复用原 Editor，不在 Host 内启动第二套 Agent。
 */

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import {installEditingTools} from './editing-tools.mjs'
import { installEditingContext } from './editing-context.mjs'
import { startRuntimeWorker } from './runtime-host.mjs'

const PROVIDER_NAME = 'aico-ppt-plugin'
const PACKAGE_ROOT_URL = new URL('../../', import.meta.url)
const SKILL_URL = new URL('../../SKILL.md', import.meta.url)
const BRAND_LOGO_URL = new URL('../../assets/huawei-refs/logos/huawei-横版logo-透明.png', import.meta.url)
const PACKAGE_ROOT = fileURLToPath(PACKAGE_ROOT_URL)
const SKILL_PATH = fileURLToPath(SKILL_URL)
const INVOCATION = Object.freeze({ modelInvocable: true, userInvocable: true })
const BUNDLED_SKILL_RANK = 600

let recordPromise

/** 读取规范 Skill，并去掉仅供发现使用的 YAML 头。 */
async function readCanonicalSkill() {
  if (recordPromise === undefined) {
    recordPromise = readFile(SKILL_URL, 'utf8').then(parseSkillDocument)
  }
  return recordPromise
}

/**
 * 解析本仓库使用的简单 Skill frontmatter。
 * 只接收单行 name/description；复杂 YAML 应交给规范 Skill 加载器处理。
 */
function parseSkillDocument(source) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(source)
  if (match === null) {
    throw new Error('AICO-PPT Skill 缺少 YAML frontmatter')
  }
  const metadata = {}
  for (const line of match[1].split(/\r?\n/)) {
    const colon = line.indexOf(':')
    if (colon <= 0) continue
    metadata[line.slice(0, colon).trim()] = line.slice(colon + 1).trim()
  }
  if (metadata.name !== 'aico-ppt') {
    throw new Error(`AICO-PPT Skill 名称无效：${metadata.name ?? '未填写'}`)
  }
  if (typeof metadata.description !== 'string' || metadata.description === '') {
    throw new Error('AICO-PPT Skill 缺少 description')
  }
  return {
    name: metadata.name,
    description: metadata.description,
    metadata: Object.freeze({ ...metadata }),
    content: source.slice(match[0].length).replace(/^\r?\n/u, ''),
  }
}

function runtimeInstructions() {
  const wrapper = fileURLToPath(new URL('./runtime-run.mjs', import.meta.url))
  const quote = process.platform === 'win32'
    ? value => `'${value.replaceAll("'", "''")}'`
    : value => `'${value.replaceAll("'", "'\\''")}'`
  const command = `${process.platform === 'win32' ? '& ' : ''}${quote(process.execPath)} ${quote(wrapper)}`
  const script = path => quote(fileURLToPath(new URL('../../' + path, import.meta.url)))
  return `\n\n## 当前桌面插件的脚本运行入口\n\n本次 Skill 使用插件自带的 Python 和浏览器。执行本文或 references 中的 Python / Node 脚本时，统一使用以下包装器；不要依赖系统 Python 或修改 Host 环境。包装器读取本包的 .aico-runtime.json，Node 复用 Host 提供的可执行文件。它保留当前工作目录、标准输入、-m / -c / -e 和项目脚本参数；原 Python heredoc 在命令后保留 - 与重定向即可。\n\n\`\`\`${process.platform === 'win32' ? 'powershell' : 'sh'}\n${command} python3 ${script('scripts/check_deps.py')} --profile editor-core --check-only\n${command} node ${script('scripts/verify/shot.mjs')} <Deck绝对路径> <页label> <截图绝对路径>\n\`\`\`\n\n文档中的相对 scripts/ 路径应解析到本 Skill 根目录；项目和 Deck 参数继续指向用户项目，数据目录沿用当前 AICO_HOME / AICO_PPT_EDITOR_STATE_ROOT。不要写入插件发行目录。\n`
}

function createProvider(runtimeConfigured) {
  return {
    name: PROVIDER_NAME,
    async list() {
      const skill = await readCanonicalSkill()
      return [{
        name: skill.name,
        description: skill.description,
        invocation: INVOCATION,
        provider: PROVIDER_NAME,
        source: 'bundled',
        resourceBase: { kind: 'directory', path: PACKAGE_ROOT },
        rank: BUNDLED_SKILL_RANK,
        locator: SKILL_PATH,
        path: SKILL_PATH,
        metadata: skill.metadata,
      }]
    },
    async get(candidate) {
      if (candidate?.name !== 'aico-ppt') return undefined
      const skill = await readCanonicalSkill()
      return {
        name: skill.name,
        description: skill.description,
        invocation: INVOCATION,
        provider: PROVIDER_NAME,
        source: 'bundled',
        resourceBase: { kind: 'directory', path: PACKAGE_ROOT },
        path: SKILL_PATH,
        metadata: skill.metadata,
        content: skill.content + (runtimeConfigured ? runtimeInstructions() : ''),
      }
    },
  }
}

/** Cordis 插件名。 */
export const name = 'aico-ppt'

/** Skill 注册表由 DSH Host 基础组合提供。 */
export const inject = ['skills', 'webServer', 'tools', 'attachments']

/** 注册唯一 Skill，启动本地 Editor 运行时，并把入口作为只读 Client 启动输入。 */
export async function apply(ctx, config = {}) {
  const logo = `data:image/png;base64,${(await readFile(BRAND_LOGO_URL)).toString('base64')}`
  const runtimeConfigured = config.aicoRuntime !== undefined
  const editor = runtimeConfigured
    ? await startRuntimeWorker(config.aicoRuntime)
    : await (await import('../../scripts/editor/app-server.mjs')).startAppServer({
      host:'127.0.0.1', port:0, openBrowser:false, embeddedMode:'dsh',
    })
  let runtimeFailure
  if (editor.done) void editor.done.catch(error => {
    runtimeFailure = error
    if (ctx.logger?.error) ctx.logger.error(error)
    else console.error(error)
  })
  try {
    ctx.effect?.(() => () => editor.close(), 'aico-ppt: DSH Editor 运行时')
    installEditingContext(ctx, editor.appUrl)
    installEditingTools(ctx, editor.appUrl)
    const provider = createProvider(runtimeConfigured)
    ctx.skills.registerProvider(() => provider)
    ctx.on('webserver/index-inject', (table) => {
      if (runtimeFailure) throw runtimeFailure
      table.push({
        kind:'global',
        name:'__AICO_PPT_BRAND__',
        value:{ logo, appUrl:editor.appUrl },
      })
    })
  } catch (error) {
    await editor.close()
    throw error
  }
}
