/**
 * AICO-PPT 的 DSH Host 入口。
 *
 * 这个模块只负责把仓库中规范的 SKILL.md 暴露给 DSH skill 注册表。
 * 可视化 Editor 属于浏览器 Client 入口，不在 Host 内启动第二套 Agent。
 */

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { startAppServer } from '../../scripts/editor/app-server.mjs'

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

const provider = {
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
      content: skill.content,
    }
  },
}

/** Cordis 插件名。 */
export const name = 'aico-ppt'

/** Skill 注册表由 DSH Host 基础组合提供。 */
export const inject = ['skills', 'webServer']

/** 注册唯一 Skill，启动本地 Editor 运行时，并把入口作为只读 Client 启动输入。 */
export async function apply(ctx) {
  const logo = `data:image/png;base64,${(await readFile(BRAND_LOGO_URL)).toString('base64')}`
  const editor = await startAppServer({
    host:'127.0.0.1',
    port:0,
    openBrowser:false,
    embeddedMode:'dsh',
  })
  ctx.skills.registerProvider(() => provider)
  ctx.on('webserver/index-inject', (table) => {
    table.push({
      kind:'global',
      name:'__AICO_PPT_BRAND__',
      value:{ logo, appUrl:editor.appUrl },
    })
  })
  ctx.effect?.(() => () => editor.close(), 'aico-ppt: DSH Editor 运行时')
}
