# Deck 编辑器全局历史与任务附件实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 为 Deck 可视化编辑器增加覆盖人工与 Agent 动作的全局撤销/重做控制，并让区域任务支持安全的多文件选择、剪贴板图片与 Agent 可读附件路径。

**架构：** 全局历史继续以 session 的 `groups + redo + revision` 为唯一权威，前端只派生候选并复用现有 group API。附件使用 multipart 流式进入可信 sidecar 暂存区，经 Python writer 与长期持有 dirfd 的 sidecar helper 发布；任务 session 持久化失败时执行补偿删除，API/CLI 只在输出阶段派生绝对路径。

**技术栈：** 原生 HTML/CSS/ESM、Node.js HTTP/WebSocket、`busboy@1.6.0`、Python 3 标准库、Playwright、Node test runner、`unittest`。

---

## 0. 规格与执行约束

实现前完整阅读：

- `docs/superpowers/specs/2026-08-02-deck-editor-history-attachments-design.md`
- `docs/superpowers/specs/2026-08-01-huawei-deck-visual-editor-design.md`
- `references/editing-guide.md`

执行目录必须是：

```text
/Users/zhaoyinqi/zyq_workspace/huawei-deck/.worktrees/deck-visual-editor
```

分支必须是：

```text
codex/deck-visual-editor
```

每个任务遵循 TDD：先写测试、确认按预期失败、实现最少代码、运行聚焦测试、提交。不得直接编辑任何 bundle deck；真实 deck 验收继续只操作测试副本。

## 1. 文件结构与职责

### 新建文件

| 文件 | 单一职责 |
|---|---|
| `scripts/editor/history-state.mjs` | 从权威 groups/redo/tasks 派生最近撤销、重做候选与可访问摘要 |
| `scripts/editor/attachment-protocol.mjs` | 附件数量、大小、来源、相对路径与浏览器 File-like 校验 |
| `scripts/editor/attachment-paths.mjs` | Node 侧把受校验的附件相对路径解析为 session 内绝对路径 |
| `scripts/editor/multipart-task.mjs` | 严格解析 `/api/tasks` multipart，收集小型 snapshot 并把附件流交给 store |
| `scripts/editor/attachment-store.mjs` | 管理 upload 生命周期、Python writer 子进程、发布、放弃与路径序列化 |
| `scripts/editor/attachment_writer.py` | 从 stdin 流式写单个附件到已绑定 session 暂存目录并返回可信回执 |
| `scripts/editor/test/history-state.test.mjs` | 历史候选与摘要单元测试 |
| `scripts/editor/test/attachment-protocol.test.mjs` | 附件协议与路径单元测试 |
| `scripts/editor/test/multipart-task.test.mjs` | multipart 限额、字段与截断请求测试 |
| `scripts/editor/test/attachment-store.test.mjs` | writer 生命周期、发布/补偿与序列化测试 |
| `scripts/editor/test/test_attachment_writer.py` | attachment writer 的身份、限额、符号链接与原子写测试 |
| `scripts/editor/test/history-toolbar.e2e.mjs` | 顶栏全类型动作、定点撤销、重做、刷新和冲突 E2E |
| `scripts/editor/test/task-attachments.e2e.mjs` | 文件选择、粘贴图片、失败保留、任务抽屉与路径 E2E |

### 修改文件

| 文件 | 改动 |
|---|---|
| `package.json` / `package-lock.json` | 固定 `busboy@1.6.0`；E2E 命令显式串行 |
| `scripts/editor/protocol.mjs` | `validateTask` 接受并校验持久化 attachments 元数据 |
| `scripts/editor/sidecar-io.mjs` | 暴露 attachments/staging 专用 helper 命令 |
| `scripts/editor/sidecar_io.py` | 绑定 attachments/staging dirfd；发布、删除、放弃、重启对账 |
| `scripts/editor/session-store.mjs` | 旧任务归一化、附件资源与 snapshot 的事务提交/补偿 |
| `scripts/editor/bridge-service.mjs` | `createTask` 透传附件 lifecycle，保持 mutation 队列与 revision 语义 |
| `scripts/editor/server.mjs` | multipart 路由、AttachmentStore 生命周期、任务安全序列化与广播 |
| `scripts/editor/public/index.html` | 全局顶栏撤销/重做 DOM |
| `scripts/editor/public/editor.css` | 历史控件、附件列表、任务附件详情样式 |
| `scripts/editor/public/editor.mjs` | 权威历史状态、按钮请求、FormData 任务提交 |
| `scripts/editor/public/frame-bridge.mjs` | 文件选择、粘贴转 PNG、附件列表与失败恢复 |
| `scripts/editor/public/task-drawer.mjs` | 附件数量、名称、大小、路径与复制入口 |
| `scripts/editor/cli.mjs` | 无新命令；确认 tasks/task 输出附件绝对路径 |
| `scripts/editor/test/protocol.test.mjs` | 持久化附件元数据回归 |
| `scripts/editor/test/session-store.test.mjs` | 附件发布、session 提交与补偿边界 |
| `scripts/editor/test/sidecar-io.test.mjs` | Node helper wrapper 和绑定身份契约 |
| `scripts/editor/test/test_sidecar_io.py` | Python helper 专用命令契约 |
| `scripts/editor/test/server.test.mjs` | multipart、鉴权、限额、补偿、重启与路径安全 |
| `scripts/editor/test/cli.test.mjs` | CLI 附件 path 输出契约 |
| `scripts/editor/test/docs-contract.test.mjs` | 文档与串行 E2E 命令契约 |
| `README.md` / `SKILL.md` | 用户入口说明 |
| `references/editing-guide.md` | 选择、粘贴、sidecar 路径与生命周期 |
| `docs/architecture.md` | 历史派生、multipart 和附件事务架构 |

## 2. 稳定接口

### 2.1 历史派生

```js
historyCandidates(groups, redo) -> { undoGroup, redoGroup }
historyLabel(group, tasks, verb) -> string
```

候选规则固定为：最后一个 active group，以及 `redo.at(-1)` 指向的 inactive group。

### 2.2 附件持久化 DTO

```js
{
  id: 'uuid-v4',
  name: '新版架构.png',
  mime: 'image/png',
  size: 182340,
  source: 'selected',
  relativePath: 'attachments/<task-id>/<attachment-id>.png',
  createdAt: '2026-08-02T12:00:00.000Z'
}
```

API 输出在此基础上增加派生字段 `path`；`session.json` 绝不保存绝对路径。

### 2.3 multipart 表单

```text
task        application/json；恰好一个，必须先于文件 part
snapshot    image/png；零或一个，最多 512 KiB
attachment  任意 MIME；零到八个，每个 (0, 25 MiB]
```

`task` JSON 含 `expectedRevision`、原区域任务字段和按附件顺序排列的 `attachmentSources`，后者每项只能是 `selected` 或 `pasted`。

### 2.4 sidecar helper 命令

```js
publishAttachments({ uploadId, taskId, files })
discardAttachmentUpload({ uploadId })
deleteTaskAttachments({ taskId })
reconcileAttachments({ referencedTaskIds })
```

所有 ID 都必须是规范 UUID v4。所有磁盘路径由 helper 从已持有 dirfd 与 ID 拼出，不接受调用者提供绝对路径。

---

