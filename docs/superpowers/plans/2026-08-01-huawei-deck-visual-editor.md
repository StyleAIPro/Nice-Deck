# Huawei Deck 后期可视化微调编辑器实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 在不转换原 deck 的前提下，为 `renzhi-deck.html` 增加可视化直接编辑、跨页区域标记、外部 Agent 实时处理、统一撤销和安全写回能力。

**架构：** 本地 Node 服务以同源 iframe 加载原 deck，浏览器覆盖层负责拉框、直接编辑和实时预览；外部 Codex/Claude Code 通过 CLI/HTTP 与 WebSocket 协作桥读取任务并提交受控动作。编辑会话保存在 sidecar，最终只把合并后的补丁和离线执行器经 `edit-bundle.py` 原子写回 bundle。

**技术栈：** Python 3 标准库、Node.js ≥ 18、原生 ES Modules、`ws` 8.21.1、`html2canvas` 1.4.1、Node `node:test`、Python `unittest`、现有 Playwright/Chrome verify 工具链。

---

## 0. 文件结构与职责

### 新建文件

| 路径 | 单一职责 |
| --- | --- |
| `package.json` | 固定编辑器依赖与测试命令 |
| `package-lock.json` | 锁定 `ws`、`html2canvas` 依赖树 |
| `scripts/deck-editor.py` | 校验参数并启动本地 Node 编辑服务 |
| `scripts/editor/protocol.mjs` | 页面、区域任务、定位器和动作的纯数据校验 |
| `scripts/editor/session-store.mjs` | sidecar 路径、deck 指纹、任务和 revision 持久化 |
| `scripts/editor/patch-journal.mjs` | 动作分组、合并、撤销、重做和最终补丁编译 |
| `scripts/editor/server.mjs` | 本地 HTTP、WebSocket、文件监视和浏览器启动 |
| `scripts/editor/bridge-service.mjs` | Session API、Action RPC 和编辑器确认回执 |
| `scripts/editor/cli.mjs` | 供 Codex/Claude Code 调用的状态、任务、动作与撤销命令 |
| `scripts/editor/bundle_adapter.py` | 调用 `edit-bundle.py`，嵌补丁、备份、验证和原子写回 |
| `scripts/editor/runtime/patch-runtime.js` | 浏览器内元素定位、动作应用和 React 重建后的幂等重放 |
| `scripts/editor/public/index.html` | 编辑器外壳 DOM |
| `scripts/editor/public/editor.css` | 三栏工作台、选区、弹窗和任务抽屉样式 |
| `scripts/editor/public/editor.mjs` | 外壳状态、页列表、模式切换与 iframe 消息协调 |
| `scripts/editor/public/frame-bridge.mjs` | iframe 内页面发现、拉框、就地编辑、拖拽和诊断 |
| `scripts/editor/public/task-drawer.mjs` | 跨页任务列表、批处理状态、定位与撤销交互 |
| `scripts/editor/public/ws-client.mjs` | 带重连的 WebSocket 客户端 |
| `scripts/editor/test/fixtures/minimal-deck.html` | 两个同名标签页的最小可运行 deck |
| `scripts/editor/test/protocol.test.mjs` | 协议与坐标单元测试 |
| `scripts/editor/test/session-store.test.mjs` | sidecar 与 revision 单元测试 |
| `scripts/editor/test/patch-journal.test.mjs` | 动作合并、撤销与重做单元测试 |
| `scripts/editor/test/patch-runtime.e2e.mjs` | 浏览器定位与补丁重放测试 |
| `scripts/editor/test/server.test.mjs` | HTTP、鉴权与 WebSocket 测试 |
| `scripts/editor/test/editor-shell.e2e.mjs` | iframe 挂载和页列表测试 |
| `scripts/editor/test/region-marking.e2e.mjs` | 拉框、跨页标记、截图和恢复测试 |
| `scripts/editor/test/live-actions.e2e.mjs` | 外部动作、实时预览和统一撤销测试 |
| `scripts/editor/test/save-gate.e2e.mjs` | 溢出、冲突、失败回滚和安全写回测试 |
| `scripts/editor/test/test_bundle_adapter.py` | bundle 适配器 Python 单元测试 |
| `scripts/editor/test/test_launcher.py` | Python 启动器单元测试 |
| `scripts/editor/test/renzhi-pilot.e2e.mjs` | 真实 21 页 deck 的只操作副本验收 |
| `scripts/editor/test/test-helpers.mjs` | E2E 临时服务、浏览器和 iframe 操作助手 |
| `scripts/editor/test/docs-contract.test.mjs` | 四份入口文档的一致性契约测试 |
| `scripts/verify/load-playwright.mjs` | verify 与编辑器测试共用的 Playwright 三级加载器 |

### 修改文件

| 路径 | 修改内容 |
| --- | --- |
| `.gitignore` | 忽略 `.huawei-deck-editor/` 与 `.superpowers/` |
| `scripts/check_deps.py` | 检查并安装 `ws`、`html2canvas` |
| `scripts/verify/measure_overflow.mjs` | 改用共用 Playwright 加载器 |
| `scripts/verify/shot.mjs` | 改用共用 Playwright 加载器 |
| `scripts/verify/steps.mjs` | 改用共用 Playwright 加载器 |
| `scripts/html2pptx/shoot.mjs` | 改用共用 Playwright 加载器 |
| `SKILL.md` | 增加后期可视化微调入口与使用边界 |
| `README.md` | 增加启动示例和人机协作流程 |
| `references/editing-guide.md` | 增加 sidecar、补丁写回、冲突和验证说明 |
| `docs/architecture.md` | 记录编辑器组件、协作桥和补丁运行时 |

## 1. 稳定接口

实现期间保持以下名字和数据形状一致，不能在后续任务中自行改名。

```js
// RegionTask
{
  id, pageKey, pageIndex, pageLabel,
  rect: { x, y, w, h },
  instruction, snapshotPath, candidates,
  status, createdAt, updatedAt
}

// ActionRequest
{
  id, taskId, target, kind, payload, expectedRevision
}

// AppliedAction
{
  ...actionRequest,
  before, after, appliedAt
}

// TargetLocator
{
  pageKey, path, tag, fingerprint, rect
}
```

动作 `kind` 只允许：`setText`、`setStyle`、`translate`、`resize`、`hide`、`show`。

---

### 任务 1：建立依赖、测试入口和忽略规则

**文件：**
- 创建：`package.json`
- 创建：`package-lock.json`
- 修改：`.gitignore`
- 修改：`scripts/check_deps.py`
- 测试：`scripts/editor/test/test_launcher.py`

- [ ] **步骤 1：编写 Node 模块探测的失败测试**

```python
# scripts/editor/test/test_launcher.py
import importlib.util
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
SPEC = importlib.util.spec_from_file_location("check_deps", ROOT / "scripts/check_deps.py")
check_deps = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(check_deps)

class NodeModuleProbeTest(unittest.TestCase):
    def test_builtin_module_exists(self):
        self.assertTrue(check_deps.probe_node_module("node:path")[0])

    def test_missing_module_is_false(self):
        self.assertFalse(check_deps.probe_node_module("huawei-deck-module-that-does-not-exist")[0])
```

- [ ] **步骤 2：运行测试确认缺少探测函数**

运行：

```bash
python3 -m unittest scripts/editor/test/test_launcher.py -v
```

预期：FAIL，报错 `module 'check_deps' has no attribute 'probe_node_module'`。

- [ ] **步骤 3：创建固定依赖与测试命令**

```json
{
  "name": "huawei-deck-skill",
  "private": true,
  "type": "module",
  "scripts": {
    "test:editor:unit": "node --test scripts/editor/test/*.test.mjs",
    "test:editor:e2e": "node --test scripts/editor/test/*.e2e.mjs",
    "test:editor": "npm run test:editor:unit && npm run test:editor:e2e && python3 -m unittest discover -s scripts/editor/test -p 'test_*.py' -v"
  },
  "dependencies": {
    "html2canvas": "1.4.1",
    "ws": "8.21.1"
  }
}
```

运行：

```bash
npm install
```

预期：生成 `package-lock.json`，`npm ls ws html2canvas` 退出码为 0。

- [ ] **步骤 4：实现通用 Node 模块探测并加入依赖清单**

```python
# scripts/check_deps.py
def probe_node_module(mod):
    cp = run(["node", "-e", f"require.resolve({mod!r})"],
             cwd=str(REPO), capture_output=True, text=True)
    return cp.returncode == 0, f"require.resolve('{mod}')"

def probe_nodemod(mod):
    return lambda: probe_node_module(mod)
```

在 `CHECKS` 增加两个必需项，安装命令固定为：

```python
dict(key="ws", label="ws", why="可视化编辑器 WebSocket 协作桥",
     probe=probe_nodemod("ws"), install=["npm", "i", "ws@8.21.1"], install_cwd=str(REPO)),
dict(key="html2canvas", label="html2canvas", why="区域标记局部截图",
     probe=probe_nodemod("html2canvas"), install=["npm", "i", "html2canvas@1.4.1"], install_cwd=str(REPO)),
```

- [ ] **步骤 5：加入本地工作目录忽略规则**

