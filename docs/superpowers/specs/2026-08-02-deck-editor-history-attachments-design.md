# Deck 可视化编辑器全局历史与任务附件设计

日期：2026-08-02  
状态：已完成交互设计确认，待书面规格审查

## 1. 背景

Deck 可视化编辑器已经使用统一的 `PatchJournal` 管理人工文字、移动、缩放与 Agent 动作。动作以 group 为单位持久化到 session，服务端已支持按 `groupId` 撤销和重做，但当前界面只有已完成 Agent 任务行上的定点撤销入口，用户无法从全局工作台按时间顺序回退普通人工修改或最近一次 Agent 修改。

区域标记任务目前保存修改说明、1920×1080 标准坐标、候选元素和区域快照。用户还需要为任务补充参考文件，既能从系统文件选择器添加文件，也能把剪贴板图片直接粘贴到任务中，外部 Agent 读取任务时可获得本地文件路径。

浏览器文件选择器不会暴露原文件的绝对路径。因此本设计不记录无法获得的原路径，而是把附件安全复制到当前 sidecar 会话，并向 Agent 输出副本的绝对路径。

## 2. 目标与非目标

### 2.1 目标

1. 在全局顶栏增加“撤销 / 重做”控件。
2. 按严格时间顺序撤销最近一个仍生效的动作组，并恢复最近撤销的动作组。
3. 人工文字、移动、缩放和 Agent 批量动作共享同一套权威历史。
4. 保留任务抽屉中的定点撤销，并让它与顶部重做状态一致。
5. 区域任务支持多附件选择、连续追加、粘贴图片和提交前删除。
6. 附件复制到 sidecar，任务 API 与 Agent CLI 返回可直接读取的绝对路径。
7. 附件写入、任务状态和 session revision 保持事务一致；失败时不留下已发布孤儿文件。
8. 保持旧 JSON 任务接口与旧 session 向后兼容。

### 2.2 非目标

1. 不实现跨 session 或跨 deck 的历史记录。
2. 不让顶部历史控件撤销“创建任务”或“添加附件”本身；它只操作 Deck 修改动作组。
3. 不接管 `Cmd/Ctrl+Z`、`Cmd/Ctrl+Shift+Z`，避免干扰 textarea、文字直接编辑和系统输入法。
4. 不记录选择文件前的原始绝对路径。
5. 不把附件嵌入最终 deck，不把附件复制到 deck manifest。
6. 不提供附件在线预览、内容解析、病毒扫描或 Agent 内置聊天。
7. 不在本次改动中重构现有动作协议或写回事务模型。

## 3. 已选方案

采用“复用现有权威动作日志”方案：

- 顶部控件从权威 session 的 `groups`、`redo` 和 `revision` 派生状态；
- 实际操作继续调用现有 `/api/groups/:id/undo|redo`；
- `expectedRevision` 继续承担竞态保护；
- 区域任务接口扩展 multipart 提交，附件由 sidecar 专用写入边界负责；
- 不建立浏览器本地撤销栈，也不创建第二套 command/event 历史。

## 4. 全局撤销与重做

### 4.1 布局

视觉方案采用已确认的 A 方案：控件位于全局顶栏右侧，排列顺序为：

```text
[撤销] [重做]    [在线状态] [当前模式]
```

两个按钮形成一个紧凑控制组，包含文字与方向图标。无候选动作时按钮显示禁用状态。请求进行期间两个按钮同时锁定，防止重复提交。

控件位于全局顶栏而非画布工具栏，表达它控制整个编辑会话，不只控制当前页面或当前编辑模式。

### 4.2 历史候选规则

权威 session 中：

- `groups` 按创建顺序保存全部动作组；
- `group.active === true` 表示动作组当前生效；
- `redo` 按撤销发生顺序保存可重做的 group ID；
- 新动作组写入后继续沿用现有语义清空 `redo`。

顶部候选计算规则：