### 任务 1：建立权威历史派生模块

**文件：**
- 创建：`scripts/editor/history-state.mjs`
- 创建：`scripts/editor/test/history-state.test.mjs`

- [ ] **步骤 1：编写失败的历史候选与摘要测试**

```js
// scripts/editor/test/history-state.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { historyCandidates, historyLabel } from '../history-state.mjs';

const groups = [
  { id:'g-text', taskId:null, active:true, actions:[{ kind:'setText' }] },
  { id:'g-agent', taskId:'t-1', active:false, actions:[{ kind:'translate' }, { kind:'resize' }] },
  { id:'g-move', taskId:null, active:true, actions:[{ kind:'translate' }] },
];

test('候选跳过 inactive group 并使用 redo 栈尾', () => {
  const result = historyCandidates(groups, ['g-agent']);
  assert.equal(result.undoGroup.id, 'g-move');
  assert.equal(result.redoGroup.id, 'g-agent');
});

test('摘要区分人工动作和 Agent 任务', () => {
  const tasks = [{ id:'t-1', instruction:'替换为附件中的新版架构图' }];
  assert.equal(historyLabel(groups[0], tasks, 'undo'), '撤销文字修改');
  assert.equal(historyLabel(groups[1], tasks, 'redo'), '重做 Agent 任务：替换为附件中的新版架构图');
  assert.equal(historyLabel(groups[2], tasks, 'undo'), '撤销移动');
});

test('无候选时返回 null', () => {
  assert.deepEqual(historyCandidates([], []), { undoGroup:null, redoGroup:null });
});
```

- [ ] **步骤 2：运行测试确认模块不存在**

运行：

```bash
node --test scripts/editor/test/history-state.test.mjs
```

预期：FAIL，报错 `ERR_MODULE_NOT_FOUND`。

- [ ] **步骤 3：实现纯历史派生函数**

```js
// scripts/editor/history-state.mjs
const LABELS = {
  setText:'文字修改',
  translate:'移动',
  resize:'缩放',
  setStyle:'样式修改',
  hide:'隐藏',
  show:'显示',
};

export function historyCandidates(groups = [], redo = []) {
  const safeGroups = Array.isArray(groups) ? groups : [];
  const undoGroup = [...safeGroups].reverse().find(group => group?.active === true) ?? null;
  const redoId = Array.isArray(redo) ? redo.at(-1) : undefined;
  const redoGroup = typeof redoId === 'string'
    ? safeGroups.find(group => group?.id === redoId && group.active === false) ?? null
    : null;
  return { undoGroup, redoGroup };
}

export function historyLabel(group, tasks = [], verb = 'undo') {
  const prefix = verb === 'redo' ? '重做' : '撤销';
  if (!group) return prefix;
  const task = group.taskId === null
    ? null : tasks.find(candidate => candidate?.id === group.taskId);
  if (task?.instruction) return `${prefix} Agent 任务：${task.instruction.slice(0, 36)}`;
  const actions = Array.isArray(group.actions) ? group.actions : [];
  if (actions.length === 1 && LABELS[actions[0]?.kind]) {
    return `${prefix}${LABELS[actions[0].kind]}`;
  }
  return `${prefix}一组修改（${actions.length} 项）`;
}
```

- [ ] **步骤 4：运行历史与 journal 测试**

运行：

```bash
node --test scripts/editor/test/history-state.test.mjs scripts/editor/test/patch-journal.test.mjs
```

预期：全部 PASS；现有 `PatchJournal` 和 group API 的按 ID 定点撤销语义保持不变，顶部顺序只由 UI 候选决定。

- [ ] **步骤 5：提交**

```bash
git add scripts/editor/history-state.mjs scripts/editor/test/history-state.test.mjs
git commit -m "feat: 增加权威历史候选派生"
```

---

### 任务 2：实现全局顶栏撤销与重做

**文件：**
- 修改：`scripts/editor/public/index.html:8-28`
- 修改：`scripts/editor/public/editor.css`
- 修改：`scripts/editor/public/editor.mjs:1-230, 500-610`
- 修改：`scripts/editor/server.mjs:17-31`（受保护静态模块映射）
- 创建：`scripts/editor/test/history-toolbar.e2e.mjs`

- [ ] **步骤 1：编写失败的顶栏 E2E**

测试必须依次完成：初始禁用、人工文字后撤销、人工移动后撤销、人工缩放后撤销、Agent 批次整体撤销/重做、任务行定点撤销后顶部重做、刷新后状态恢复、陈旧 revision 不自动撤销新候选。

核心断言：

```js
assert.equal(await page.locator('[data-history-undo]').isDisabled(), true);
assert.equal(await page.locator('[data-history-redo]').isDisabled(), true);

await createManualTextAction(page);
assert.equal(await page.locator('[data-history-undo]').isEnabled(), true);
assert.match(await page.locator('[data-history-undo]').getAttribute('title'), /撤销文字修改/);

await page.locator('[data-history-undo]').click();
await page.waitForFunction(() => document.querySelector('[data-revision]')?.textContent === '2');
assert.equal(await heading.textContent(), '第一页标题');
assert.equal(await page.locator('[data-history-redo]').isEnabled(), true);

await page.locator('[data-history-redo]').click();
await page.waitForFunction(() => document.querySelector('[data-revision]')?.textContent === '3');
assert.equal(await heading.textContent(), '人工新标题');
```

- [ ] **步骤 2：运行 E2E 确认控件不存在**

运行：

```bash
node --test scripts/editor/test/history-toolbar.e2e.mjs
```

预期：FAIL，找不到 `[data-history-undo]`。

- [ ] **步骤 3：增加顶栏 DOM 和样式**

在 `.topbar-actions` 最前加入：

```html
<div class="history-controls" role="group" aria-label="修改历史">
  <button class="history-button" type="button" data-history-undo disabled title="撤销">
    <span aria-hidden="true">↶</span><span>撤销</span>
  </button>
  <button class="history-button" type="button" data-history-redo disabled title="重做">
    <span aria-hidden="true">↷</span><span>重做</span>
  </button>
</div>
```

CSS 必须包含默认、hover、focus-visible、disabled 和 busy 状态；控件高度与现有连接状态、模式徽标对齐，窄屏时保留文字而不只剩图标。

- [ ] **步骤 4：接入权威 session 与 group API**

`editor.mjs` 新增：

```js
import { historyCandidates, historyLabel } from '/editor/history-state.mjs';

const undoButton = document.querySelector('[data-history-undo]');
const redoButton = document.querySelector('[data-history-redo]');
let sessionRedo = [];
let historyBusy = false;

function renderHistory() {
  const { undoGroup, redoGroup } = historyCandidates(sessionGroups, sessionRedo);
  undoButton.disabled = historyBusy || !undoGroup;
  redoButton.disabled = historyBusy || !redoGroup;
  undoButton.title = historyLabel(undoGroup, tasks, 'undo');
  redoButton.title = historyLabel(redoGroup, tasks, 'redo');
  undoButton.dataset.groupId = undoGroup?.id ?? '';
  redoButton.dataset.groupId = redoGroup?.id ?? '';
}
```

`loadSession` 同时赋值 `sessionRedo = Array.isArray(session.redo) ? session.redo : []` 并调用 `renderHistory()`。

