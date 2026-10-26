# 文件和图片直接插入 Deck：2026-10-24

## 问题与用户确定的行为

原装聊天框粘贴图片后，模型能理解图片，但要求用户经 Editor 区域任务附件按钮再次上传，不能直接插入右侧 Deck。原因是 `aico_ppt` 未将聊天附件接入资源解析，而 `resolveLocalImages` 只接受已登记的 Deck 任务附件；共享说明也要求其他本地图片先上传。

用户进一步明确：所有文件和图片插入不按来源划分信任区；聊天、框选任务附件以及指定本地文件统一直接使用，不要求重复上传或预先登记。

## 实现

- 原装会话中的图片、普通文件引用以及首步尚未写入日志的接纳消息统一提供给模型。`inspect` 与上下文分别列出最近 32 张图片和 32 个文件，包含可直接引用的 `src`；文字追问继续可使用历史附件，工具生成的图片也可插入。工具调用之后的新消息留给下一轮，避免并发发送改变本轮素材。
- 图片使用 `replaceImage.src` / `attachmentPath`，或局部片段的 `img.src`；普通文件使用 `<a download="文件名" href="文件来源">文件名</a>` 作为可下载附件内嵌。来源支持聊天附件 `src`、区域附件路径、本地路径和 file URL。相对路径以源 Deck 所在目录为基准，不因位于工作区外而拒绝。按普通文件上传的图片也可直接用于 `img.src`。
- 聊天附件通过公开 `attachments.readImage(ref, signal)` 或 `readFileStream(ref, signal)` 读取；本地和区域附件直接读取。文件字节经现有 capability 鉴权请求进入 Editor；聊天传输校验规范 base64、SHA-256 和实际图片类型。普通文件保留原字节，以 `application/octet-stream` 内嵌，下载名称由片段的 `download` 属性保留。
- 资源统一写入 bundle manifest，沿用局部源码事务、完整历史重放、图片解码检查、撤销重做与固化流程。文件位置不成为最终 Deck 依赖，不创建多余反馈任务。读取失败报告实际不存在、不可读或类型/大小/显示问题，不以来源或未登记为由要求重传。
- 字节独立于 HTML 片段传输，避免正常截图触发 100000 字符片段上限；仅 `/api/local-edits` 允许容纳 25 MiB 文件 base64 及 1 MiB 元数据的请求，其他 JSON 路由仍为 1 MiB。单批所有文件合计最多 25 MiB。字节不进入模型提示或工具返回值，不写临时副本。
- 已提交命令重放不再读取聊天附件。读取失败发生在提交前，返回明确未提交；编辑传输不明仍按相同 commandId 查询。

只读接口依据为官方 DSH `upstream-official/deepseek-harness-dsh-v0.2.1-rc.2/packages/attachment/attachment/src/index.ts` 的 `AttachmentStore.readImage`、`readFileStream` 及相邻 `types.ts` 的附件引用类型。使用插件已有 `attachments` 注入，不修改原装宿主、模型提供方或 WSL 网关。

## 复现与验证

修复前实际执行以下两条命令，分别复现聊天图片未接入，以及本地文件因未登记而被拒绝：

```bash
node --test --test-name-pattern='聊天中上传' integrations/dsh/tests/editing-tools.test.mjs
node --test scripts/editor/test/local-image-resources.test.mjs
```

第一条失败断言为“inspect 应提供可直接插图的聊天图片标识”，实际值 `undefined`。第二条报错“图片路径不是当前 Deck 已登记的任务附件，请先上传图片附件”。修复后两个用例均通过。

环境为 Linux、Node 22.14.0、Python 3 与本机 Google Chrome，所有 Deck、sidecar 和文件夹均为测试独占临时数据。

```bash
python3 scripts/check_deps.py --profile editor-core --check-only
npm run test:dsh-plugin
node --test scripts/editor/test/local-image-resources.test.mjs
python3 -m unittest discover -s scripts/editor/test -p test_local_edit.py -v
node --test --test-concurrency=1 scripts/editor/test/image-resources.e2e.mjs scripts/editor/test/local-edit.e2e.mjs
git diff --check
```

真实浏览器用例验证：约 1.7 MiB 的有效 PNG 经实际 `aico_ppt inspect → structure → /api/local-edits` 插入，原始 768 像素宽度可显示；普通聊天文件能从 Deck 内嵌 blob 读取原文；相同命令重放、替换、撤销和重做通过。另一个用例直接从无关临时目录插入本地图片 file URL 与普通下载文件，确认可显示、可读取，且工作副本不保留外部文件路径。

最终结果：插件回归 62 通过、2 跳过、0 失败；本地资源测试 1 通过；Python 局部编辑 6 通过；文件/图片浏览器 6 通过，局部编辑浏览器 7 通过，合计 13 项真实浏览器回归通过；依赖体检与差异空白检查通过。跳过项为当前 Linux 环境下的 Windows 孤儿进程及 Electron / PowerShell 专项。

单元覆盖首步接纳、无图追问、历史记录、不同消息来源、按文件上传的图片、普通文件流读取、相对路径、内容摘要、编码、大小和取消。原区域附件、坏图回滚、局部结构编辑与历史验证继续通过；未添加临时调试日志。

## 交付范围

本次修复作为本地 `0.1.43` Windows x64 完整候选包交付：`dist/aico-ppt-skill-0.1.43-win32-x64.tgz`，同目录提供 `.sha256` 和 `.verification.json`。包内包含私有 Python、浏览器及插件依赖；原有 `0.1.42` 包保持不变。未公开发布、未更新用户当前 Desktop Profile，官网未改变。测试中的原装附件服务按公开接口替身实现；Editor、Python 转换、Chrome 渲染和历史校验真实执行。

原生 Windows Desktop 的聊天上传联测、最终安装包及本机/WSL 模型联合验收尚未完成。业务和工具仍由 Windows 执行；模型连接方式不改变文件插入实现。子 Agent 没有继承附件引用时，仍可直接引用其已知本地路径；本次不新增跨会话附件检索功能。