```text
undoGroup = groups 从后向前第一个 active === true 的 group
redoGroup = redo 最后一个 ID 对应的 inactive group
```

人工文字、移动、缩放分别以一次提交形成一个 group。Agent 一次 `/api/actions` 批次形成一个 group，因此顶部撤销会整体回退该批次。

### 4.3 定点撤销与全局历史的关系

任务抽屉继续允许按任务关联的 `groupId` 定点撤销。定点撤销完成后：

- 对应 group 变为 inactive；
- group ID 进入现有 `redo`；
- 任务状态由 `completed` 恢复为 `pending`；
- 顶部“重做”立即指向这次定点撤销；
- 顶部“撤销”跳过该 inactive group，寻找最近的 active group。

重做该 group 后，任务重新变为 `completed`，并恢复原 `groupId`。

### 4.4 请求与同步

点击按钮时，前端使用当前 session 派生的 group ID 调用现有 group API，并提交 `expectedRevision`。

成功后必须：

1. 更新 revision；
2. 拉取或等待对应 revision 的权威 session；
3. 用完整 compiled actions 同步 iframe；
4. 更新关联任务状态；
5. 重新计算两个按钮的候选与禁用状态。

若收到 `REVISION_CONFLICT`，前端重新加载权威 session，不自动对新候选执行撤销，避免用户原本想撤销的动作发生变化。界面提示“历史已更新，请重试”。

若服务端已经持久化但确认回执丢失，沿用现有 committed/syncPending 语义，通过 session 恢复确认最终状态，不用局部 DOM 猜测成功与否。

### 4.5 动作摘要

按钮 `title` 和可访问标签显示候选摘要：

- 有 `taskId`：`撤销 Agent 任务：<任务说明截断>`；
- 单个 `setText`：`撤销文字修改`；
- 单个 `translate`：`撤销移动`；
- 单个 `resize`：`撤销缩放`；
- 其他或混合动作：`撤销一组修改（N 项）`。

重做使用相同规则替换动词。摘要仅用于显示，不参与权威行为判断。

## 5. 区域任务附件交互

### 5.1 弹窗布局

区域标记弹窗按以下顺序排列：

1. 修改说明 textarea；
2. “选择文件”按钮；
3. “可直接粘贴图片”提示；
4. 已选附件列表；
5. 状态消息；
6. “取消 / 添加任务”按钮。

附件列表每项显示文件类型图标、文件名和格式化后的大小，并提供删除按钮。提交进行期间禁止继续选择、粘贴、删除或重复提交。

### 5.2 文件选择

“选择文件”打开系统文件选择器，允许一次多选。后续再次选择会追加到现有列表，而不是替换列表。浏览器内以 `File` 对象保留内容，点击“添加任务”前不上传。

限制如下：

- 每个任务最多 8 个附件；
- 每个附件必须大于 0 字节且不超过 25 MiB；
- 不接受目录；
- 文件类型不设白名单；
- 原始文件名仅作为显示元数据，不直接作为磁盘身份。

重复选择同一文件不做内容去重，每次选择都是独立附件，由 UUID 区分。

### 5.3 粘贴图片

区域任务弹窗打开时，在修改说明输入区域粘贴剪贴板图片会追加一个附件。浏览器把图片解码后重新编码为 PNG，自动命名为：

```text
pasted-image-YYYYMMDD-HHmmss-NNN.png
```

大小限制应用于重新编码后的 PNG。若同一次粘贴只有文字，保持 textarea 的原生粘贴行为；若包含图片，则添加所有仍未超过数量限制的图片，并显示成功或超限提示。

### 5.4 提交结果

任务创建成功后，弹窗关闭，任务抽屉显示附件数量。任务行可展开附件元数据，并显示或复制 Agent 可读取的绝对路径。

上传或任务创建失败时，弹窗保持打开，已填写文字、选区与浏览器内附件不丢失。用户可删除问题附件或直接重试。