点击函数只执行点击时渲染出的 group ID；409 时只刷新，不自动重试：

```js
async function changeHistory(method, button) {
  if (historyBusy || !button.dataset.groupId) return;
  historyBusy = true;
  renderHistory();
  try {
    const result = await requestJson(
      `/api/groups/${encodeURIComponent(button.dataset.groupId)}/${method}`,
      {
        method:'POST', headers:{ 'content-type':'application/json' },
        body:JSON.stringify({ expectedRevision:revision }),
      },
    );
    updateRevision(result.revision);
    await ensureSessionRevision(result.revision);
  } catch (error) {
    if (error.committed === true) {
      updateRevision(error.revision);
      await loadSession(error.revision).catch(() => {});
      showTaskNotice(`${method === 'undo' ? '撤销' : '重做'}已保存、同步待确认`);
      return;
    }
    await loadSession(error.revision).catch(() => {});
    showTaskNotice(error.code === 'REVISION_CONFLICT'
      ? '历史已更新，请重试' : `${method === 'undo' ? '撤销' : '重做'}失败：${error.message}`);
  } finally {
    historyBusy = false;
    renderHistory();
  }
}
```

把 `/editor/history-state.mjs` 加入 `EDITOR_ASSETS`。`renderTasks()`、`loadSession()` 和 history 相关 WebSocket session 刷新完成后都调用 `renderHistory()`，确保 Agent 任务说明和候选摘要同步。任务行和 CLI 的既有按 groupId 撤销请求保持不变；顶部只是从权威 session 选择正确 groupId，不改变服务 API。

- [ ] **步骤 5：运行聚焦测试**

```bash
node --test scripts/editor/test/history-state.test.mjs scripts/editor/test/patch-journal.test.mjs
node --test scripts/editor/test/history-toolbar.e2e.mjs scripts/editor/test/live-actions.e2e.mjs
```

预期：全部 PASS，浏览器控制台和资源错误数组均为空。

- [ ] **步骤 6：提交**

```bash
git add scripts/editor/public/index.html scripts/editor/public/editor.css scripts/editor/public/editor.mjs scripts/editor/server.mjs scripts/editor/test/history-toolbar.e2e.mjs
git commit -m "feat: 增加全局撤销重做控制"
```

---

### 任务 3：定义附件协议与安全路径

**文件：**
- 创建：`scripts/editor/attachment-protocol.mjs`
- 创建：`scripts/editor/attachment-paths.mjs`
- 创建：`scripts/editor/test/attachment-protocol.test.mjs`
- 修改：`scripts/editor/protocol.mjs:117-126`
- 修改：`scripts/editor/test/protocol.test.mjs`
- 修改：`scripts/editor/server.mjs:17-31`（静态模块映射）

- [ ] **步骤 1：编写失败的协议测试**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_ATTACHMENTS, MAX_ATTACHMENT_BYTES, validateAttachmentMetadata, validateFileLike,
} from '../attachment-protocol.mjs';
import { resolveAttachmentPath } from '../attachment-paths.mjs';

test('附件元数据严格接受 session 相对路径', () => {
  const taskId = '11111111-1111-4111-8111-111111111111';
  const attachmentId = '22222222-2222-4222-8222-222222222222';
  const value = validateAttachmentMetadata({
    id:attachmentId, name:'新版架构.png', mime:'image/png', size:8,
    source:'selected',
    relativePath:`attachments/${taskId}/${attachmentId}.png`,
    createdAt:'2026-08-02T12:00:00.000Z',
  }, taskId);
  assert.equal(value.name, '新版架构.png');
});

test('拒绝路径穿越、空文件和超限文件', () => {
  assert.throws(() => resolveAttachmentPath('/tmp/session', '../outside'), /相对路径/);
  assert.throws(() => validateFileLike({ name:'empty.txt', size:0, type:'text/plain' }), /空文件/);
  assert.throws(() => validateFileLike({
    name:'large.bin', size:MAX_ATTACHMENT_BYTES + 1, type:'application/octet-stream',
  }), /25 MiB/);
  assert.equal(MAX_ATTACHMENTS, 8);
});
```

- [ ] **步骤 2：运行测试确认模块不存在**

```bash
node --test scripts/editor/test/attachment-protocol.test.mjs
```

预期：FAIL，`ERR_MODULE_NOT_FOUND`。

- [ ] **步骤 3：实现浏览器与 Node 共用的纯协议模块**

导出以下稳定常量和函数：

```js
export const MAX_ATTACHMENTS = 8;
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
export const ATTACHMENT_SOURCES = new Set(['selected', 'pasted']);

export function validateFileLike(file) {
  if (!file || typeof file.name !== 'string' || !Number.isSafeInteger(file.size)) {
    throw new TypeError('附件不是有效文件');
  }
  if (file.size <= 0) throw new RangeError('附件不能是空文件');
  if (file.size > MAX_ATTACHMENT_BYTES) throw new RangeError('单个附件不得超过 25 MiB');
  return file;
}
```

`validateAttachmentMetadata(value, taskId)` 必须保持浏览器可运行：不导入任何 `node:*` 模块；使用规范 UUID v4 正则，限制显示名为 240 个 Unicode code point、拒绝控制字符，验证 ISO 时间、source、size 和精确相对路径形状。

`attachment-paths.mjs` 仅在 Node 侧使用 `node:path`。`resolveAttachmentPath(sessionDir, relativePath)` 先用 protocol 校验形状，再用 `resolve/relative` 确保目标位于 `sessionDir/attachments` 内。

`protocol.validateTask(task, { persisted=false } = {})` 默认拒绝请求元数据自带 `attachments`；`persisted:true` 时要求 attachments 为数组并逐项调用 `validateAttachmentMetadata(value, task.id)`。这样 HTTP 创建输入不能伪造 sidecar 路径，而 session 恢复仍执行严格验证。

- [ ] **步骤 4：把模块加入受保护静态资源表并运行测试**

```bash
node --test scripts/editor/test/attachment-protocol.test.mjs scripts/editor/test/protocol.test.mjs
node --check scripts/editor/attachment-protocol.mjs
node --check scripts/editor/attachment-paths.mjs
```

预期：全部 PASS。

- [ ] **步骤 5：提交**

```bash
git add scripts/editor/attachment-protocol.mjs scripts/editor/attachment-paths.mjs scripts/editor/protocol.mjs scripts/editor/server.mjs scripts/editor/test/attachment-protocol.test.mjs scripts/editor/test/protocol.test.mjs
git commit -m "feat: 定义 Deck 任务附件协议"
```

---

### 任务 4：绑定可信附件目录并实现 helper 事务命令

**文件：**
- 修改：`scripts/editor/sidecar_io.py:199-380, 465-490, 840-890`
- 修改：`scripts/editor/sidecar-io.mjs:170-220`
- 修改：`scripts/editor/server.mjs:728-755`
- 修改：`scripts/editor/test/test_sidecar_io.py`
- 修改：`scripts/editor/test/sidecar-io.test.mjs`
- 修改：`scripts/editor/test/server.test.mjs` 中目录身份断言

- [ ] **步骤 1：先写失败的 Python helper 测试**

覆盖：旧 session 绑定时创建真实 `attachments/.staging`；identity 返回并纳入 `assert-bound`；发布两个 staged 文件；放弃 upload；删除 task 附件；reconcile 删除未引用 UUID task 目录并保留引用目录；attachments/staging 被换成 symlink 后全部拒绝。

核心测试形状：

```python
result = helper.bind_session(valid_bind_payload(create=False))
self.assertIn("attachments", result["identities"])
self.assertIn("attachmentStaging", result["identities"])

