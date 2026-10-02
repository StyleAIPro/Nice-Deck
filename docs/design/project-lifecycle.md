# AICO-PPT 项目生命周期适配

> AICO 2.0 原装宿主迁移说明：客户端入口显式绑定 AICO-Harness 适配插件，不修改 DSH 或 DSH Desktop。PPT 编辑服务与业务逻辑保持原有实现，客户端通过适配服务注册工作台。下文完整项目生命周期描述仍需在原装宿主上完成适配及验收；当前安装和界面入口检查通过，不能据此认为项目归档、恢复及 Windows/WSL 流程全部可用。

本实现遵循 [AICO-Harness 插件项目生命周期规范](../../../upstream-old/AICO-Harness/docs/cookbook/plugin-project-lifecycle.zh.md)。发布包外部规范位于 Harness 仓库的 `docs/cookbook/plugin-project-lifecycle.zh.md`。

## 项目与文件

一份 Deck 工作项对应一个项目，稳定身份为 `workId`。多个项目允许共享工作目录；目录登记不是项目所有权证据。原始 Deck、工作副本、编辑历史不因移除项目而删除。源文件暂时不可用只改变文件绑定状态，不触发项目移除或会话归档。

## 移除流程

首页垃圾桶明确提示将归档关联会话和保留文件。`beginRemoval` 原子保存 `removing`、稳定 `operationId`、精确关联会话集合；有未完成会话创建意图或编辑锁时拒绝。随后通过宿主 `projectSessions({ action:'archive', operationId, sessionIds })` 归档，Host 检查执行中、排队及后台任务。成功后 `completeRemoval` 保存本次实际改变的会话集合，将 Catalog 会话标记为归档并清空活动指针。

Host 明确返回忙碌或未提供生命周期能力时回退活动项目；网络超时或不确定失败保留 `removing`，首页“已移除项目”提供“重试移除”。幂等操作不会扩大归档集合。已移除项目从新会话菜单消失，最后一个项目移除也发布空列表；迟到 iframe 上下文必须重新核对服务端目录，不能恢复已删项目。异步目录读取按请求序列忽略旧响应。

PPT 不向 Host 声称工作目录为项目独占，因此不级联注销共享工作区。项目条目和绑定会话仍正常归档；无关联会话的共享目录登记可以保留。

## 恢复与登记修复

“恢复项目”或明确重新打开原 Deck 会恢复原身份，不解除历史会话归档。用户继续项目时创建新的会话。Harness 归档历史中的“恢复”调用 `session/restore-requested`，PPT 使用包含历史项目的反向索引只恢复点击的那段会话，并重新确保工作区登记。

恢复先持久化 `restoring` 与 `restoreOperation`，再调用 Host，收据保存后进入 `active`。恢复期间禁止另一窗口移除或重新打开项目；网络不确定时保留同一操作 ID，首页“已移除项目”提供“重试恢复会话”。Host 成功而收据保存失败也可幂等重试。Host 的归档状态是侧栏可见性的权威。普通会话点击不能隐式恢复已移除项目。

每次创建和打开会话均等待 Host 工作区快照 `phase=ready`，再读取归档集合并确保规范工作目录已登记。初始 pending 不发布菜单、不解析或打开会话，也不向 iframe 广播伪造的空会话；等待超时明确提示重试。归档会话不能经普通 open-session 路径打开。登记失效时显式 `repairRegistration` 保留预分配会话身份，打开旧会话使用相同 `sessionId` 幂等附着到新登记。正常会话切换不会新建项目或重复导入。

## 验证

嵌入 Harness 打开旧 Deck 时，Agent 工作区允许恢复历史版本的空 `dsh` 占位：仅接受唯一 provider、空 conversations、空 activeConversationId 且无额外 provider 字段的记录，转换后仍校验完整结构及 Deck 会话身份，并经 sidecar 原子回写。保留 Deck 编辑历史、会话身份、版本及时间戳；其他系统的项目路径沿用已有目录修复流程，采用当前已解析目录。不把旧 `dsh` 会话转换成 Codex 会话；含有会话或未知字段的记录拒绝自动迁移，独立终端模式不执行此恢复。

全部使用临时数据和假 Host，不修改用户安装、真实 Deck 或真实会话。

- Catalog 回归覆盖移除持久化、重复操作、失败回退、异项目会话拒绝、明确重新打开保留身份与历史归档、处理中禁止重开、原文件保留。
- HTTP 集成回归覆盖最后项目移除、空目录和已移除项目列表、恢复原身份。
- Client VM 回归覆盖服务端目录为准、迟到上下文不复活菜单、空列表更新。
- 协调器回归覆盖已有工作区仍核验、预留会话恢复不重复创建、打开失败保留活动会话。

执行命令：`npm run test:editor:unit`、`npm run test:dsh-plugin`，以及 `node --test scripts/editor/test/dsh-session-navigation.e2e.mjs`。


## 2026-09-19：未关联项目打开规则

