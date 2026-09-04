import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { apply, inject, name } from '../index.mjs'

test('Host 插件从仓库根目录注册唯一的 aico-ppt Skill', async (t) => {
  let createProvider
  let indexListener
  let closeRuntime
  await apply({
    skills: {
      registerProvider(factory) {
        createProvider = factory
      },
    },
    on(event, listener) {
      assert.equal(event, 'webserver/index-inject')
      indexListener = listener
    },
    effect(effect) { closeRuntime = effect() },
  })
  t.after(async () => closeRuntime?.())

  assert.equal(name, 'aico-ppt')
  assert.deepEqual(inject, ['skills', 'webServer'])
  assert.equal(typeof createProvider, 'function')
  const rows = []
  indexListener(rows)
  assert.equal(rows[0].kind, 'global')
  assert.equal(rows[0].name, '__AICO_PPT_BRAND__')
  assert.match(rows[0].value.logo, /^data:image\/png;base64,/u)
  assert.match(rows[0].value.appUrl, /^http:\/\/127\.0\.0\.1:\d+\/app\//u)

  const provider = createProvider()
  const candidates = await provider.list({})
  assert.equal(candidates.length, 1)
  const candidate = candidates[0]
  assert.equal(candidate.name, 'aico-ppt')
  assert.equal(candidate.provider, 'aico-ppt-plugin')
  assert.equal(candidate.source, 'bundled')
  assert.equal(candidate.rank, 600)
  assert.equal(candidate.path, fileURLToPath(new URL('../../../SKILL.md', import.meta.url)))
  assert.equal(candidate.resourceBase.kind, 'directory')

  const definition = await provider.get(candidate, {})
  assert.equal(definition.name, 'aico-ppt')
  assert.match(definition.description, /Huawei-red-brand/)
  assert.match(definition.content, /^# AICO-PPT/u)
  assert.doesNotMatch(definition.content, /^---/u)
})

test('Host 插件拒绝读取其他 Skill 候选', async (t) => {
  let createProvider
  let closeRuntime
  await apply({
    skills: { registerProvider: factory => { createProvider = factory } },
    on() {},
    effect(effect) { closeRuntime = effect() },
  })
  t.after(async () => closeRuntime?.())
  const provider = createProvider()
  assert.equal(await provider.get({ name: 'other-skill' }, {}), undefined)
})