```gitignore
.huawei-deck-editor/
.superpowers/
```

- [ ] **步骤 6：运行依赖与测试验证**

运行：

```bash
python3 -m unittest scripts/editor/test/test_launcher.py -v
python3 scripts/check_deps.py --check-only > /tmp/huawei-deck-editor-deps.txt || test $? -eq 1
rg '✓ ws' /tmp/huawei-deck-editor-deps.txt
rg '✓ html2canvas' /tmp/huawei-deck-editor-deps.txt
npm ls ws html2canvas
```

预期：单元测试 2 项 PASS；体检中 `ws`、`html2canvas` 显示 `✓`；`npm ls` 退出码为 0。

- [ ] **步骤 7：提交**

```bash
git add package.json package-lock.json .gitignore scripts/check_deps.py scripts/editor/test/test_launcher.py
git commit -m "build: 配置 Deck 编辑器依赖与测试入口"
```

---

### 任务 2：定义协议、页面身份和坐标换算

**文件：**
- 创建：`scripts/editor/protocol.mjs`
- 测试：`scripts/editor/test/protocol.test.mjs`

- [ ] **步骤 1：编写失败的协议测试**

```js
// scripts/editor/test/protocol.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { makePageKey, normalizeRect, validateAction, validateTask } from '../protocol.mjs';

test('屏幕框换算并约束在 1920×1080', () => {
  const rect = normalizeRect({ left: 100, top: 50, width: 500, height: 250 },
    { left: 0, top: 0, width: 960, height: 540 });
  assert.deepEqual(rect, { x: 200, y: 100, w: 1000, h: 500 });
});

test('同名页仍生成不同 pageKey', () => {
  assert.notEqual(makePageKey(1, '目录页', '<section>A</section>'),
                  makePageKey(5, '目录页', '<section>A</section>'));
});

test('拒绝越界任务和任意动作类型', () => {
  assert.throws(() => validateTask({ pageKey:'p', rect:{x:-1,y:0,w:10,h:10}, instruction:'改' }));
  assert.throws(() => validateAction({ kind:'replaceOuterHTML', payload:{} }));
});
```

- [ ] **步骤 2：运行测试验证模块不存在**

运行：

```bash
node --test scripts/editor/test/protocol.test.mjs
```

预期：FAIL，报错 `ERR_MODULE_NOT_FOUND`。

- [ ] **步骤 3：实现纯函数协议模块**

```js
// scripts/editor/protocol.mjs
export const ACTION_KINDS = new Set(['setText','setStyle','translate','resize','hide','show']);
export const TASK_STATUSES = new Set(['pending','processing','needs-confirmation','completed','failed']);

export function stableHash(text) {
  let h = 2166136261;
  for (const char of text) { h ^= char.charCodeAt(0); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(16).padStart(8, '0');
}

export function makePageKey(index, label, html) {
  const digest = stableHash(`${index}\0${label}\0${html}`);
  return `page-${String(index).padStart(3, '0')}-${digest}`;
}

export function normalizeRect(rect, canvas) {
  const sx = 1920 / canvas.width, sy = 1080 / canvas.height;
  const x = Math.max(0, Math.min(1920, Math.round((rect.left - canvas.left) * sx)));
  const y = Math.max(0, Math.min(1080, Math.round((rect.top - canvas.top) * sy)));
  const w = Math.max(1, Math.min(1920 - x, Math.round(rect.width * sx)));
  const h = Math.max(1, Math.min(1080 - y, Math.round(rect.height * sy)));
  return { x, y, w, h };
}

export function validateTask(task) {
  if (!task.pageKey || !task.instruction?.trim()) throw new TypeError('任务缺少页面或修改说明');
  const { x, y, w, h } = task.rect ?? {};
  if (![x,y,w,h].every(Number.isFinite) || x < 0 || y < 0 || w <= 0 || h <= 0 || x+w > 1920 || y+h > 1080)
    throw new RangeError('区域必须位于 1920×1080 画布内');
  return task;
}

export function validateAction(action) {
  if (!ACTION_KINDS.has(action.kind)) throw new TypeError(`不支持的动作: ${action.kind}`);
  if (!action.target?.pageKey || !action.target?.path) throw new TypeError('动作缺少目标定位器');
  return action;
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：

```bash
node --test scripts/editor/test/protocol.test.mjs
```

预期：3 项测试 PASS。

- [ ] **步骤 5：提交**

```bash
git add scripts/editor/protocol.mjs scripts/editor/test/protocol.test.mjs
git commit -m "feat: 定义 Deck 编辑器任务与动作协议"
```

---

### 任务 3：实现 sidecar 会话与 revision

**文件：**
- 创建：`scripts/editor/session-store.mjs`
- 测试：`scripts/editor/test/session-store.test.mjs`

- [ ] **步骤 1：编写失败的持久化测试**

```js
// scripts/editor/test/session-store.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore, RevisionConflict } from '../session-store.mjs';

