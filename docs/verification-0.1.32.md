# 0.1.32：初稿重复调度修复验证

日期：2026-10-12。范围仅 AICO-PPT；原装 Desktop、DSH 和 Harness 不作代码修改。本包保留此前 0.1.31 的 Creation Draft 可用状态修复。

## 根因与修改

真实会话中，13:05 执行 `start-generation` 时，PPT 插件向同一 DSH 会话的 next-turn 队列追加完整制作提示。原 Agent 在当前轮继续制作，13:31 已发布 HTML；13:33 当前轮结束后，旧制作提示才开始执行。入队与执行时的消息 ID、内容一致；不是用户再次输入，也不是网络重试。

现在由 App Server 的 Draft capability 鉴权结果识别 Agent 调用，将制作信息放入工具回执的 `continuation`，由当前轮继续。调度选择不由命令 JSON 自报。回执包含 Draft / run 身份和当前工作副本、规划契约与完成命令；不再重复拼接完整 Skill，不降低模板、验证或发布要求。回执不持久化到 Draft。

独立浏览器入口保留单次会话投递，Dev Shell 的最终 Editor 地址交接保持原有行为。已有 generation 时拒绝重复 start；失败验证可原位再验，明确 retry 才新建 run。

## 自动化验证

- 修复前运行 `node --test scripts/editor/test/creation-generation-dispatch.test.mjs`，复现“已发布但仍有 1 条制作消息”，并发现制作中重复 start 未被拒绝。修复后原用例通过。
- Editor Node 全量：773 通过、3 跳过、0 失败。
- DSH 插件适配：49 通过、2 跳过、0 失败。
- Python：235 项中 226 通过、9 跳过、0 失败。
- 真实 Chrome：6 项通过。覆盖当前轮 CLI 回执、工作副本修改、画布自动更新、发布与最终 Editor 交接、后台固化和 DSH 会话导航。
- Windows 原装 Desktop 2.0.13 的 Electron Node：6 项生成调度回归全部通过。
- Windows 原装 Desktop 的 Node + 私有 Python + 真实 Chrome：2 项创建、发布和最终 Editor 交接测试通过。首次运行在 DOM 文本已可见但全页诊断尚未返回时请求发布，被 `DIAGNOSTICS_UNAVAILABLE` 正确拒绝；测试补充等待权威诊断状态后，在 Windows 与 Linux 均通过。没有绕过或放宽发布检查。

新增调度回归使用真实 CLI 子进程、App Server、鉴权、文件 Draft 状态机和 DSH Relay，覆盖：

1. 当前轮制作并发布后不残留下一轮制作消息。
2. 浏览器入口只提交一次，命令正文不能伪造调用来源。
3. 制作中拒绝重复启动；失败验证保留已有成果并可原位恢复。
4. 取消后的显式重试正确生成新 run，继续当前轮。
5. 并发 start 只有一个成功、一次制版。
6. 工作台切回首页后，后台 Agent 仍按原 capability 制作。

调度回归替换了耗时的制版/渲染验证器；Chrome 创建场景保留真实 Editor、工作副本与固化，模板验证使用夹具。实际模板和发布闸门另由全量 Node/Python 测试覆盖。上述结果不等同于已完成生产会话中 30 页模型创作重跑、全部业务插件及本机/WSL 模型组合验收。跳过项保持测试声明，不计为通过。

## 安装包

- 文件：`dist/aico-ppt-skill-0.1.32-win32-x64.tgz`
- 字节：246879746
- SHA-256：`a002d0d8a6c60b5fb3e2d54f539ae241efc92aed76f9ad26b96a1bb919a491c0`
- 修改过的运行时代码与包内文件逐字节一致；私有 Python/浏览器的 3900 个资源清单及压缩载荷与 0.1.31 完全一致。
- 原装 Windows Desktop 2.0.13 CLI 隔离安装/升级/卸载：通过（约 188 秒）。先安装 Harness dev.66 与 PPT 0.1.31，再升级本包；2062 个包文件与安装结果逐项一致。卸载 PPT 后原装插件、Harness 和用户数据哨兵保留。

测试命令：

```bash
node scripts/run-editor-tests.mjs unit
node --test integrations/dsh/tests/*.test.mjs
node scripts/run-editor-tests.mjs python
node --test scripts/editor/test/creation-generation-dispatch.test.mjs
node --test --test-name-pattern='Agent 当前轮制作发布|Creation 发布后的中间画布' scripts/editor/test/app-launch.e2e.mjs
node --test --test-concurrency=1 scripts/editor/test/creation-background-publish.e2e.mjs scripts/editor/test/dsh-session-navigation.e2e.mjs
```

Windows 用原装 Desktop 可执行文件的 `ELECTRON_RUN_AS_NODE=1` 模式运行新增调度测试及 `integrations/dsh/tests/desktop-install.integration.mjs`。安装测试只使用自己的临时 DSH_HOME，不升级用户正在运行的 Profile。

安装后须保存工作，从托盘完全退出 Desktop，再重新打开。已有会话中的历史消息保留；本修复不修改原装会话日志。