published = helper.publish_attachments({
    "uploadId": UPLOAD_ID,
    "taskId": TASK_ID,
    "files": [{"id": ATTACHMENT_ID, "suffix": ".png", "size": 8}],
})
self.assertEqual(
    published[0]["relativePath"],
    f"attachments/{TASK_ID}/{ATTACHMENT_ID}.png",
)
```

- [ ] **步骤 2：运行测试确认命令不存在**

```bash
python3 -m unittest scripts/editor/test/test_sidecar_io.py -v
```

预期：FAIL，缺少 attachments identity 或 `publish_attachments`。

- [ ] **步骤 3：扩展 Python helper 的可信目录集合**

`PersistentHelper` 新增 `attachments_fd`、`attachment_staging_fd`；`bind_session` 在已验证 registry 和 session 后安全创建/打开二者。`close`、重新 bind 的关闭列表、identity 返回、`assert_bound` checks 全部包含这两个 fd。

命令规则：

```python
def publish_attachments(self, payload):
    upload_id = _require_uuid(payload["uploadId"])
    task_id = _require_uuid(payload["taskId"])
    files = _validate_publish_files(payload["files"])
    # 只从 attachment_staging_fd/upload_id 读取规范普通文件；
    # 只在 attachments_fd/task_id 创建目标目录；rename 后 fsync 两级目录；
    # 返回 [{id, relativePath, size}]，不接受调用者路径。

def discard_attachment_upload(self, payload):
    # 安全删除 staging 下一个 UUID 目录中的普通文件并 fsync。

def delete_task_attachments(self, payload):
    # 安全删除 attachments 下一个 UUID 任务目录并 fsync。

def reconcile_attachments(self, payload):
    # referencedTaskIds 是 UUID 数组；保留引用目录，删除其余 UUID 目录和全部 staging upload。
```

遇到非普通文件、子目录、符号链接或非 UUID 名称必须返回 `UNSAFE_SIDECAR_IO`，不递归跟随。

- [ ] **步骤 4：扩展 Node wrapper 和 boundary identity**

```js
publishAttachments(payload) { return this.#request('publish-attachments', payload); }
discardAttachmentUpload({ uploadId }) {
  return this.#request('discard-attachment-upload', { uploadId });
}
deleteTaskAttachments({ taskId }) {
  return this.#request('delete-task-attachments', { taskId });
}
reconcileAttachments({ referencedTaskIds }) {
  return this.#request('reconcile-attachments', { referencedTaskIds });
}
```

`persistentBoundary.pythonIdentity` 增加 `attachments` 与 `attachmentStaging`。

- [ ] **步骤 5：运行 Python、Node 与服务身份测试**

```bash
python3 -m unittest scripts/editor/test/test_sidecar_io.py -v
node --test scripts/editor/test/sidecar-io.test.mjs
node --test --test-name-pattern='sidecar|identity|目录' scripts/editor/test/server.test.mjs
```

预期：全部 PASS。

- [ ] **步骤 6：提交**

```bash
git add scripts/editor/sidecar_io.py scripts/editor/sidecar-io.mjs scripts/editor/server.mjs scripts/editor/test/test_sidecar_io.py scripts/editor/test/sidecar-io.test.mjs scripts/editor/test/server.test.mjs
git commit -m "feat: 增加可信附件目录事务"
```

---

### 任务 5：实现流式附件 writer 与 AttachmentStore

**文件：**
- 创建：`scripts/editor/attachment_writer.py`
- 创建：`scripts/editor/attachment-store.mjs`
- 创建：`scripts/editor/test/test_attachment_writer.py`
- 创建：`scripts/editor/test/attachment-store.test.mjs`

- [ ] **步骤 1：编写失败的 writer 测试**

测试通过 subprocess 把二进制写入 stdin，断言：正常文件原样落在 staging；0 字节返回 `ATTACHMENT_EMPTY`；第 `25 MiB + 1` 字节返回 `ATTACHMENT_TOO_LARGE` 且无文件；session/attachments/staging dev+ino 不匹配拒绝；目标或祖先 symlink 拒绝；成功回执包含实际 size 与 sha256。

```python
completed = subprocess.run(
    [sys.executable, str(WRITER), "--config", json.dumps(config)],
    input=PNG_BYTES, capture_output=True, check=False,
)
result = json.loads(completed.stdout)
self.assertTrue(result["ok"])
self.assertEqual(result["size"], len(PNG_BYTES))
self.assertEqual(result["attachmentId"], ATTACHMENT_ID)
```

- [ ] **步骤 2：运行测试确认 writer 不存在**

```bash
python3 -m unittest scripts/editor/test/test_attachment_writer.py -v
```

预期：FAIL，writer 文件不存在。

- [ ] **步骤 3：实现 attachment writer**

writer 只接受 `--config <JSON>`，config 精确包含：

```json
{
  "session": {"path":"...","dev":"...","ino":"..."},
  "attachments": {"path":"...","dev":"...","ino":"..."},
  "attachmentStaging": {"path":"...","dev":"...","ino":"..."},
  "uploadId":"UUID v4",
  "attachmentId":"UUID v4",
  "suffix":".png",
  "maximumBytes":26214400
}
```

实现必须用 `os.open(..., O_DIRECTORY | O_NOFOLLOW)` 和 `os.fstat` 对比 dev/ino；用 dirfd 创建/open upload 目录；以 `O_CREAT | O_EXCL | O_NOFOLLOW` 创建 `<attachmentId><suffix>`；循环读取 stdin、累计 size、更新 sha256、超限立即失败；`fsync(file)`、关闭、`fsync(upload_dir)` 后输出一行 JSON。失败时删除部分文件并返回非零退出码。

- [ ] **步骤 4：为 AttachmentStore 编写失败测试并实现**

稳定接口：

```js
const upload = attachmentStore.beginUpload();
await upload.stage({ stream, name, mime, source, suffix });
const descriptors = await upload.publish(taskId);
await upload.discard();
await attachmentStore.deleteTask(taskId);
attachmentStore.serializeTask(task);
```

`stage` 为每个文件生成 UUID，使用参数数组 `spawnAttachmentWriter('python3', ['-u', WRITER, '--config', json])`，直接把 file stream pipe 到 child stdin；stdout 限制 64 KiB，超时 30 秒，close/abort 时杀死 child。writer 回执必须与请求 ID、size、sha256 和可信 staging 路径一致。该注入点与现有 Deck 写回使用的 `spawnWriter` 分离。

`publish` 调用 `sidecarIO.publishAttachments`，把 helper 返回的 `relativePath` 与浏览器元数据合并。`serializeTask` 用 `resolveAttachmentPath` 派生 `path`。

- [ ] **步骤 5：运行聚焦测试**

```bash
python3 -m unittest scripts/editor/test/test_attachment_writer.py -v
node --test scripts/editor/test/attachment-store.test.mjs
```

预期：全部 PASS，测试结束后没有存活 writer 子进程。

- [ ] **步骤 6：提交**

```bash
git add scripts/editor/attachment_writer.py scripts/editor/attachment-store.mjs scripts/editor/test/test_attachment_writer.py scripts/editor/test/attachment-store.test.mjs
git commit -m "feat: 流式暂存 Deck 任务附件"
```

---

### 任务 6：严格解析 multipart 任务请求

**文件：**
- 修改：`package.json`
- 修改：`package-lock.json`
- 创建：`scripts/editor/multipart-task.mjs`
- 创建：`scripts/editor/test/multipart-task.test.mjs`

- [ ] **步骤 1：安装固定依赖并写失败测试**

```bash
npm install --save-exact busboy@1.6.0
```

测试构造真实 multipart 流，覆盖：task 必须恰好一个且先于文件；snapshot 只能是 PNG 且最多 512 KiB；attachment 最多八个、每个 25 MiB；未知 part、重复 task/snapshot、文件截断、source 数量错配、client abort 均失败并调用 `upload.discard()`。

```js
const parsed = await parseTaskMultipart(request, { attachmentStore });
assert.equal(parsed.input.instruction, '替换为附件中的新版架构图');
assert.equal(parsed.snapshot.length, 8);
assert.equal(parsed.upload.staged.length, 2);
```

- [ ] **步骤 2：运行测试确认 parser 不存在**

```bash
node --test scripts/editor/test/multipart-task.test.mjs
```

预期：FAIL，`ERR_MODULE_NOT_FOUND`。

- [ ] **步骤 3：实现 parser**

```js
import Busboy from 'busboy';
import { MAX_ATTACHMENTS, MAX_ATTACHMENT_BYTES } from './attachment-protocol.mjs';
import { MAX_SNAPSHOT_BYTES } from './session-store.mjs';

const MAX_TASK_METADATA_BYTES = 64 * 1024;

function multipartError(code, statusCode, message) {
  return Object.assign(new Error(message), { code, statusCode, stage:'multipart' });
}

function collectPart(stream, maximum, code, message) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    stream.on('data', chunk => {
      size += chunk.length;
      if (size > maximum) {
        reject(multipartError(code, 413, message));
        stream.resume();
        return;
      }
      chunks.push(chunk);
    });
    stream.once('error', reject);
    stream.once('end', () => resolve(Buffer.concat(chunks, size)));
  });
}