## 6. 数据模型

### 6.1 持久化任务

任务新增可选字段：

```json
{
  "attachments": [
    {
      "id": "UUID v4",
      "name": "新版架构.png",
      "mime": "image/png",
      "size": 182340,
      "source": "selected",
      "relativePath": "attachments/<task-id>/<attachment-id>.png",
      "createdAt": "ISO-8601"
    }
  ]
}
```

`source` 仅允许 `selected` 或 `pasted`。旧 session 中缺少 `attachments` 时按 `[]` 读取。

磁盘文件名使用 attachment UUID 和经过验证的短扩展名，不使用原始文件名。`name` 保留给人和 Agent 识别。

### 6.2 API 与 CLI 输出

持久化状态只保存 `relativePath`，避免工作目录整体移动后留下旧绝对路径。`GET /api/tasks`、`GET /api/tasks/:id` 和 Agent CLI `tasks/task` 在响应时为每个附件补充：

```json
{
  "path": "/absolute/project/.huawei-deck-editor/<session>/attachments/..."
}
```

`path` 是派生输出，不回写到 `session.json`。路径解析必须确认最终目标仍位于已绑定的当前 session 附件目录中。

## 7. HTTP 与持久化流程

### 7.1 接口兼容

`POST /api/tasks` 同时接受：

- 现有 `application/json`：用于无附件任务和兼容旧调用者；
- 新增 `multipart/form-data`：浏览器区域任务统一使用。

multipart 包含：

- `task`：单个 JSON 元数据 part；
- `snapshot`：零或一个 PNG part；
- `attachment`：零到八个文件 part。

所有现有 Bearer、Origin、loopback、editor capability 和 revision 校验继续生效。未知字段、重复 `task`、重复 `snapshot`、超限 part、截断请求或无效 JSON 均在改变 session 前拒绝。

### 7.2 流式暂存与发布

附件不得整体 base64 编码进 JSON。服务端流式接收文件并交给 attachment writer，写入当前 session 的受控临时区。writer 与 sidecar helper 继续验证启动时绑定的目录身份，拒绝符号链接、路径穿越和会话目录替换。

完整流程：

1. 校验请求鉴权、revision 和任务元数据；
2. 为任务和附件生成 UUID；
3. 流式写入 session 内临时附件目录，同时计算实际字节数；
4. 校验数量、非空、单文件 25 MiB 上限和请求完整性；
5. 原子发布附件目录；
6. 持久化包含附件相对路径的新 session revision；
7. 广播 `task-created` 并返回带绝对 `path` 的任务。

若步骤 5 后步骤 6 失败，删除已发布附件目录；若删除也失败，返回独立恢复错误并冻结 mutation，避免声称任务已创建。服务启动时检查未被权威 session 引用的临时目录，并安全清理中断上传。

### 7.3 生命周期

附件属于任务上下文：

- Deck 动作撤销或重做不删除附件；
- Deck 正式写回不复制或嵌入附件；
- 关闭并重启编辑器后附件继续可用；
- 删除整个 `.huawei-deck-editor/` 会连同任务、快照和附件一起清理；
- 第一版不提供单独删除已提交任务或已发布附件的 UI。

## 8. 错误处理

前端使用稳定错误码映射用户提示：

| 错误码 | 含义 | 用户恢复动作 |
|---|---|---|
| `TOO_MANY_ATTACHMENTS` | 超过 8 个附件 | 删除附件后重试 |
| `ATTACHMENT_EMPTY` | 文件为空 | 删除该附件 |
| `ATTACHMENT_TOO_LARGE` | 单文件超过 25 MiB | 压缩或更换文件 |
| `ATTACHMENT_WRITE_FAILED` | 暂存写入失败 | 检查空间与权限后重试 |
| `ATTACHMENT_RECOVERY_REQUIRED` | 发布后补偿失败 | 重启服务执行恢复，不再提交新 mutation |
| `INVALID_MULTIPART` | multipart 格式无效或请求截断 | 重新选择并提交 |
| `REVISION_CONFLICT` | 提交期间 session 已变化 | 保留表单，刷新权威 revision 后重试 |

