# AICO-PPT 项目生命周期适配

本实现遵循 [AICO-Harness 插件项目生命周期规范](../../../AICO-Harness/docs/cookbook/plugin-project-lifecycle.zh.md)。发布包外部规范位于 Harness 仓库的 `docs/cookbook/plugin-project-lifecycle.zh.md`。

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

全部使用临时数据和假 Host，不修改用户安装、真实 Deck 或真实会话。

- Catalog 回归覆盖移除持久化、重复操作、失败回退、异项目会话拒绝、明确重新打开保留身份与历史归档、处理中禁止重开、原文件保留。
- HTTP 集成回归覆盖最后项目移除、空目录和已移除项目列表、恢复原身份。
- Client VM 回归覆盖服务端目录为准、迟到上下文不复活菜单、空列表更新。
- 协调器回归覆盖已有工作区仍核验、预留会话恢复不重复创建、打开失败保留活动会话。

执行命令：`npm run test:editor:unit`、`npm run test:dsh-plugin`，以及 `node --test scripts/editor/test/dsh-session-navigation.e2e.mjs`。