export function parseTaskMultipart(request, { attachmentStore }) {
  const upload = attachmentStore.beginUpload();
  return new Promise((resolve, reject) => {
    let firstError = null;
    let partIndex = 0;
    let taskPromise = null;
    let snapshotPromise = Promise.resolve(null);
    let snapshotSeen = false;
    let settled = false;
    const staged = [];
    const record = error => { firstError ??= error; };
    const parser = Busboy({
      headers:request.headers,
      limits:{
        fields:0,
        files:MAX_ATTACHMENTS + 2,
        parts:MAX_ATTACHMENTS + 2,
        fileSize:MAX_ATTACHMENT_BYTES,
      },
    });

    parser.on('field', () => {
      record(multipartError('INVALID_MULTIPART', 400, 'multipart 不接受普通 field'));
    });
    parser.on('file', (fieldName, stream, info) => {
      const currentPart = partIndex;
      partIndex += 1;
      if (fieldName === 'task') {
        if (currentPart !== 0 || taskPromise !== null || info.mimeType !== 'application/json') {
          record(multipartError('INVALID_MULTIPART', 400, 'task 必须是首个且唯一的 application/json part'));
          stream.resume();
          return;
        }
        taskPromise = collectPart(
          stream, MAX_TASK_METADATA_BYTES, 'INVALID_MULTIPART', 'task 元数据过大',
        );
        return;
      }
      if (taskPromise === null) {
        record(multipartError('INVALID_MULTIPART', 400, '文件 part 之前必须先提供 task'));
        stream.resume();
        return;
      }
      if (fieldName === 'snapshot') {
        if (snapshotSeen || info.mimeType !== 'image/png') {
          record(multipartError('INVALID_MULTIPART', 400, 'snapshot 必须是唯一 PNG part'));
          stream.resume();
          return;
        }
        snapshotSeen = true;
        snapshotPromise = collectPart(
          stream, MAX_SNAPSHOT_BYTES, 'SNAPSHOT_TOO_LARGE', 'snapshot 超过 512 KiB',
        );
        return;
      }
      if (fieldName !== 'attachment') {
        record(multipartError('INVALID_MULTIPART', 400, `不支持的 multipart part：${fieldName}`));
        stream.resume();
        return;
      }
      if (staged.length >= MAX_ATTACHMENTS) {
        record(multipartError('TOO_MANY_ATTACHMENTS', 413, '每个任务最多 8 个附件'));
        stream.resume();
        return;
      }
      const attachmentIndex = staged.length;
      stream.pause();
      stream.once('limit', () => record(multipartError(
        'ATTACHMENT_TOO_LARGE', 413, '单个附件不得超过 25 MiB',
      )));
      const promise = taskPromise.then(bytes => {
        let task;
        try { task = JSON.parse(bytes.toString('utf8')); }
        catch { throw multipartError('INVALID_MULTIPART', 400, 'task part 不是有效 JSON'); }
        const source = task.attachmentSources?.[attachmentIndex];
        if (!['selected', 'pasted'].includes(source)) {
          throw multipartError('INVALID_MULTIPART', 400, 'attachmentSources 与附件顺序不一致');
        }
        return upload.stage({
          stream, name:info.filename, mime:info.mimeType || 'application/octet-stream', source,
        });
      }).catch(error => {
        record(error);
        stream.resume();
        throw error;
      });
      staged.push(promise);
    });
    parser.once('filesLimit', () => record(multipartError(
      'TOO_MANY_ATTACHMENTS', 413, 'multipart 文件 part 数量超限',
    )));
    parser.once('partsLimit', () => record(multipartError(
      'TOO_MANY_ATTACHMENTS', 413, 'multipart part 数量超限',
    )));
    parser.once('error', error => record(multipartError(
      'INVALID_MULTIPART', 400, error.message || 'multipart 解析失败',
    )));

    const finalize = async () => {
      if (settled) return;
      settled = true;
      try {
        const [taskBytes, snapshot] = await Promise.all([
          taskPromise ?? Promise.reject(multipartError(
            'INVALID_MULTIPART', 400, '缺少 task part',
          )),
          snapshotPromise,
          ...staged,
        ]);
        if (firstError) throw firstError;
        let task;
        try { task = JSON.parse(taskBytes.toString('utf8')); }
        catch { throw multipartError('INVALID_MULTIPART', 400, 'task part 不是有效 JSON'); }
        if (!Array.isArray(task.attachmentSources)
          || task.attachmentSources.length !== staged.length) {
          throw multipartError('INVALID_MULTIPART', 400, 'attachmentSources 数量不匹配');
        }
        const { attachmentSources:ignored, ...input } = task;
        void ignored;
        resolve({ input, snapshot, upload });
      } catch (error) {
        await upload.discard().catch(discardError => { error.cause = discardError; });
        reject(error);
      }
    };
    parser.once('close', () => { void finalize(); });
    request.once('aborted', () => {
      record(multipartError('INVALID_MULTIPART', 400, 'multipart 请求在完成前中断'));
      void finalize();
    });
    request.pipe(parser);
  });
}
```

实现时保留上述控制流，并补充测试要求的单次 settle、writer abort 和 request listener 清理；稳定错误码固定为 `INVALID_MULTIPART`、`TOO_MANY_ATTACHMENTS`、`ATTACHMENT_TOO_LARGE`、`SNAPSHOT_TOO_LARGE`。

- [ ] **步骤 4：运行 parser 测试**

```bash
node --test scripts/editor/test/multipart-task.test.mjs
npm ls busboy --depth=0
```

预期：测试全部 PASS；输出 `busboy@1.6.0`。

- [ ] **步骤 5：提交**

```bash
git add package.json package-lock.json scripts/editor/multipart-task.mjs scripts/editor/test/multipart-task.test.mjs
git commit -m "feat: 解析 Deck 任务附件表单"
```

---

### 任务 7：把附件发布纳入 SessionStore 事务

**文件：**
- 修改：`scripts/editor/session-store.mjs:47-64, 78-155, 200-257`
- 修改：`scripts/editor/bridge-service.mjs:369-395`
- 修改：`scripts/editor/test/session-store.test.mjs`
- 修改：`scripts/editor/test/server.test.mjs`

- [ ] **步骤 1：编写失败的事务测试**

新增测试矩阵：

1. `attachmentsLifecycle.publish(taskId)` 成功后，task 与 revision 一次提交；
2. publish 失败时 snapshot、task、revision 均不变；
3. snapshot 写失败时 discard upload；
4. session persist 未 committed 失败时同时删除 snapshot 和 task attachments；
5. session persist committed 失败时保留附件与候选 state；
6. 附件补偿删除失败返回 `ATTACHMENT_RECOVERY_REQUIRED`，不声称 task 已创建；
7. 旧 session task 无 attachments 时归一化为 `[]`；
8. `decodeSnapshot` 同时接受旧 PNG data URL 与 multipart 传入的 PNG `Buffer`，两种输入执行同一签名和 512 KiB 校验。

核心调用：

```js
const result = await store.createTask(input, 0, {
  attachmentsLifecycle:{
    publish:async taskId => [{ ...metadata, relativePath:`attachments/${taskId}/${metadata.id}.png` }],
    discard:async () => {},
    deleteTask:async () => {},
  },
});
assert.equal(result.task.attachments.length, 1);
assert.equal(result.revision, 1);
```

- [ ] **步骤 2：运行测试确认签名不支持 lifecycle**

```bash
node --test --test-name-pattern='附件|attachments' scripts/editor/test/session-store.test.mjs
```

预期：FAIL，task 没有 attachments 或 publish 未调用。

- [ ] **步骤 3：实现统一资源提交与补偿**

`createTask` 新签名：

```js
async createTask(input, expectedRevision, { attachmentsLifecycle=null } = {})
```

固定顺序：生成 task ID → decode snapshot → publish attachments → 写 snapshot → 构造 candidate → persist session。维护 `snapshotPublished` 与 `attachmentsPublished` 两个布尔值；非 committed session 失败时逆序补偿。任一补偿失败统一包装：

```js
Object.assign(new Error('附件已发布但补偿删除失败，需要重启服务恢复'), {
  code:'ATTACHMENT_RECOVERY_REQUIRED',
  statusCode:503,
  stage:'attachment-compensation',
  committed:false,
  commitScope:'attachment',
  sessionCandidateCommitted:false,
});
```

`decodeSnapshot` 先归一化输入，再复用原有验证：

```js
function decodeSnapshot(snapshot) {
  if (snapshot === undefined || snapshot === null) return null;
  let bytes;
  if (Buffer.isBuffer(snapshot)) {
    bytes = Buffer.from(snapshot);
  } else if (typeof snapshot === 'string') {
    const match = snapshot.match(/^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})$/);
    if (!match || match[1].length % 4 !== 0) {
      throw snapshotError('INVALID_SNAPSHOT', 400, 'snapshot 不是有效的 PNG base64');
    }
    bytes = Buffer.from(match[1], 'base64');
    if (bytes.toString('base64') !== match[1]) {
      throw snapshotError('INVALID_SNAPSHOT', 400, 'snapshot 不是规范 base64');
    }
  } else {
    throw snapshotError('INVALID_SNAPSHOT', 400, 'snapshot 必须为 PNG Buffer、data URL 或 null');
  }
  if (bytes.length < PNG_SIGNATURE.length
    || !bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw snapshotError('INVALID_SNAPSHOT', 400, 'snapshot 缺少有效 PNG 签名');
  }
  if (bytes.length > MAX_SNAPSHOT_BYTES) {
    throw snapshotError('SNAPSHOT_TOO_LARGE', 413, 'snapshot 不得超过 524288 字节');
  }
  return bytes;
}
```

`applyPersisted` 对每个 task 执行：

```js
tasks: persisted.tasks.map(task => ({
  ...task,
  attachments:Array.isArray(task.attachments) ? task.attachments : [],
}))
```

归一化后逐项调用 `validateTask(task, { persisted:true })`；发现伪造 task ID、relativePath、source 或 size 时拒绝启动 session，不静默删除字段。

`BridgeService.createTask(input, expectedRevision, options)` 在现有 mutation queue 中调用 `sessionStore.createTask(input, expectedRevision, options)`；现有 committed-session 发布与回滚逻辑保持不变。若 revision 校验在资源发布前失败，server route 的 `finally` 负责调用 `attachmentsLifecycle.discard()`。

- [ ] **步骤 4：运行 session 与 bridge 服务测试**

```bash
node --test scripts/editor/test/session-store.test.mjs
node --test --test-name-pattern='task|附件|persist' scripts/editor/test/server.test.mjs
```

预期：全部 PASS。

- [ ] **步骤 5：提交**

```bash
git add scripts/editor/session-store.mjs scripts/editor/bridge-service.mjs scripts/editor/test/session-store.test.mjs scripts/editor/test/server.test.mjs
git commit -m "feat: 原子提交任务附件与会话"
```

---

### 任务 8：接入服务路由、重启对账与 CLI 路径

**文件：**
- 修改：`scripts/editor/server.mjs:1-31, 728-755, 907-990, 1042-1061, 1230-1265`
- 修改：`scripts/editor/cli.mjs`
- 修改：`scripts/editor/test/server.test.mjs`
- 修改：`scripts/editor/test/cli.test.mjs`

- [ ] **步骤 1：编写失败的真实服务测试**

使用 Node `FormData` 向真实服务发送两个附件：

```js
const form = new FormData();
form.append('task', new Blob([JSON.stringify({
  expectedRevision:0, ...taskInput, attachmentSources:['selected', 'pasted'],
})], { type:'application/json' }), 'task.json');
form.append('snapshot', new Blob([PNG_BYTES], { type:'image/png' }), 'region.png');
form.append('attachment', new Blob([Buffer.from('reference')], { type:'text/plain' }), '说明.txt');
form.append('attachment', new Blob([PNG_BYTES], { type:'image/png' }), 'pasted.png');
const response = await fetch(`${app.url}/api/tasks?token=secret`, { method:'POST', body:form });
const result = await response.json();
assert.equal(response.status, 201, JSON.stringify(result));
assert.equal(result.task.attachments.length, 2);
assert.equal(await readFile(result.task.attachments[0].path, 'utf8'), 'reference');
```

同文件补充：JSON 旧接口仍成功；绝对 path 不进入 `session.json`；广播 payload 带 path；无 token/错误 Origin 拒绝；9 个附件、空文件、超限、截断、writer 失败、persist 失败、补偿失败、attachments symlink 全部符合规格；重启 reconcile 保留引用目录并删除孤儿。

CLI 测试启动真实服务后执行 `tasks` 与 `task <id>`，断言 JSON 中 path 是绝对现存文件。

- [ ] **步骤 2：运行服务测试确认只支持 JSON**

```bash
node --test --test-name-pattern='multipart|附件|CLI.*path' scripts/editor/test/server.test.mjs scripts/editor/test/cli.test.mjs
```

预期：FAIL，multipart 被当作 JSON 或 task 无 attachments。

- [ ] **步骤 3：在 startServer 中创建 AttachmentStore 并对账**

初始化 `SessionStore` 后、开始监听前：

```js
const attachmentStore = new AttachmentStore({
  sidecarBoundary,
  sidecarIO:sidecarBoundary.io,
  spawnAttachmentWriter,
});
await sidecarBoundary.io.reconcileAttachments({
  referencedTaskIds:sessionStore.state.tasks
    .filter(task => task.attachments?.length)
    .map(task => task.id),
});
```

server close 必须取消 active upload、杀死 writer 并等待 settle，再关闭 sidecar helper。

`startServer` 新增独立选项 `attachmentWriterTimeoutMs = 30_000` 与 `spawnAttachmentWriter = spawn`；不得复用现有 Deck bundle writer 的 `writerTimeoutMs/spawnWriter` 故障注入接口。

- [ ] **步骤 4：实现双 content-type 任务路由和安全输出**

```js
const contentType = request.headers['content-type'] ?? '';
let input;
let attachmentsLifecycle = null;
if (contentType.startsWith('multipart/form-data')) {
  const parsed = await parseTaskMultipart(request, { attachmentStore });
  input = { ...parsed.input, snapshot:parsed.snapshot };
  attachmentsLifecycle = parsed.upload;
} else if (contentType.startsWith('application/json')) {
  const body = await readJson(request);
  const { expectedRevision, ...jsonInput } = body;
  input = { expectedRevision, ...jsonInput };
} else {
  throw httpError('UNSUPPORTED_MEDIA_TYPE', 415, '任务请求必须是 JSON 或 multipart/form-data');
}
```

提取并校验 `expectedRevision` 后调用 `bridge.createTask(taskInput, expectedRevision, { attachmentsLifecycle })`。成功、GET 列表、GET 单项和 WebSocket 广播全部通过 `attachmentStore.serializeTask(task)`；`/api/session` 继续返回权威持久化形状，不注入绝对 path。

路由使用显式所有权标记，保证 revision 冲突和 validation 早退也能清理 staging：

```js
let attachmentOwnershipTransferred = false;
try {
  const result = await bridge.createTask(taskInput, expectedRevision, {
    attachmentsLifecycle,
  });
  attachmentOwnershipTransferred = true;
  const task = attachmentStore.serializeTask(result.task);
  broadcast('task-created', result.revision, task);
  json(response, 201, { ...result, task });
} finally {
  if (attachmentsLifecycle && !attachmentOwnershipTransferred
    && attachmentsLifecycle.published !== true) {
    await attachmentsLifecycle.discard();
  }
}
```

错误响应必须保留稳定 `error/code/stage/committed/commitScope` 字段。`attachmentsLifecycle.publish()` 成功后由 SessionStore 负责提交或补偿；路由不得再次删除已发布 task 目录。

- [ ] **步骤 5：运行服务、CLI 与安全测试**

```bash
node --test scripts/editor/test/server.test.mjs scripts/editor/test/cli.test.mjs
python3 -m unittest scripts/editor/test/test_attachment_writer.py scripts/editor/test/test_sidecar_io.py -v
```

预期：全部 PASS。

- [ ] **步骤 6：提交**

```bash
git add scripts/editor/server.mjs scripts/editor/cli.mjs scripts/editor/test/server.test.mjs scripts/editor/test/cli.test.mjs
git commit -m "feat: 提供任务附件 API 与 Agent 路径"
```

---

### 任务 9：实现文件选择、粘贴图片与失败恢复 UI

**文件：**
- 修改：`scripts/editor/public/frame-bridge.mjs:241-260, 449-615, 1173-1190`
- 修改：`scripts/editor/public/editor.mjs:45-75, 110-118, 374-410`
- 修改：`scripts/editor/public/editor.css`
- 创建：`scripts/editor/test/task-attachments.e2e.mjs`
- 修改：`scripts/editor/test/region-marking.e2e.mjs`

- [ ] **步骤 1：编写失败的浏览器 E2E**

覆盖：文件选择多选与连续追加；删除一项；粘贴 1×1 PNG；普通文字 paste 不受影响；第 9 个文件拒绝；空文件/25 MiB+1 拒绝；提交时控件锁定；服务失败后 textarea、选区、附件保留；成功后弹窗关闭且磁盘 bytes 正确。

```js
const frame = page.frameLocator('#deck-frame');
await frame.locator('[data-attachment-input]').setInputFiles([
  { name:'说明.txt', mimeType:'text/plain', buffer:Buffer.from('reference') },
  { name:'架构.png', mimeType:'image/png', buffer:PNG_BYTES },
]);
assert.equal(await frame.locator('[data-attachment-item]').count(), 2);

