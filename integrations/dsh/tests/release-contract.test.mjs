import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('原装 DSH 发布契约携带私有 Python 和浏览器且不要求宿主渲染器', async () => {
  const release = JSON.parse(await readFile(new URL('../../../aico.release.json', import.meta.url), 'utf8'))
  assert.deepEqual(release.components, ['plugin', 'python', 'browser'])
  assert.equal(release.requires, undefined)
  assert.deepEqual(release.paths, {
    python:{ kind:'file', path:'python/bin/python3' },
    browser:{ kind:'file', path:'browser/chrome' },
  })
  assert.deepEqual(release.targets['win32-x64'].paths, {
    python:{ kind:'file', path:'python/python.exe' },
    browser:{ kind:'file', path:'browser/chrome.exe' },
  })
})