test('跨页任务写入后可恢复且 revision 单调递增', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deck-session-'));
  const deck = join(root, 'deck.html');
  await writeFile(deck, 'deck-v1');
  const store = await SessionStore.open({ deckPath: deck, rootDir: join(root, '.huawei-deck-editor') });
  const t1 = await store.createTask({ pageKey:'page-001-a', pageIndex:1, pageLabel:'A', rect:{x:1,y:2,w:3,h:4}, instruction:'改 A' }, 0);
  const t2 = await store.createTask({ pageKey:'page-002-b', pageIndex:2, pageLabel:'B', rect:{x:5,y:6,w:7,h:8}, instruction:'改 B' }, 1);
  assert.equal(t1.revision, 1); assert.equal(t2.revision, 2);
  const reopened = await SessionStore.open({ deckPath: deck, rootDir: join(root, '.huawei-deck-editor') });
  assert.equal(reopened.state.tasks.length, 2);
  await assert.rejects(() => reopened.createTask({ ...t1.task, id:undefined }, 0), RevisionConflict);
  assert.match(await readFile(reopened.sessionPath, 'utf8'), /改 B/);
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：

```bash
node --test scripts/editor/test/session-store.test.mjs
```

预期：FAIL，报错 `ERR_MODULE_NOT_FOUND`。

- [ ] **步骤 3：实现原子 sidecar 写入与 deck 指纹**

```js
// scripts/editor/session-store.mjs
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { basename, dirname, join, parse } from 'node:path';

export class RevisionConflict extends Error {}
const sha256 = data => createHash('sha256').update(data).digest('hex');

export class SessionStore {
  static async open({ deckPath, rootDir = join(dirname(deckPath), '.huawei-deck-editor') }) {
    const bytes = await readFile(deckPath);
    const deckFingerprint = sha256(bytes);
    const sessionDir = join(rootDir, `${parse(deckPath).name}-${deckFingerprint.slice(0, 8)}`);
    await mkdir(join(sessionDir, 'snapshots'), { recursive:true });
    await mkdir(join(sessionDir, 'backups'), { recursive:true });
    const store = new SessionStore(deckPath, deckFingerprint, sessionDir);
    try { store.state = JSON.parse(await readFile(store.sessionPath, 'utf8')); }
    catch { await store.#persist(); }
    return store;
  }
  constructor(deckPath, deckFingerprint, sessionDir) {
    this.deckPath = deckPath; this.sessionDir = sessionDir;
    this.sessionPath = join(sessionDir, 'session.json');
    this.state = { version:1, deckPath, deckFingerprint, revision:0, tasks:[], groups:[], redo:[] };
  }
  #expect(revision) { if (revision !== this.state.revision) throw new RevisionConflict(`revision ${revision} != ${this.state.revision}`); }
  async #persist() {
    const tmp = `${this.sessionPath}.tmp`;
    await writeFile(tmp, JSON.stringify(this.state, null, 2));
    await rename(tmp, this.sessionPath);
  }
  async createTask(input, expectedRevision) {
    this.#expect(expectedRevision);
    const now = new Date().toISOString();
    const task = { ...input, id:randomUUID(), status:'pending', candidates:input.candidates ?? [], snapshotPath:input.snapshotPath ?? null, createdAt:now, updatedAt:now };
    this.state.tasks.push(task); this.state.revision += 1; await this.#persist();
    return { task, revision:this.state.revision };
  }
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：

```bash
node --test scripts/editor/test/session-store.test.mjs
```

预期：1 项测试 PASS，临时 sidecar 可恢复两条任务。

- [ ] **步骤 5：提交**

```bash
git add scripts/editor/session-store.mjs scripts/editor/test/session-store.test.mjs
git commit -m "feat: 持久化 Deck 编辑会话与版本"
```

---

### 任务 4：实现动作日志、合并与撤销

**文件：**
- 创建：`scripts/editor/patch-journal.mjs`
- 测试：`scripts/editor/test/patch-journal.test.mjs`

- [ ] **步骤 1：编写失败的动作日志测试**

```js
// scripts/editor/test/patch-journal.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { PatchJournal } from '../patch-journal.mjs';

const target = { pageKey:'page-001-a', path:'0/1', tag:'DIV', fingerprint:'f1', rect:{x:0,y:0,w:10,h:10} };

test('同一属性只编译最终值，整组可撤销重做', () => {
  const journal = new PatchJournal();
  const group = journal.appendGroup('task-1', [
    { id:'a1', taskId:'task-1', target, kind:'setText', payload:{text:'新'}, before:'旧', after:'新', appliedAt:'t1' },
    { id:'a2', taskId:'task-1', target, kind:'setText', payload:{text:'更新'}, before:'新', after:'更新', appliedAt:'t2' }
  ]);
  assert.equal(journal.compile()[0].after, '更新');
  assert.deepEqual(journal.undo(group.id).map(x => x.payload.text), ['新','旧']);
  assert.deepEqual(journal.redo(group.id).map(x => x.payload.text), ['新','更新']);
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：

```bash
node --test scripts/editor/test/patch-journal.test.mjs
```

预期：FAIL，报错 `ERR_MODULE_NOT_FOUND`。

- [ ] **步骤 3：实现可序列化的 PatchJournal**

```js
// scripts/editor/patch-journal.mjs
import { randomUUID } from 'node:crypto';

const keyOf = action => `${action.target.pageKey}|${action.target.path}|${action.kind}|${action.payload?.property ?? ''}`;
function inverse(action) {
  let kind = action.kind, payload;
  if (kind === 'setText') payload = { text:action.before };
  if (kind === 'setStyle') payload = { property:action.payload.property, value:action.before };
  if (kind === 'translate' || kind === 'resize') payload = action.before;
  if (kind === 'hide') { kind = 'show'; payload = { display:action.before }; }
  if (kind === 'show') { kind = 'hide'; payload = {}; }
  return { ...action, id:randomUUID(), kind, payload, before:action.after, after:action.before };
}

export class PatchJournal {
  constructor(state = { groups:[], redo:[] }) { this.state = state; }
  appendGroup(taskId, actions) {
    const group = { id:randomUUID(), taskId, actions, active:true };
    this.state.groups.push(group); this.state.redo = []; return group;
  }
  compile() {
    const final = new Map();
    for (const group of this.state.groups) if (group.active)
      for (const action of group.actions) final.set(keyOf(action), action);
    return [...final.values()];
  }
  undo(id) {
    const group = this.state.groups.find(x => x.id === id && x.active);
    if (!group) throw new Error('找不到可撤销动作组');
    group.active = false; this.state.redo.push(id);
    return [...group.actions].reverse().map(inverse);
  }
  redo(id) {
    const group = this.state.groups.find(x => x.id === id && !x.active);
    if (!group || !this.state.redo.includes(id)) throw new Error('找不到可重做动作组');
    group.active = true; this.state.redo = this.state.redo.filter(x => x !== id);
    return group.actions;
  }
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：

```bash
node --test scripts/editor/test/patch-journal.test.mjs
```

预期：1 项测试 PASS。

- [ ] **步骤 5：提交**

```bash
git add scripts/editor/patch-journal.mjs scripts/editor/test/patch-journal.test.mjs
git commit -m "feat: 增加统一补丁日志与撤销重做"
```

---

### 任务 5：实现浏览器定位器与幂等补丁运行时

**文件：**
- 创建：`scripts/editor/runtime/patch-runtime.js`
- 创建：`scripts/editor/test/fixtures/minimal-deck.html`
- 创建：`scripts/verify/load-playwright.mjs`
- 修改：`scripts/verify/measure_overflow.mjs`
- 修改：`scripts/verify/shot.mjs`
- 修改：`scripts/verify/steps.mjs`
- 修改：`scripts/html2pptx/shoot.mjs`
- 测试：`scripts/editor/test/patch-runtime.e2e.mjs`

- [ ] **步骤 1：创建含同名页的最小浏览器夹具**

```html
<!-- scripts/editor/test/fixtures/minimal-deck.html -->
<!doctype html><html><head><meta charset="utf-8"><title>fixture</title></head><body>
<div class="stage">
  <div class="slide-canvas" style="width:1920px;height:1080px"><section data-label="目录页"><h2>第一页标题</h2><div class="card" style="width:300px;height:100px;overflow:hidden">卡片 A</div></section></div>
  <div class="slide-canvas" style="width:1920px;height:1080px"><section data-label="目录页"><h2>第二页标题</h2><div class="card" style="width:300px;height:100px;overflow:hidden">卡片 B</div></section></div>
</div>
<script src="../../runtime/patch-runtime.js"></script>
</body></html>
```

- [ ] **步骤 2：编写失败的浏览器测试**

```js
// scripts/editor/test/patch-runtime.e2e.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { loadChromium } from '../../verify/load-playwright.mjs';

test('定位第二个同名页并幂等重放文字与位移', async () => {
  const chromium = await loadChromium();
  const browser = await chromium.launch({ channel:'chrome', headless:true });
  const page = await browser.newPage({ viewport:{ width:1920, height:1080 } });
  await page.goto(pathToFileURL(resolve('scripts/editor/test/fixtures/minimal-deck.html')).href);
  const result = await page.evaluate(() => {
    const rt = window.HuaweiDeckPatchRuntime;
    const el = document.querySelectorAll('h2')[1];
    const target = rt.makeLocator(el);
    const applied = rt.applyAction({ target, kind:'setText', payload:{ text:'已修改' } });
    rt.applyAction({ target, kind:'translate', payload:{ x:10, y:20 } });
    return { text:el.textContent, translate:el.style.translate, before:applied.before };
  });
  assert.deepEqual(result, { text:'已修改', translate:'10px 20px', before:'第二页标题' });
  await browser.close();
});
```

- [ ] **步骤 3：提取 Playwright 三级加载器供测试复用**

创建 `scripts/verify/load-playwright.mjs`，导出函数且保持现有查找顺序：

```js
export async function loadChromium() {
  const candidates = [process.env.PLAYWRIGHT_CORE, 'playwright-core',
    '/opt/homebrew/lib/node_modules/openclaw/node_modules/playwright-core/index.js'].filter(Boolean);
  for (const candidate of candidates) {
    try { const mod = await import(candidate); return (mod.default ?? mod).chromium; } catch {}
  }
  throw new Error(`无法加载 playwright-core（已尝试: ${candidates.join(' → ')}）`);
}
```

同时修改 `measure_overflow.mjs`、`shot.mjs`、`steps.mjs` 和 `html2pptx/shoot.mjs`，删除各自的重复加载函数，改为：

```js
import { loadChromium } from './load-playwright.mjs';
```

`html2pptx/shoot.mjs` 使用相对路径 `../verify/load-playwright.mjs`。

四个调用方都要保留原退出码契约：

```js
let chromium;
try { chromium = await loadChromium(); }
catch (error) { console.error(error.message); process.exit(2); }
```

- [ ] **步骤 4：运行现有 verify 帮助路径，确认加载器重构没有语法错误**

运行：

```bash
node --check scripts/verify/load-playwright.mjs
node --check scripts/verify/measure_overflow.mjs
node --check scripts/verify/shot.mjs
node --check scripts/verify/steps.mjs
node --check scripts/html2pptx/shoot.mjs
node --test scripts/editor/test/patch-runtime.e2e.mjs
```

预期：五个 `node --check` 退出码为 0；浏览器测试先因 `HuaweiDeckPatchRuntime` 不存在而 FAIL。

- [ ] **步骤 5：实现无依赖 IIFE 补丁运行时**

```js
// scripts/editor/runtime/patch-runtime.js
(() => {
  const slides = () => [...document.querySelectorAll('.stage .slide-canvas')];
  const fnv1a = text => { let h=2166136261; for (const c of text) { h ^= c.charCodeAt(0); h = Math.imul(h,16777619); } return (h>>>0).toString(16).padStart(8,'0'); };
  const pageKeys = new WeakMap(), locators = new WeakMap(), resolved = new Map();
  let activeActions = [], replayTimer = 0;
  const pageKey = canvas => {
    if (pageKeys.has(canvas)) return pageKeys.get(canvas);
    const index = slides().indexOf(canvas) + 1;
    const section = canvas.querySelector('section[data-label]');
    const key = `page-${String(index).padStart(3,'0')}-${fnv1a(`${index}\0${section?.dataset.label ?? ''}\0${section?.outerHTML ?? ''}`)}`;
    pageKeys.set(canvas, key); return key;
  };
  const pathOf = (root, el) => { const path=[]; while (el && el !== root) { const parent=el.parentElement; path.unshift([...parent.children].indexOf(el)); el=parent; } return path.join('/'); };
  const fingerprint = el => fnv1a(`${el.tagName}\0${el.className}\0${(el.textContent ?? '').trim().slice(0,120)}\0${el.getAttribute('style') ?? ''}`);
  const locatorKey = locator => `${locator.pageKey}|${locator.path}|${locator.tag}|${locator.fingerprint}`;
  function makeLocator(el) {
    if (locators.has(el)) return locators.get(el);
    const canvas = el.closest('.slide-canvas');
    const section = canvas?.querySelector('section[data-label]');
    const r = el.getBoundingClientRect(), c = canvas.getBoundingClientRect();
    const locator = { pageKey:pageKey(canvas), path:pathOf(section, el), tag:el.tagName, fingerprint:fingerprint(el), rect:{x:Math.round((r.left-c.left)*1920/c.width),y:Math.round((r.top-c.top)*1080/c.height),w:Math.round(r.width*1920/c.width),h:Math.round(r.height*1080/c.height)} };
    locators.set(el, locator); resolved.set(locatorKey(locator), el); return locator;
  }
  function resolve(locator) {
    const cached = resolved.get(locatorKey(locator));
    if (cached?.isConnected) return cached;
    const canvas = slides().find(c => pageKey(c) === locator.pageKey);
    if (!canvas) throw new Error('PAGE_NOT_FOUND');
    let el = canvas.querySelector('section[data-label]');
    for (const part of locator.path.split('/').filter(Boolean)) el = el?.children[Number(part)];
    if (!el || el.tagName !== locator.tag) throw new Error('TARGET_NOT_FOUND');
    if (fingerprint(el) !== locator.fingerprint) throw new Error('TARGET_AMBIGUOUS');
    resolved.set(locatorKey(locator), el);
    return el;
  }
  function applyAction(action) {
    const el = resolve(action.target); let before, after;
    if (action.kind === 'setText') { before=el.textContent; after=action.payload.text; if (before !== after) el.textContent=after; }
    if (action.kind === 'translate') { const parts=(el.style.translate || '0px 0px').split(/\s+/); before={x:parseFloat(parts[0])||0,y:parseFloat(parts[1])||0}; after=action.payload; el.style.translate=`${after.x}px ${after.y}px`; }
    if (action.kind === 'resize') { before={width:el.style.width,height:el.style.height,scale:el.style.scale}; Object.assign(el.style, action.payload); after=action.payload; }
    if (action.kind === 'setStyle') { before=el.style.getPropertyValue(action.payload.property); after=action.payload.value; el.style.setProperty(action.payload.property, after); }
    if (action.kind === 'hide' || action.kind === 'show') { before=el.style.display; after=action.kind === 'hide'?'none':(action.payload.display ?? ''); el.style.display=after; }
    return { ...action, before, after, appliedAt:new Date().toISOString() };
  }
  function applyAll(actions) {
    activeActions = actions;
    const applied=[]; for (const action of actions) { try { applied.push(applyAction(action)); } catch (error) { if (!['PAGE_NOT_FOUND','TARGET_NOT_FOUND'].includes(error.message)) throw error; } }
    return applied;
  }
  new MutationObserver(() => {
    clearTimeout(replayTimer);
    replayTimer = setTimeout(() => { if (activeActions.length) applyAll(activeActions); }, 30);
  }).observe(document.documentElement, { childList:true, subtree:true });
  window.HuaweiDeckPatchRuntime = { pageKey, makeLocator, resolve, applyAction, applyAll };
})();
```

`frame-bridge.mjs` 必须在文字或样式发生变化前调用 `makeLocator(el)` 并缓存结果；不能在用户完成改字后重新生成定位器。

- [ ] **步骤 6：运行测试验证通过**

运行：

```bash
node --test scripts/editor/test/patch-runtime.e2e.mjs
```

预期：1 项浏览器测试 PASS。

- [ ] **步骤 7：提交**

```bash
git add scripts/editor/runtime/patch-runtime.js scripts/editor/test/fixtures/minimal-deck.html scripts/editor/test/patch-runtime.e2e.mjs scripts/verify/load-playwright.mjs scripts/verify/measure_overflow.mjs scripts/verify/shot.mjs scripts/verify/steps.mjs scripts/html2pptx/shoot.mjs
git commit -m "feat: 增加浏览器补丁定位与幂等运行时"
```

---

### 任务 6：实现 bundle 补丁嵌入与失败回滚

**文件：**
- 创建：`scripts/editor/bundle_adapter.py`
- 测试：`scripts/editor/test/test_bundle_adapter.py`

- [ ] **步骤 1：编写失败的 bundle 适配器测试**

```python
# scripts/editor/test/test_bundle_adapter.py
import hashlib, importlib.util, json, tempfile, unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
SPEC = importlib.util.spec_from_file_location("bundle_adapter", ROOT / "scripts/editor/bundle_adapter.py")
bundle_adapter = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(bundle_adapter)

def minimal_bundle(path):
    template = '<!doctype html><body><div class="stage"></div></body>'
    path.write_text('<script type="__bundler/manifest">\n{}\n</script>\n<script type="__bundler/template">\n' + json.dumps(template) + '\n</script>', encoding='utf-8')

class BundleAdapterTest(unittest.TestCase):
    def test_write_is_idempotent_and_backup_is_exact(self):
        with tempfile.TemporaryDirectory() as td:
            deck = Path(td) / 'deck.html'; minimal_bundle(deck)
            original = hashlib.sha256(deck.read_bytes()).hexdigest()
            result = bundle_adapter.write_patches(deck, [{"kind":"setText"}], Path(td) / 'session')
            first = deck.read_text(encoding='utf-8')
            bundle_adapter.write_patches(deck, [{"kind":"setText"}], Path(td) / 'session')
            self.assertEqual(first, deck.read_text(encoding='utf-8'))
            self.assertEqual(original, hashlib.sha256(Path(result['backup']).read_bytes()).hexdigest())
```

- [ ] **步骤 2：运行测试验证失败**

运行：

```bash
python3 -m unittest scripts/editor/test/test_bundle_adapter.py -v
```

预期：FAIL，报错找不到 `bundle_adapter.py`。

- [ ] **步骤 3：实现 marker 替换、临时验证和原子替换**

```python
# scripts/editor/bundle_adapter.py
from pathlib import Path
import hashlib, importlib.util, json, os, shutil, tempfile, time

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location('eb', ROOT / 'scripts/edit-bundle.py')
eb = importlib.util.module_from_spec(SPEC); SPEC.loader.exec_module(eb)
BEGIN = '<!-- huawei-deck-editor:begin -->'
END = '<!-- huawei-deck-editor:end -->'

def _block(patches):
    runtime = (ROOT / 'scripts/editor/runtime/patch-runtime.js').read_text(encoding='utf-8')
    data = json.dumps(patches, ensure_ascii=False, separators=(',', ':')).replace('</', '<\\u002F')
    return f'{BEGIN}\n<script type="application/json" id="huawei-deck-editor-patches">{data}</script>\n<script>{runtime}\n;window.HuaweiDeckPatchRuntime.applyAll?.(JSON.parse(document.getElementById("huawei-deck-editor-patches").textContent));</script>\n{END}'

def write_patches(deck_path, patches, session_dir):
    deck_path, session_dir = Path(deck_path).resolve(), Path(session_dir).resolve()
    backups = session_dir / 'backups'; backups.mkdir(parents=True, exist_ok=True)
    digest = hashlib.sha256(deck_path.read_bytes()).hexdigest()
    backup = backups / f'{deck_path.stem}-{digest[:8]}.html'
    if not backup.exists(): shutil.copy2(deck_path, backup)
    lines = eb.load(deck_path); template = eb.get_template(lines); block = _block(patches)
    if BEGIN in template:
        start, end = template.index(BEGIN), template.index(END) + len(END)
        template = template[:start] + block + template[end:]
    else:
        template = template.replace('</body>', block + '\n</body>')
    eb.set_template(lines, template)
    fd, tmp_name = tempfile.mkstemp(prefix=f'.{deck_path.name}.', suffix='.tmp', dir=deck_path.parent)
    os.close(fd); tmp = Path(tmp_name)
    try:
        eb.save(tmp, lines); eb.verify(tmp); os.replace(tmp, deck_path)
    finally:
        if tmp.exists(): tmp.unlink()
    return {'backup':str(backup), 'fingerprint':hashlib.sha256(deck_path.read_bytes()).hexdigest()}
```

- [ ] **步骤 4：增加验证失败不覆盖的测试**

```python
def test_verification_failure_keeps_original(self):
    from unittest import mock
    with tempfile.TemporaryDirectory() as td:
        deck = Path(td) / 'deck.html'; minimal_bundle(deck)
        original = deck.read_bytes()
        with mock.patch.object(bundle_adapter.eb, 'verify', side_effect=AssertionError('bad')):
            with self.assertRaises(AssertionError):
                bundle_adapter.write_patches(deck, [], Path(td) / 'session')
        self.assertEqual(original, deck.read_bytes())
```

- [ ] **步骤 5：运行测试验证通过**

运行：

```bash
python3 -m unittest scripts/editor/test/test_bundle_adapter.py -v
```

预期：2 项测试 PASS。

- [ ] **步骤 6：提交**

```bash
git add scripts/editor/bundle_adapter.py scripts/editor/test/test_bundle_adapter.py scripts/editor/runtime/patch-runtime.js
git commit -m "feat: 安全嵌入 Deck 补丁并支持失败回滚"
```

---

### 任务 7：实现本地 HTTP、WebSocket 与鉴权

**文件：**
- 创建：`scripts/editor/server.mjs`
- 创建：`scripts/editor/bridge-service.mjs`
- 测试：`scripts/editor/test/server.test.mjs`

- [ ] **步骤 1：编写失败的服务测试**

```js
// scripts/editor/test/server.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { startServer } from '../server.mjs';

test('拒绝无令牌请求并向 WebSocket 推送新任务', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deck-server-'));
  const deck = join(root, 'deck.html'); await writeFile(deck, 'deck');
  const app = await startServer({ deckPath:deck, host:'127.0.0.1', port:0, openBrowser:false, token:'secret' });
  assert.equal((await fetch(`${app.url}/api/session`)).status, 403);
  const ws = new WebSocket(`${app.wsUrl}?token=secret`);
  await new Promise(resolve => ws.once('open', resolve));
  const event = new Promise(resolve => ws.once('message', data => resolve(JSON.parse(data))));
  const response = await fetch(`${app.url}/api/tasks?token=secret`, { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({ expectedRevision:0, pageKey:'page-001-a', pageIndex:1, pageLabel:'A', rect:{x:1,y:2,w:3,h:4}, instruction:'修改' }) });
  assert.equal(response.status, 201); assert.equal((await event).type, 'task-created');
  ws.close(); await app.close();
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：

```bash
node --test scripts/editor/test/server.test.mjs
```

预期：FAIL，报错 `ERR_MODULE_NOT_FOUND`。

- [ ] **步骤 3：实现 startServer 与最小 API**

`startServer()` 必须返回：

```js
{ url, wsUrl, token, port, deckPath, sessionDir, session, close }
```

HTTP 路由固定为：

```text
GET  /api/session
GET  /api/tasks
POST /api/tasks
GET  /api/tasks/:id
POST /api/actions
POST /api/groups/:id/undo
POST /api/groups/:id/redo
POST /api/write-deck
GET  /preview
GET  /editor/*
```

鉴权实现：

```js
function authorize(request, url, token) {
  const bearer = request.headers.authorization?.replace(/^Bearer\s+/i, '');
  if (url.searchParams.get('token') !== token && bearer !== token) {
    const error = new Error('FORBIDDEN'); error.statusCode = 403; throw error;
  }
}
```

WebSocket 只接受 `/events?token=secret`，广播事件结构固定为 `{ type, revision, payload }`。

- [ ] **步骤 4：实现 Action RPC 回执**

`bridge-service.mjs` 维护 `commandId → Promise`：

```js
import { randomUUID } from 'node:crypto';

export class BridgeService {
  async requestApply(actions, expectedRevision) {
    if (!this.editorSocket) throw Object.assign(new Error('EDITOR_OFFLINE'), { statusCode:409 });
    this.assertRevision(expectedRevision);
    const commandId = randomUUID();
    this.editorSocket.send(JSON.stringify({ type:'apply-actions', commandId, actions }));
    return await this.waitFor(commandId, 10_000);
  }
}
```

编辑器回传 `{ type:'actions-applied', commandId, applied }` 后才将动作写入 PatchJournal 并递增 revision。
`POST /api/actions` 成功响应固定为 `{ groupId, revision, applied }`，供任务抽屉和保存闸门测试精确撤销该组。

- [ ] **步骤 5：运行服务测试验证通过**

运行：

```bash
node --test scripts/editor/test/server.test.mjs
```

预期：鉴权、任务创建、WebSocket 广播测试 PASS，进程无遗留端口。

- [ ] **步骤 6：提交**

```bash
git add scripts/editor/server.mjs scripts/editor/bridge-service.mjs scripts/editor/test/server.test.mjs
git commit -m "feat: 增加本地 Deck 协作桥服务"
```

---

### 任务 8：实现启动器与外部 Agent CLI

**文件：**
- 创建：`scripts/deck-editor.py`
- 创建：`scripts/editor/cli.mjs`
- 修改：`scripts/editor/test/test_launcher.py`

- [ ] **步骤 1：为启动参数编写失败测试**

```python
class LauncherCommandTest(unittest.TestCase):
    def test_builds_node_command_without_shell(self):
        deck = ROOT / "Deck-Projects/renzhi/renzhi-deck.html"
        cmd = launcher.build_command(deck, host="127.0.0.1", port=0, no_open=True)
        self.assertEqual(cmd[:2], ["node", str(ROOT / "scripts/editor/server.mjs")])
        self.assertIn(str(deck.resolve()), cmd)
        self.assertNotIn("shell=True", repr(cmd))
```

将 `scripts/deck-editor.py` 以 `launcher` 名称加载到现有测试文件。

- [ ] **步骤 2：运行测试验证失败**

运行：

```bash
python3 -m unittest scripts/editor/test/test_launcher.py -v
```

预期：FAIL，报错找不到 `scripts/deck-editor.py`。

- [ ] **步骤 3：实现 Python 启动器**

```python
#!/usr/bin/env python3
from pathlib import Path
import argparse, subprocess, sys

ROOT = Path(__file__).resolve().parent.parent
def build_command(deck, host="127.0.0.1", port=0, no_open=False):
    cmd = ["node", str(ROOT / "scripts/editor/server.mjs"), str(Path(deck).resolve()), "--host", host, "--port", str(port)]
    if no_open: cmd.append("--no-open")
    return cmd

def main(argv=None):
    parser = argparse.ArgumentParser(description="启动 Huawei Deck 后期微调编辑器")
    parser.add_argument("deck"); parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=0); parser.add_argument("--no-open", action="store_true")
    args = parser.parse_args(argv)
    deck = Path(args.deck).resolve()
    if not deck.is_file(): parser.error(f"找不到 deck 文件: {deck}")
    return subprocess.call(build_command(deck, args.host, args.port, args.no_open))

if __name__ == "__main__": sys.exit(main())
```

- [ ] **步骤 4：实现 Agent CLI**

固定命令：

```bash
node scripts/editor/cli.mjs --url http://127.0.0.1:PORT --token TOKEN status
node scripts/editor/cli.mjs --url http://127.0.0.1:PORT --token TOKEN tasks
node scripts/editor/cli.mjs --url http://127.0.0.1:PORT --token TOKEN task TASK_ID
node scripts/editor/cli.mjs --url http://127.0.0.1:PORT --token TOKEN apply actions.json
node scripts/editor/cli.mjs --url http://127.0.0.1:PORT --token TOKEN undo GROUP_ID
```

输出一律为 JSON；HTTP 非 2xx 时 stderr 打印服务返回并以退出码 1 结束；参数错误退出码 2。

- [ ] **步骤 5：运行启动器和 CLI 冒烟测试**

运行：

```bash
python3 -m unittest scripts/editor/test/test_launcher.py -v
python3 scripts/deck-editor.py --help
node scripts/editor/cli.mjs --help
```

预期：Python 测试 PASS；两个帮助命令退出码为 0，并列出上述参数。

- [ ] **步骤 6：提交**

```bash
git add scripts/deck-editor.py scripts/editor/cli.mjs scripts/editor/test/test_launcher.py
git commit -m "feat: 增加 Deck 编辑器启动器与 Agent CLI"
```

---

### 任务 9：实现三栏外壳、iframe 挂载和页发现

**文件：**
- 创建：`scripts/editor/public/index.html`
- 创建：`scripts/editor/public/editor.css`
- 创建：`scripts/editor/public/editor.mjs`
- 创建：`scripts/editor/public/frame-bridge.mjs`
- 创建：`scripts/editor/public/ws-client.mjs`
- 创建：`scripts/editor/test/test-helpers.mjs`
- 测试：`scripts/editor/test/editor-shell.e2e.mjs`
- 修改：`scripts/editor/server.mjs`

- [ ] **步骤 1：编写失败的外壳 E2E 测试**

```js
// scripts/editor/test/editor-shell.e2e.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { startFixtureServer, openEditor } from './test-helpers.mjs';

test('iframe 挂载后发现两个同名页并显示独立页序', async () => {
  const app = await startFixtureServer(); const { browser, page } = await openEditor(app);
  await page.waitForSelector('[data-page-key]');
  const pages = await page.locator('[data-page-key]').allTextContents();
  assert.deepEqual(pages.map(x => x.trim()), ['01 目录页','02 目录页']);
  assert.equal(await page.locator('#deck-frame').getAttribute('src'), `/preview?token=${app.token}`);
  await browser.close(); await app.close();
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：

```bash
node --test scripts/editor/test/editor-shell.e2e.mjs
```

预期：FAIL，报错找不到 `test-helpers.mjs` 或编辑器页面。

- [ ] **步骤 3：实现测试助手与 preview 注入**

`server.mjs` 的 `/preview` 读取 deck 但不修改磁盘，在文档 body 结束标签前注入：

```html
<script src="/editor/html2canvas.min.js"></script>
<script type="module" src="/editor/frame-bridge.mjs"></script>
```

服务静态提供 `node_modules/html2canvas/dist/html2canvas.min.js`，不能暴露整个 `node_modules` 目录。

`frame-bridge.mjs` 先检查 `window.HuaweiDeckPatchRuntime`；已写回过补丁的 deck 直接复用内嵌运行时，未写回过的 deck 才动态加载 `/editor/patch-runtime.js`，防止同一页面出现两个运行时实例。

`test-helpers.mjs` 提供确定性夹具：

```js
import { copyFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadChromium } from '../../verify/load-playwright.mjs';
import { startServer } from '../server.mjs';

export async function startFixtureServer() {
  const root = await mkdtemp(join(tmpdir(), 'deck-editor-fixture-'));
  const deckPath = join(root, 'minimal-deck.html');
  await copyFile(resolve('scripts/editor/test/fixtures/minimal-deck.html'), deckPath);
  return startServer({ deckPath, host:'127.0.0.1', port:0, openBrowser:false, token:'fixture-token' });
}
export async function openEditor(app) {
  const chromium = await loadChromium();
  const browser = await chromium.launch({ channel:'chrome', headless:true });
  const page = await browser.newPage({ viewport:{width:1440,height:900} });
  await page.goto(`${app.url}/?token=${app.token}`); await page.waitForSelector('#deck-frame');
  return { browser, page };
}
export async function dragInFrame(page, start, end) {
  const box = await page.locator('#deck-frame').boundingBox();
  await page.mouse.move(box.x+start.x, box.y+start.y);
  await page.mouse.down(); await page.mouse.move(box.x+end.x, box.y+end.y); await page.mouse.up();
}
```

- [ ] **步骤 4：实现三栏外壳与 iframe ready 协议**

`frame-bridge.mjs` 在 `.stage .slide-canvas` 出现后发送：

```js
parent.postMessage({ type:'deck-ready', pages:[...document.querySelectorAll('.stage .slide-canvas')].map((canvas, index) => ({
  index:index+1,
  label:canvas.querySelector('section[data-label]')?.dataset.label ?? `第 ${index+1} 页`,
  pageKey:window.HuaweiDeckPatchRuntime.pageKey(canvas)
})) }, location.origin);
```

`editor.mjs` 只接收 `event.origin === location.origin` 且 `event.source === deckFrame.contentWindow` 的消息。

- [ ] **步骤 5：实现 WebSocket 重连状态**

`ws-client.mjs` 对外暴露：

```js
export function connectEvents({ url, token, onEvent, onState })
```

重连间隔依次为 250、500、1000、2000、5000 ms；断连时 `onState('offline')`，连接后 `onState('online')`。

- [ ] **步骤 6：运行外壳测试验证通过**

运行：

```bash
node --test scripts/editor/test/editor-shell.e2e.mjs
```

预期：2 个同名页均显示，pageKey 不同，iframe src 带令牌。

- [ ] **步骤 7：提交**

```bash
git add scripts/editor/public scripts/editor/server.mjs scripts/editor/test/editor-shell.e2e.mjs scripts/editor/test/test-helpers.mjs
git commit -m "feat: 搭建 Deck 编辑器三栏工作台"
```

---

### 任务 10：实现拉框、就地输入和跨页任务抽屉

**文件：**
- 修改：`scripts/editor/public/frame-bridge.mjs`
- 创建：`scripts/editor/public/task-drawer.mjs`
- 修改：`scripts/editor/public/editor.mjs`
- 修改：`scripts/editor/public/editor.css`
- 修改：`scripts/editor/server.mjs`
- 修改：`scripts/editor/session-store.mjs`
- 测试：`scripts/editor/test/region-marking.e2e.mjs`

- [ ] **步骤 1：编写失败的跨页标记测试**

```js
// scripts/editor/test/region-marking.e2e.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { startFixtureServer, openEditor, dragInFrame } from './test-helpers.mjs';

test('拉框弹输入框并跨页持久化两条任务', async () => {
  const app = await startFixtureServer(); const { browser, page } = await openEditor(app);
  await page.click('[data-mode="region"]');
  await dragInFrame(page, {x:100,y:100}, {x:400,y:300});
  const frame = page.frameLocator('#deck-frame');
  await frame.locator('[data-region-popover] textarea').fill('第一页修改');
  await frame.locator('[data-region-submit]').click();
  await page.click('[data-page-index="2"]');
  await dragInFrame(page, {x:200,y:120}, {x:500,y:320});
  await frame.locator('[data-region-popover] textarea').fill('第二页修改');
  await frame.locator('[data-region-submit]').click();
  assert.equal(await page.locator('[data-task-row]').count(), 2);
  assert.deepEqual(await page.locator('[data-page-badge]').allTextContents(), ['1','1']);
  await page.reload(); await page.waitForSelector('[data-task-row]');
  assert.equal(await page.locator('[data-task-row]').count(), 2);
  await browser.close(); await app.close();
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：

```bash
node --test scripts/editor/test/region-marking.e2e.mjs
```

预期：FAIL，找不到区域模式按钮或弹窗。

- [ ] **步骤 3：实现标准坐标拉框与邻近弹窗**

`frame-bridge.mjs` 在区域模式 capture `pointerdown/move/up`，只允许从当前 `.slide-canvas` 内开始；使用 `setPointerCapture`；小于 6×6 屏幕像素的框视为误操作。

提交消息固定为：

```js
parent.postMessage({ type:'create-region-task', payload:{
  pageKey, pageIndex, pageLabel,
  rect:normalizeRect(screenRect, canvas.getBoundingClientRect()),
  instruction,
  candidates:rankCandidates(canvas, screenRect)
}}, location.origin);
```

候选排序使用相交面积占元素面积的比例，过滤编辑器自身节点，并最多返回 12 个定位器：

```js
function rankCandidates(canvas, region) {
  const area = r => Math.max(0, Math.min(r.right,region.right)-Math.max(r.left,region.left)) *
                    Math.max(0, Math.min(r.bottom,region.bottom)-Math.max(r.top,region.top));
  return [...canvas.querySelectorAll('h1,h2,h3,h4,p,span,img,svg,table,[class]')]
    .filter(el => !el.closest('[data-deck-editor-ui]'))
    .map(el => { const r=el.getBoundingClientRect(); return { el, score:area(r)/Math.max(1,r.width*r.height) }; })
    .filter(item => item.score > 0.05)
    .sort((a,b) => b.score-a.score)
    .slice(0,12)
    .map(item => runtime.makeLocator(item.el));
}
```

弹窗先向右显示；右侧空间不足时显示在左侧；上下均不足时钉在选区内右下角。

- [ ] **步骤 4：实现局部截图**

在提交前调用：

```js
const canvas = await html2canvas(slideCanvas, { backgroundColor:null, scale:0.5, logging:false });
const crop = document.createElement('canvas');
crop.width = Math.ceil(rect.w * 0.5); crop.height = Math.ceil(rect.h * 0.5);
crop.getContext('2d').drawImage(canvas, rect.x*0.5, rect.y*0.5, rect.w*0.5, rect.h*0.5, 0, 0, crop.width, crop.height);
const snapshot = crop.toDataURL('image/png');
```

POST `/api/tasks` 时带 `snapshot`；服务把 base64 解码到 `snapshots/task-id.png`，session JSON 只保存相对路径。

- [ ] **步骤 5：实现任务抽屉和定位回看**

`task-drawer.mjs` 导出：

```js
export function renderTaskDrawer(root, { tasks, onLocate, onProcessAll, onUndo })
```

点击定位发送 `{ type:'locate-task', pageKey, rect }` 给 iframe；iframe 切页并显示 1500 ms 红色虚线框。

- [ ] **步骤 6：运行跨页标记测试验证通过**

运行：

```bash
node --test scripts/editor/test/region-marking.e2e.mjs
```

预期：跨两页产生两条任务、徽标分别为 1、刷新后仍为两条，sidecar 下存在两个 PNG。

- [ ] **步骤 7：提交**

```bash
git add scripts/editor/public scripts/editor/server.mjs scripts/editor/session-store.mjs scripts/editor/test/region-marking.e2e.mjs scripts/editor/test/test-helpers.mjs
git commit -m "feat: 支持跨页区域标记与任务抽屉"
```

---

### 任务 11：实现直接编辑与 Agent 实时动作

**文件：**
- 修改：`scripts/editor/public/frame-bridge.mjs`
- 修改：`scripts/editor/public/editor.mjs`
- 修改：`scripts/editor/bridge-service.mjs`
- 修改：`scripts/editor/session-store.mjs`
- 修改：`scripts/editor/patch-journal.mjs`
- 测试：`scripts/editor/test/live-actions.e2e.mjs`

- [ ] **步骤 1：编写失败的人工与 Agent 共用日志测试**

```js
// scripts/editor/test/live-actions.e2e.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { startFixtureServer, openEditor } from './test-helpers.mjs';

test('人工改字与 HTTP 位移动作实时生效并可整批撤销', async () => {
  const app = await startFixtureServer(); const { browser, page } = await openEditor(app);
  const frame = page.frameLocator('#deck-frame');
  const target = await frame.locator('h2').first().evaluate(el => window.HuaweiDeckPatchRuntime.makeLocator(el));
  await page.click('[data-mode="text"]');
  await frame.locator('h2').first().dblclick();
  await frame.locator('h2').first().fill('人工新标题');
  await frame.locator('h2').first().press('Meta+Enter');
  const state = await (await fetch(`${app.url}/api/session?token=${app.token}`)).json();
  const response = await fetch(`${app.url}/api/actions?token=${app.token}`, { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({ expectedRevision:state.revision, taskId:null, actions:[{ id:'move-1', taskId:null, target, kind:'translate', payload:{x:20,y:10}, expectedRevision:state.revision }] }) });
  assert.equal(response.status, 200);
  await page.waitForFunction(() => document.querySelector('#deck-frame').contentDocument.querySelector('h2').style.translate === '20px 10px');
  assert.equal(await frame.locator('h2').first().textContent(), '人工新标题');
  await browser.close(); await app.close();
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：

```bash
node --test scripts/editor/test/live-actions.e2e.mjs
```

预期：FAIL，直接编辑或 Action RPC 尚未实现。

- [ ] **步骤 3：实现直接改文字**

只允许简单文本元素进入 `contenteditable="plaintext-only"`；含交互控件、SVG、iframe、`.layer-panel` 或多层富文本 span 的元素不进入直接文字模式，改用区域标记。

提交人工动作：

```js
const target = runtime.makeLocator(el); // 进入 contenteditable 前冻结定位器
enablePlainTextEditing(el);
sendManualActions([{ id:crypto.randomUUID(), taskId:null, target, kind:'setText', payload:{text:el.textContent}, before:originalText }]);
```

Escape 恢复原文字，Cmd/Ctrl+Enter 提交。

- [ ] **步骤 4：实现拖拽和缩放**

移动动作使用绝对位移补丁：

```js
{ kind:'translate', payload:{ x:Math.round(dx * 1920/canvasRect.width), y:Math.round(dy * 1080/canvasRect.height) } }
```

普通块的边角控制点生成 `resize` 的 `{ width, height }`；SVG、交互组件和深层组合生成 `{ scale }`，不改写 `transform`。

- [ ] **步骤 5：完成 Action RPC 与统一日志**

浏览器收到 `apply-actions` 后逐条调用 `patch-runtime.applyAction`，只在全部动作成功时回传 `actions-applied`。任一定位失败时回传：

```js
{ type:'actions-rejected', commandId, code:'TARGET_AMBIGUOUS', failedActionId, candidates }
```

服务将成功动作写入同一个 `PatchJournal`；人工动作也经过 SessionStore 并创建动作组。

- [ ] **步骤 6：运行实时动作测试验证通过**

运行：

```bash
node --test scripts/editor/test/live-actions.e2e.mjs
```

预期：人工标题和 Agent 位移均实时可见；会话中产生两个动作组；撤销后恢复原文字与空位移。

- [ ] **步骤 7：提交**

```bash
git add scripts/editor/public scripts/editor/bridge-service.mjs scripts/editor/session-store.mjs scripts/editor/patch-journal.mjs scripts/editor/test/live-actions.e2e.mjs
git commit -m "feat: 统一人工编辑与 Agent 实时动作"
```

---

### 任务 12：实现诊断、文件冲突和保存闸门

**文件：**
- 修改：`scripts/editor/public/frame-bridge.mjs`
- 修改：`scripts/editor/server.mjs`
- 修改：`scripts/editor/bridge-service.mjs`
- 修改：`scripts/editor/session-store.mjs`
- 修改：`scripts/editor/bundle_adapter.py`
- 测试：`scripts/editor/test/save-gate.e2e.mjs`

- [ ] **步骤 1：编写失败的保存闸门测试**

```js
// scripts/editor/test/save-gate.e2e.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { startFixtureServer, openEditor } from './test-helpers.mjs';

test('新增溢出与外部文件变化均阻止写回', async () => {
  const app = await startFixtureServer(); const { browser, page } = await openEditor(app);
  const frame = page.frameLocator('#deck-frame');
  const target = await frame.locator('.card').first().evaluate(el => window.HuaweiDeckPatchRuntime.makeLocator(el));
  let state = await (await fetch(`${app.url}/api/session?token=${app.token}`)).json();
  const applied = await fetch(`${app.url}/api/actions?token=${app.token}`, { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({
    expectedRevision:state.revision, taskId:null,
    actions:[{ id:'overflow-1', taskId:null, target, kind:'resize', payload:{width:'300px',height:'1px'}, expectedRevision:state.revision }]
  }) });
  const { groupId } = await applied.json();
  let result = await fetch(`${app.url}/api/write-deck?token=${app.token}`, { method:'POST' });
  assert.equal(result.status, 409); assert.equal((await result.json()).code, 'NEW_OVERFLOW');
  state = await (await fetch(`${app.url}/api/session?token=${app.token}`)).json();
  await fetch(`${app.url}/api/groups/${groupId}/undo?token=${app.token}`, { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({expectedRevision:state.revision}) });
  await writeFile(app.deckPath, (await readFile(app.deckPath, 'utf8')) + '\n<!-- external -->');
  result = await fetch(`${app.url}/api/write-deck?token=${app.token}`, { method:'POST' });
  assert.equal(result.status, 409); assert.equal((await result.json()).code, 'DECK_CHANGED');
  await browser.close(); await app.close();
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：

```bash
node --test scripts/editor/test/save-gate.e2e.mjs
```

预期：FAIL，保存 API 尚未实现闸门。

- [ ] **步骤 3：实现实时几何诊断与基线比较**

iframe 返回每页：

```js
{
  pageKey,
  sectionOverflow:{ x, y },
  nestedClips:[{ locator, x, y }]
}
```

会话启动时保存基线；每个动作组完成后只复测涉及页。阻断规则为：section X/Y 新增正值，或相同 locator 的 nested clip 增量超过 2 px，或新增 nested clip。

- [ ] **步骤 4：实现文件监视与冲突状态**

`server.mjs` 使用 `fs.watchFile(deckPath, { interval:500 })`；每次变化计算 SHA-256。与 SessionStore 的 `deckFingerprint` 不同则设置 `conflict.code='DECK_CHANGED'` 并广播 `deck-conflict`。

停止服务时必须 `unwatchFile`，测试进程不得遗留 watcher。

- [ ] **步骤 5：实现三重保存闸门**

`POST /api/write-deck` 顺序固定：

```text
1. editor online
2. 当前文件指纹等于会话基线
3. 全部修改页没有新增溢出
4. PatchJournal.compile()
5. bundle_adapter.py 写临时文件并 eb.verify
6. 原子替换成功后更新会话基线指纹
```

任何失败返回 `{ code, message, recovery }`，不能返回笼统 500。

- [ ] **步骤 6：运行保存闸门测试验证通过**

运行：

```bash
node --test scripts/editor/test/save-gate.e2e.mjs
python3 -m unittest scripts/editor/test/test_bundle_adapter.py -v
```

预期：新增溢出返回 `NEW_OVERFLOW`；外部变化返回 `DECK_CHANGED`；Python 回滚测试 PASS。

- [ ] **步骤 7：提交**

```bash
git add scripts/editor/public/frame-bridge.mjs scripts/editor/server.mjs scripts/editor/bridge-service.mjs scripts/editor/bundle_adapter.py scripts/editor/test/save-gate.e2e.mjs scripts/editor/test/test_bundle_adapter.py
git commit -m "feat: 增加 Deck 保存诊断与冲突闸门"
```

---

### 任务 13：完成 `renzhi` 试点端到端验收

**文件：**
- 创建：`scripts/editor/test/renzhi-pilot.e2e.mjs`
- 修改：`scripts/editor/test/test-helpers.mjs`

- [ ] **步骤 1：编写真实 deck 的失败验收测试**

```js
// scripts/editor/test/renzhi-pilot.e2e.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startServer } from '../server.mjs';
import { applyPilotActions, createPilotTasks, openEditor } from './test-helpers.mjs';

test('renzhi 工作副本完成 21 页、跨页任务、实时动作与写回重开', { timeout:180_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'renzhi-pilot-'));
  const deck = join(root, 'renzhi-deck.html');
  await copyFile(resolve('Deck-Projects/renzhi/renzhi-deck.html'), deck);
  const app = await startServer({ deckPath:deck, host:'127.0.0.1', port:0, openBrowser:false, token:'pilot' });
  const { browser, page } = await openEditor(app);
  await page.waitForFunction(() => document.querySelectorAll('[data-page-key]').length === 21);
  assert.equal(await page.locator('[data-page-key]').count(), 21);
  await createPilotTasks(app, page, [7,8,9,12,17]);
  await applyPilotActions(app, page);
  const write = await fetch(`${app.url}/api/write-deck?token=pilot`, { method:'POST' });
  assert.equal(write.status, 200);
  await browser.close(); await app.close();
  const reopened = await startServer({ deckPath:deck, host:'127.0.0.1', port:0, openBrowser:false, token:'reopen' });
  const view = await openEditor(reopened);
  assert.equal(await view.page.locator('[data-page-key]').count(), 21);
  await view.browser.close(); await reopened.close();
});
```

- [ ] **步骤 2：运行测试验证真实缺口**

运行：

```bash
node --test scripts/editor/test/renzhi-pilot.e2e.mjs
```

预期：若任何试点接口或 21 页发现逻辑缺失则 FAIL；不得通过放宽断言解决。

- [ ] **步骤 3：补齐试点助手并保持原文件只读**

所有试点写操作必须指向 `mkdtemp()` 内的副本。测试开头和结尾分别计算原始 `renzhi-deck.html` 的 SHA-256，并断言相等。

`createPilotTasks()` 必须在页 7、8、9、12、17 各创建一条区域任务；`applyPilotActions()` 必须覆盖 `setText`、`translate`、`resize` 三类动作。

助手通过正式 API 创建任务，不直接改 SessionStore：

```js
export async function createPilotTasks(app, page, pageIndexes) {
  let revision = (await (await fetch(`${app.url}/api/session?token=${app.token}`)).json()).revision;
  for (const pageIndex of pageIndexes) {
    const item = page.locator(`[data-page-index="${pageIndex}"]`);
    const pageKey = await item.getAttribute('data-page-key');
    const pageLabel = await item.getAttribute('data-page-label');
    const response = await fetch(`${app.url}/api/tasks?token=${app.token}`, { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({
      expectedRevision:revision, pageKey, pageIndex, pageLabel,
      rect:{x:120,y:160,w:480,h:260}, instruction:`试点页 ${pageIndex} 修改`
    }) });
    revision = (await response.json()).revision;
  }
}
```

`applyPilotActions(app, page)` 使用页 9 标题的真实定位器覆盖三类动作：

```js
export async function applyPilotActions(app, page) {
  await page.click('[data-page-index="9"]');
  const frame = page.frameLocator('#deck-frame');
  const heading = frame.locator('h2').first();
  const target = await heading.evaluate(el => window.HuaweiDeckPatchRuntime.makeLocator(el));
  const original = await heading.textContent();
  const actions = [
    { kind:'setText', payload:{text:`${original} · 试点`} },
    { kind:'translate', payload:{x:10,y:0} },
    { kind:'resize', payload:{width:'900px',height:''} }
  ];
  for (const [index, spec] of actions.entries()) {
    const state = await (await fetch(`${app.url}/api/session?token=${app.token}`)).json();
    const response = await fetch(`${app.url}/api/actions?token=${app.token}`, { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({
      expectedRevision:state.revision, taskId:null,
      actions:[{ id:`pilot-action-${index}`, taskId:null, target, expectedRevision:state.revision, ...spec }]
    }) });
    if (!response.ok) throw new Error(await response.text());
  }
}
```

- [ ] **步骤 4：运行真实试点与 bundle 验证**

运行：

```bash
node --test scripts/editor/test/renzhi-pilot.e2e.mjs
python3 scripts/edit-bundle.py Deck-Projects/renzhi/renzhi-deck.html
```

预期：试点测试 PASS；原 deck 验证显示 `slide-fit=21 sections=21 nav=21 nav_seq_ok=True`。

- [ ] **步骤 5：对试点副本执行视觉验证**

实现 `--keep-temp` 测试参数，把副本固定到 `/tmp/huawei-deck-editor-renzhi-pilot/renzhi-deck.html`，因此正式执行命令使用：

```bash
node scripts/editor/test/renzhi-pilot.e2e.mjs --keep-temp
node scripts/verify/measure_overflow.mjs /tmp/huawei-deck-editor-renzhi-pilot/renzhi-deck.html --all
node scripts/verify/shot.mjs /tmp/huawei-deck-editor-renzhi-pilot/renzhi-deck.html kc-sol-agent /tmp/renzhi-editor-kc-sol-agent.jpg
node scripts/verify/steps.mjs /tmp/huawei-deck-editor-renzhi-pilot/renzhi-deck.html kc-sol-agent /tmp/renzhi-editor-kc-sol-agent-steps
```

预期：无新增 section overflow；截图文件存在且为 1920×1080；逐拍目录至少包含初始帧和末帧。

- [ ] **步骤 6：提交**

```bash
git add scripts/editor/test/renzhi-pilot.e2e.mjs scripts/editor/test/test-helpers.mjs
git commit -m "test: 覆盖 renzhi 可视化编辑试点闭环"
```

---

### 任务 14：同步 skill 文档与依赖说明

**文件：**
- 修改：`SKILL.md`
- 修改：`README.md`
- 修改：`references/editing-guide.md`
- 修改：`docs/architecture.md`
- 创建：`scripts/editor/test/docs-contract.test.mjs`

- [ ] **步骤 1：先写文档契约检查**

在 `scripts/editor/test/docs-contract.test.mjs` 写入：

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('四份入口文档同步后期编辑命令与边界', async () => {
  for (const file of ['SKILL.md','README.md','references/editing-guide.md','docs/architecture.md']) {
    const text = await readFile(file, 'utf8');
    assert.match(text, /python3 scripts\/deck-editor\.py/);
    assert.match(text, /\.huawei-deck-editor/);
    assert.match(text, /不增删页|不支持.*增删页|增删页.*不支持/);
  }
});
```

- [ ] **步骤 2：运行契约测试验证失败**

运行：

```bash
node --test scripts/editor/test/docs-contract.test.mjs
```

预期：四份文档至少一份缺少启动命令而 FAIL。

- [ ] **步骤 3：更新四份文档**

文档必须共同写清：

```text
启动：python3 scripts/deck-editor.py Deck-Projects/renzhi/renzhi-deck.html
编辑：直接改文字 / 移动 / 缩放，或跨页区域标记后交给外部 Agent
会话：.huawei-deck-editor/，不进入交付 deck
保存：三重闸门通过后由 edit-bundle.py 原子写回
第一版边界：不增删页、不调整页序、不重构复杂动画、不内置聊天
验证：eb.verify + measure_overflow + shot + 修改动画页 steps
```

在 `SKILL.md` 文件导航表增加 `scripts/deck-editor.py` 与 `scripts/editor/`；在 README 快速上手增加“后期微调”入口。

- [ ] **步骤 4：运行文档契约和全套编辑器测试**

运行：

```bash
node --test scripts/editor/test/docs-contract.test.mjs
npm run test:editor
```

预期：文档契约 PASS；全部 Node 与 Python 编辑器测试 0 failures。

- [ ] **步骤 5：提交**

```bash
git add SKILL.md README.md references/editing-guide.md docs/architecture.md scripts/editor/test/docs-contract.test.mjs
git commit -m "docs: 增加 Deck 后期可视化微调工作流"
```

---

### 任务 15：最终回归、代码审查与交付检查点

**文件：**
- 修改：仅限回归发现的编辑器文件和对应测试

- [ ] **步骤 1：运行依赖体检**

运行：

```bash
python3 scripts/check_deps.py --check-only > /tmp/huawei-deck-editor-final-deps.txt || test $? -eq 1
rg '✓ Node.js' /tmp/huawei-deck-editor-final-deps.txt
rg '✓ playwright-core' /tmp/huawei-deck-editor-final-deps.txt
rg '✓ Google Chrome' /tmp/huawei-deck-editor-final-deps.txt
rg '✓ ws' /tmp/huawei-deck-editor-final-deps.txt
rg '✓ html2canvas' /tmp/huawei-deck-editor-final-deps.txt
```

预期：Node、playwright-core、ws、html2canvas 均显示 `✓`；Chrome 仍按现有体检行确认。其他非编辑器依赖的缺失单独记录，不作为本功能回归失败。

- [ ] **步骤 2：运行全套编辑器测试**

运行：

```bash
npm run test:editor
```

预期：全部 Node 和 Python 测试退出码 0，0 failures。

- [ ] **步骤 3：运行真实试点与 verify 三件套**

运行：

```bash
node scripts/editor/test/renzhi-pilot.e2e.mjs --keep-temp
python3 scripts/edit-bundle.py /tmp/huawei-deck-editor-renzhi-pilot/renzhi-deck.html
node scripts/verify/measure_overflow.mjs /tmp/huawei-deck-editor-renzhi-pilot/renzhi-deck.html --all
node scripts/verify/shot.mjs /tmp/huawei-deck-editor-renzhi-pilot/renzhi-deck.html kc-sol-agent /tmp/renzhi-editor-final.jpg
node scripts/verify/steps.mjs /tmp/huawei-deck-editor-renzhi-pilot/renzhi-deck.html kc-sol-agent /tmp/renzhi-editor-final-steps
```

预期：bundle 仍为 21/21/21；无新增 section overflow；最终截图为 1920×1080；动画逐拍截图生成成功。

- [ ] **步骤 4：执行需求核对**

逐项对照设计规格第 11 节，在 `renzhi` 工作副本中人工演示：

```text
跨 3 页添加 5 条标记 → 关闭重开 → Agent 批量处理 → 人工改字 → 单条撤销 → 整批撤销 → 写回 → 重新打开放映
```

预期：10 条验收标准全部有测试输出或人工演示证据；未满足项不得标记完成。

- [ ] **步骤 5：请求代码审查并修复高优先级问题**

使用 `requesting-code-review` 技能检查：安全写回、路径限制、revision、定位歧义、撤销一致性、原 deck 无损和测试覆盖。审查发现的问题先增加失败测试，再做最小修复，再重跑步骤 2–4。

- [ ] **步骤 6：确认提交范围**

运行：

```bash
git status --short
git log --oneline --decorate -15
git diff origin/main...HEAD --stat
```

预期：变更只涉及本计划列出的编辑器、测试、依赖与文档文件；`Deck-Projects/renzhi/renzhi-deck.html` 没有被修改。

- [ ] **步骤 7：最终修复提交**

仅当步骤 5 产生修复时执行：

```bash
git add scripts/deck-editor.py scripts/editor package.json package-lock.json scripts/check_deps.py .gitignore SKILL.md README.md references/editing-guide.md docs/architecture.md
git commit -m "fix: 完成 Deck 可视化编辑器回归收口"
```

若步骤 5 没有产生修改，不创建空提交。