await frame.locator('[data-region-popover] textarea').evaluate((textarea, bytes) => {
  const file = new File([Uint8Array.from(bytes)], 'clipboard.png', { type:'image/png' });
  const transfer = new DataTransfer();
  transfer.items.add(file);
  textarea.dispatchEvent(new ClipboardEvent('paste', {
    bubbles:true, cancelable:true, clipboardData:transfer,
  }));
}, [...PNG_BYTES]);
assert.equal(await frame.locator('[data-attachment-item]').count(), 3);
```

- [ ] **步骤 2：运行 E2E 确认附件入口不存在**

```bash
node --test scripts/editor/test/task-attachments.e2e.mjs
```

预期：FAIL，找不到 `[data-attachment-input]`。

- [ ] **步骤 3：实现 frame 内附件列表**

`frame-bridge.mjs` 导入 `/editor/attachment-protocol.mjs`。`openPopover` 新增隐藏 `input[type=file][multiple]`、可见选择按钮、paste 提示和列表容器。

稳定本地状态：

```js
activePopover = {
  canvas, selection, popover, requestId, submitting:false,
  attachments:[],
};
```

选择文件时逐个 `validateFileLike`，生成 `{ clientId, file, source:'selected' }`；粘贴图片使用 `createImageBitmap` + canvas `toBlob('image/png')` 重新编码为 PNG，命名 `pasted-image-YYYYMMDD-HHmmss-NNN.png`，source 为 `pasted`。普通文字 paste 不调用 `preventDefault()`。

提交消息增加可 structured-clone 的 File 数组：

```js
parent.postMessage({
  type:'create-region-task', requestId, payload, snapshot,
  attachments:activePopover.attachments.map(item => ({
    clientId:item.clientId,
    source:item.source,
    file:item.file,
  })),
}, location.origin);
```

收到失败 `region-task-result` 时恢复 textarea、选择、删除、取消、提交按钮，保留 activePopover；成功才 removePopover。

- [ ] **步骤 4：把 parent 提交改为 FormData**

`requestJson` 允许 `FormData` 时不手工设置 content-type。`createRegionTask` 构造：

```js
const form = new FormData();
form.append('task', new Blob([JSON.stringify({
  expectedRevision:revision, ...payload,
  attachmentSources:attachments.map(item => item.source),
})], { type:'application/json' }), 'task.json');
if (submittedSnapshot) {
  form.append('snapshot', dataUrlToBlob(submittedSnapshot), 'region.png');
}
for (const item of attachments) form.append('attachment', item.file, item.file.name);
```

revision 冲突时刷新后使用同一批 File 对象重新构造一次 FormData；其他错误把 `code/message` 回传 iframe。snapshot 超限降级仍保持现有一次重试语义。

- [ ] **步骤 5：运行附件与区域回归 E2E**

```bash
node --test scripts/editor/test/task-attachments.e2e.mjs scripts/editor/test/region-marking.e2e.mjs
```

预期：全部 PASS；失败恢复测试确认附件未被重复上传。

- [ ] **步骤 6：提交**

```bash
git add scripts/editor/public/frame-bridge.mjs scripts/editor/public/editor.mjs scripts/editor/public/editor.css scripts/editor/test/task-attachments.e2e.mjs scripts/editor/test/region-marking.e2e.mjs
git commit -m "feat: 支持选区任务文件与粘贴图片"
```

---

### 任务 10：展示附件、同步文档并完成全量回归

**文件：**
- 修改：`scripts/editor/public/task-drawer.mjs:1-86`
- 修改：`scripts/editor/public/editor.css`
- 修改：`scripts/editor/test/task-attachments.e2e.mjs`
- 修改：`scripts/editor/test/docs-contract.test.mjs`
- 修改：`package.json`
- 修改：`README.md`
- 修改：`SKILL.md`
- 修改：`references/editing-guide.md`
- 修改：`docs/architecture.md`

- [ ] **步骤 1：先写附件展示与文档契约失败测试**

任务抽屉 E2E 断言附件数量、名称、格式化大小、绝对路径和复制按钮：

```js
await page.locator('[data-task-attachments-toggle]').click();
assert.equal(await page.locator('[data-task-attachment]').count(), 2);
assert.equal(await page.locator('[data-attachment-path]').first().textContent(), first.path);
await page.locator('[data-copy-attachment-path]').first().click();
assert.equal(await page.evaluate(() => navigator.clipboard.readText()), first.path);
```

若 headless clipboard 权限不可用，在 app 层注入 `navigator.clipboard.writeText` spy，断言接收绝对路径，不跳过交互。

文档契约增加关键词：`撤销`、`重做`、`选择文件`、`粘贴图片`、`attachments/`、`25 MiB`、`最多 8 个`、`不进入最终 deck`。

同时断言 package script：

```js
assert.equal(
  packageJson.scripts['test:editor:e2e'],
  'node --test --test-concurrency=1 scripts/editor/test/*.e2e.mjs',
);
```

- [ ] **步骤 2：运行测试确认展示和文档缺失**

```bash
node --test scripts/editor/test/task-attachments.e2e.mjs scripts/editor/test/docs-contract.test.mjs
```

预期：FAIL，找不到附件详情或文档关键词。

- [ ] **步骤 3：实现任务抽屉附件详情**

每个 `task.attachments.length > 0` 的任务行增加：

```html
<button data-task-attachments-toggle aria-expanded="false">附件 2</button>
<div class="task-attachments" hidden>
  <article data-task-attachment>
    <strong>新版架构.png</strong><span>178.1 KiB</span>
    <code data-attachment-path>/absolute/path</code>
    <button data-copy-attachment-path>复制路径</button>
  </article>