直接点击首页历史项目或 Editor 项目列表时，不能仅切换 Deck 后继续使用其他会话。可用的显式关联存在时恢复对应会话；没有关联则确认是否新建项目会话，取消无导航、建会话或模型消息副作用。确认后使用现有 DeckTaskCoordinator 建立 Workspace/Session 关联并发送一次初始化上下文；再打开时复用。取消必须释放项目列表的忙碌状态。

跨页面选择由 workId 定位目标，在目标初始化完成前抑制旧会话 ready 重放。新增 `dsh-unlinked-project.e2e.mjs` 用真实浏览器、App Server、Editor 和 WorkCatalog 验证，DSH Bridge 使用测试 Host；这一测试不等价于完整原装 Desktop 验收。

## 2026-09-20：原装宿主移除能力缺口复核

用户点击首页垃圾桶实际触发 `project-sessions`，当前 ClientCompatibility 未提供旧 `workspaces.projectSessions`。原“请更新 Harness”报错会误导用户：现有 dev.17 也未实现该接口。现改为明确能力缺口，不报告移除成功。

对照来源 `../AICO/AICO-Harness/packages/api/workspace-controller/src/commands.ts` 的 `applyProjectSessions`，旧版在 Host 检查运行、排队、后台任务和冷会话 inbox，再由 `packages/workspace/workspace/src/index.ts` 保存批量操作和回执。当前 `upstream-pristine/dsh-desktop/deepseek-harness` 对应接口仅提供 `archiveSession`；未提供等价批量输入限制、同事务回执或公开恢复操作。

现有 PPT begin→bridge→complete 流程在 HOST_LIFECYCLE_UNAVAILABLE 时尝试按操作 ID/revision 取消 removing。取消失败仍可能留下待重试记录，因此不能只凭界面提示断言 Catalog 已恢复 active。未对用户真实项目执行删除或归档。

分步归档可以用原装公共接口实现，但不等价于旧版跨窗口输入限制和原会话恢复。须由用户确定该行为取舍后实施；不得用隐藏项目入口冒充完整删除，亦不得为实现旧行为改写宿主。

### 待用户确定的分步适配范围（尚未实现）

1. Harness 新增自有项目操作服务：在插件数据目录持久化 operationId、action、精确 sessionIds、操作前归档集合和逐项进度；同 ID 不同参数拒绝，串行重试不扩大成员集合。只调用原装公开单会话归档，不改 registry 文件或替换宿主方法。
2. 在 business Client 子上下文暴露项目生命周期适配函数；PPT 的原始宿主上下文保持不变。接口区分“不支持”“尚未开始失败”和“部分完成”，部分完成不得取消 removing 或报告成功。
3. PPT 沿用 Catalog begin/complete/removing：全部确认归档后才隐藏条目，处理中显示重试和进度；源文件、工作副本、历史和共享目录始终保留。缺少恢复接口时明确提示不能恢复原会话，不能伪造恢复成功。
4. 关闭对应工作台并刷新项目列表，迟到快照不能重新发布 removed 项目；不对相同目录普通会话或其他项目执行操作。
5. 测试覆盖两会话、同目录旁观会话、已归档会话、中途失败及重启重试、收据落盘失败、最后项目和空关联项目。原装隔离 Desktop 使用测试项目验收；并发原装消息输入仍是明确未实现的旧语义。

该方案需要用户接受行为差异，当前没有以此替换旧契约。

## 2026-09-20：用户接受原装能力的分步归档

用户明确要求“按照当前的 DSH Desktop 原装的能力，修改 AICO Harness 实现”，以本节替代前述待确认状态和旧批量原子契约。

Harness dev.18 在 AICO 自有 `project-operations` 目录保存操作记录，通过原装 workspaceRegistry.archiveSession 逐项归档。业务子上下文暴露 projectSessions；不改原装服务方法、注册表文件或宿主源码。同一 operationId 的精确成员集合不可改变，重试已完成操作返回收据。逐项成功后持久化进度，宿主成功但回应丢失时根据归档集合继续；永久缺失的会话不阻止移除，也不计入新增归档集合。

首次检查到运行、排队或后台任务时返回 PROJECT_BUSY，PPT 沿用取消 removing。开始执行后的失败返回 PROJECT_ARCHIVE_INCOMPLETE，保留 removing 并允许重试，不撤销已经归档的部分。只有整个明确集合处理完成才调用 completeRemoval，从项目菜单移除。源文件、工作副本、编辑历史、共享目录及无关会话均保留。当前会话被归档后，原装会话切换可能关闭右侧工作台，可从 AICO-PPT 入口重新打开首页查看“已移除项目”。

PPT 0.1.19 在确认框说明分步归档与恢复限制；原会话恢复先检查能力，在修改 Catalog 状态前明确拒绝。恢复项目仍可用，再继续项目会新建会话。Profile/Knowledge 通过同一 Harness 子上下文可复用分步归档服务，但本轮没有对其业务移除流程做系统验收。

能力边界：忙碌检查是操作前观察，不是跨窗口输入锁。归档期间其他原装入口并发发送不具备旧版原子保护；收据描述操作开始后确认归档的目标，不保证归档动作一定由本操作独占执行。不恢复原会话，不级联删除工作区，不取消任何运行任务。AICO 服务卸载等待正在执行的归档完成；磁盘记录保留供重装后重试。
