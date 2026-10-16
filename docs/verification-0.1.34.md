# 0.1.34 局部片段拒绝恢复

2026-10-16。适配原装 Windows Desktop 2.0.13 与配套 DSH 0.1.5-rc.2；没有修改宿主或业务 Deck。

## 问题与边界

真实编辑请求替换了含 49 个 `data-editor-id` 的片段，只保留容器的 1 个编号，丢失 48 个子元素编号。原有校验正确拒绝候选，但准备阶段错误缺少 `committed:false`，原生工具误报 `commitStatus:unknown` 并要求查回执；工具说明也未明确覆盖全部子元素。这是 PPT 元素定位协议问题，不是账号登录或 Harness 认证问题。

保留编号校验。局部候选在内存生成，准备阶段尚未开始源码事务或写入工作副本，此处错误明确标记未提交。编号错误返回 `LOCAL_EDIT_IDENTITY_MISMATCH`、操作下标、缺失／重复数量与最多各 20 个编号。工具透传诊断和 recovery，指导重新 inspect 原片段、按原有内容保留编号后重试；单项仍无法修复时继续无依赖的任务。事务建立后的异常和传输断线仍保留原 commandId 查询规则，避免重复写入。

工具说明、会话上下文和区域批次共享同一段指引；Skill 与编辑指南同步。源码 inspect 提供 `sourceIdentity.requiredCount` 与明确保留范围，不重复输出全部编号列表。

## 已完成的验证

- 原装 CLI 在隔离 Profile 完成 Harness dev.73 + PPT 0.1.33 安装、PPT 升级至 0.1.34、2063 个文件逐项摘要校验和卸载；原装插件、Harness 与用户数据标记保留。当前用户 Profile 未自动安装 PPT 0.1.34。

- 修复前，`node --test --test-name-pattern='工具的子元素编号' scripts/editor/test/local-edit.e2e.mjs` 在真实 Chrome → 原生工具 → HTTP → Python 链路稳定失败：`committed:null`，应为 `false`。
- 修复后，Windows 原装 Desktop 的 Node 与 PPT 私有 Python 运行 28 项 Node 测试和 6 项 Python 测试全部通过。覆盖拒绝后的无写入、无历史推进、锁释放、保号修复提交、后续独立修改、撤销重做、版本／交互冲突、取消及完整浏览器重放。
- WSL 的同类 16 项回归及 12 项上下文／工具测试通过。新增的源码编号数量、事务后异常状态断言单独复核。
- 只读重放真实失败请求，确认报告缺失 48 个编号；保留 49 个编号的修改候选可生成。未写入用户 Deck，也未自动执行用户剩余 6 项任务。

完整包基于 `0.1.33` 仅叠加 13 个新增／修改文件；私有 Python、浏览器与运行依赖保持不变，避免混入其他开发中的改动。最终包摘要、逐文件比对和原装 CLI 安装升级／卸载结果见工作区 `.verification/ppt-local-edit-0134/release-result.json`，安装命令见根目录 `INSTALL.md`。

本次是错误协议、工具指引及确定性流程回归；没有重新执行真实模型的整批业务验收，不能据此承诺模型永不生成错误片段。