任何附件错误都不得创建 task、增加 revision 或广播 `task-created`。

## 9. 组件改动边界

| 组件 | 职责变化 |
|---|---|
| `public/index.html` / `editor.css` | 顶栏历史控件与附件列表样式 |
| `public/editor.mjs` | 派生历史候选、调用 group API、multipart 任务提交 |
| `public/frame-bridge.mjs` | 文件选择、剪贴板图片转 PNG、附件列表与状态保持 |
| `public/task-drawer.mjs` | 显示附件数量、名称和绝对路径 |
| `patch-journal.mjs` | 提供可单测的最近 undo/redo 候选查询，不改变 group 状态模型 |
| `protocol.mjs` | 校验持久化附件元数据 |
| `server.mjs` | 安全解析 multipart、序列化带绝对路径的任务 |
| `session-store.mjs` | 任务与附件原子提交、补偿和旧 session 兼容 |
| `sidecar-io.mjs` / `sidecar_io.py` | 绑定 attachments 目录、发布与清理专用操作 |
| Agent CLI | 原样输出任务附件的绝对 `path` |

## 10. 测试策略

### 10.1 单元测试

1. 最近 active group 与 redo 栈尾候选计算。
2. 人工文字、移动、缩放、混合和 Agent group 的摘要。
3. 任务定点撤销后的全局 undo/redo 候选。
4. 附件元数据、数量、大小、来源和相对路径校验。
5. 旧 session 缺少 `attachments` 时恢复为空数组。
6. API 输出的绝对路径不能逃出 session attachments 目录。

### 10.2 服务与安全测试

1. JSON 与 multipart 两种任务提交均可用。
2. 无 token、错误 Origin、未知 part、重复 part、截断 multipart 全部拒绝。
3. 8 个附件成功，第 9 个拒绝；0 字节和超过 25 MiB 拒绝。
4. 文件名路径穿越、attachments 或临时目录符号链接、启动后目录替换全部拒绝。
5. 附件发布失败、session persist 失败和补偿删除失败具有准确 commitScope 与恢复语义。
6. 任意失败路径不增加 revision、不创建 task、不广播事件。
7. 重启清理中断暂存，同时保留权威 session 已引用附件。

### 10.3 浏览器 E2E

1. 顶栏按钮在无历史时禁用，并在每类人工动作和 Agent 动作后启用。
2. 连续撤销、重做、刷新恢复和 revision 冲突后的按钮状态正确。
3. 任务行定点撤销后顶部可重做，重做后任务状态与页面效果恢复。
4. 文件选择器多选、连续追加、逐项删除和限制提示正确。
5. textarea 原生文字粘贴不受影响；粘贴图片转为 PNG 附件。
6. 上传失败时文字、选区和附件列表保留。
7. 任务抽屉与 Agent CLI 均能读取附件名称和绝对路径。

完整 E2E 使用 `--test-concurrency=1` 串行运行，避免多个真实 Chrome 文件并行造成的资源竞争干扰验收结果。

## 11. 验收标准

1. 用户能从全局顶栏按时间顺序撤销和重做所有 Deck 修改来源。
2. 刷新、断线恢复和 Agent 并发修改后，顶部按钮仍与权威 session 一致。
3. 用户能为选区任务添加多个文件，并能直接粘贴图片。
4. 任务创建后，外部 Agent 能从 API 或 CLI 获得每个附件的可读绝对路径。
5. 附件不会进入最终 deck；重启编辑器后仍可读取。
6. 上传、持久化、补偿或路径校验失败时不产生错误 task 或孤儿已发布附件。
7. 新增单元、服务、安全和浏览器 E2E 全部通过，现有编辑器回归测试继续通过。