</div>
```

DOM 必须用 `textContent` 创建，不用 `innerHTML` 插入文件名或路径。复制成功显示短暂“已复制”，失败显示“复制失败，请手动选择路径”。

- [ ] **步骤 4：同步四份入口文档与串行 E2E 命令**

更新内容必须准确说明：

- 顶栏历史覆盖人工与 Agent group；任务行仍可定点撤销；
- 浏览器无法取得原文件绝对路径，系统复制到 sidecar；
- 每任务最多 8 个、单个 25 MiB、粘贴图片转 PNG；
- API/CLI 返回副本绝对 path；
- 附件不进入最终 deck，随 sidecar 生命周期管理；
- `test:editor:e2e` 显式 `--test-concurrency=1`。

- [ ] **步骤 5：运行文档、单元、E2E 与 Python 全套测试**

```bash
python3 scripts/check_deps.py --check-only
npm run test:editor:unit
npm run test:editor:e2e
python3 -m unittest discover -s scripts/editor/test -p 'test_*.py' -v
```

预期：依赖体检没有编辑器必需项缺失；所有测试 0 fail、0 cancelled。

- [ ] **步骤 6：运行真实 deck 试点与结构验证**

```bash
node --test scripts/editor/test/renzhi-pilot.e2e.mjs
python3 - <<'PY'
import importlib.util
from pathlib import Path
root = Path('.').resolve()
spec = importlib.util.spec_from_file_location('eb', root / 'scripts/edit-bundle.py')
eb = importlib.util.module_from_spec(spec)
spec.loader.exec_module(eb)
for path in sorted((root / 'assets').glob('template-deck*.html')):
    eb.verify(str(path))
    print(f'OK {path}')
PY
```

预期：真实试点 PASS；所有模板输出 `OK`。

- [ ] **步骤 7：确认工作区只包含本计划范围并提交**

```bash
git status --short
git diff --check
git diff --stat HEAD
git add package.json package-lock.json README.md SKILL.md references/editing-guide.md docs/architecture.md scripts/editor/public/task-drawer.mjs scripts/editor/public/editor.css scripts/editor/test/task-attachments.e2e.mjs scripts/editor/test/docs-contract.test.mjs
git commit -m "docs: 完成编辑器历史与附件工作流"
```

预期：提交后 `git status --short` 为空；`.superpowers/` 不进入提交。

---

## 3. 最终交付检查点

全部任务完成后，执行 `superpowers:verification-before-completion`，重新运行以下命令，不复用旧输出：

```bash
npm run test:editor:unit
npm run test:editor:e2e
python3 -m unittest discover -s scripts/editor/test -p 'test_*.py' -v
git diff --check main...HEAD
git status --short
```

同时人工核对：

- 顶栏历史控件位于在线状态和模式徽标之前；
- 人工文字、移动、缩放和 Agent 批次均能从顶部按序撤销/重做；
- 任务行定点撤销后顶部可重做；
- 文件多选、连续追加、删除和粘贴图片均可用；
- 失败后表单与附件仍在；
- API/CLI path 指向真实副本；
- `session.json` 不含绝对附件路径；
- 最终 deck 不含附件 bytes 或 sidecar path；
- 无新增浏览器 console/page/resource 错误；
- E2E 0 cancelled。

完成验证后调用 `superpowers:requesting-code-review`，修复所有高优先级问题并再次运行受影响测试。最后调用 `superpowers:finishing-a-development-branch` 处理集成、PR 或保留分支。
