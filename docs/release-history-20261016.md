# beta0.2 发布前开发安装记录

以下为开发过程历史记录。当前用户安装方式见 [INSTALL.md](../INSTALL.md)，不要使用历史开发包路径作为最新发行命令。


2026-10-16：本地 `0.1.37` 修复编辑模式删空富文本后再次编辑误报 `TARGET_AMBIGUOUS`／`TARGET_NOT_FOUND`。仅在本次运行已成功提交、完整内容一致时跳过重复应用；真实内容变化仍报告冲突。包含 `0.1.36` 的全部修复。安装后保存工作、退出托盘并重新打开 Desktop 生效；安装不改写用户 Deck。

2026-10-16：本地 `0.1.36` 自动内嵌当前 Deck 已登记的图片附件，提交前验证图片加载／解码，拒绝损坏图片并回滚局部事务；错误栏显示页码与图片资源。包含 `0.1.35` 的五套模板“开始”导航及此前修复。

在原装 DSH Desktop 托盘菜单的 Terminal 中执行：

```powershell
dsh plugin add "C:\Users\z00633277\workspace\AICO-2.0\AICO-PPT\dist\aico-ppt-skill-0.1.37-win32-x64.tgz" --ignore-scripts --config.auto-install-peers=false
```

安装后保存工作，从托盘完全退出并重启 Desktop。安装不自动改写已有 Deck。已写入的错误路径需在重新打开原工作项后，用 `replaceImage(attachmentPath)` 重新内嵌对应附件；保存时完成固化。新建 Deck 使用新版模板，旧 Deck 经编辑脚本重写时更新错误栏，原有自定义导航入口在模板升级时保留。Harness 配套版本继续使用 `2.0.0-dev.73`。

2026-10-16：本地 `0.1.34` 修复局部片段的元素编号拒绝恢复：明确未提交、报告缺失／重复编号，Agent 按原片段修复并继续无依赖的任务。保留编号与撤销历史校验。完整 Windows 包基于 `0.1.33` 叠加本次修复，私有运行时保持不变。

在原装 DSH Desktop 托盘菜单的 Terminal 中执行：

```powershell
dsh plugin add "C:\Users\z00633277\workspace\AICO-2.0\AICO-PPT\dist\aico-ppt-skill-0.1.34-win32-x64.tgz" --ignore-scripts --config.auto-install-peers=false
```

安装后保存工作，从托盘完全退出并重启 Desktop，重新打开原工作项。Harness 目标轮次约束使用 `2.0.0-dev.73`，与本次 PPT 修复分属两个插件。公开 beta0.1 附件与官网未更新。

2026-10-12：本地 `0.1.33` 排除私有 Python 有源码的可再生字节码缓存，修复再次加载时 `Runtime file digest changed` 导致插件不可用的问题；保留 `0.1.32` 的修复： 修复初稿发布后再次出现自动制作长消息的问题。Creation CLI 在当前轮返回制作回执；制作中禁止重复启动，取消或失败后的显式重试也沿用当前轮。保留 `0.1.31` 的创建工作区状态修复。完整 Windows 包为 `dist/aico-ppt-skill-0.1.33-win32-x64.tgz`，安装后保存工作，从托盘完全退出并重启 Desktop。公开 beta0.1 附件和官网清单未改变。

```powershell
dsh plugin add "C:\Users\z00633277\workspace\AICO-2.0\AICO-PPT\dist\aico-ppt-skill-0.1.33-win32-x64.tgz" --ignore-scripts --config.auto-install-peers=false
```

2026-10-12：本地 `0.1.31` 修复 Creation Draft 尚未生成 Deck 时误报“Editor 不可用”的问题，区分创建、编辑和断开状态。完整包为 `dist/aico-ppt-skill-0.1.31-win32-x64.tgz`；安装后重启 Desktop 生效。公开 beta0.1 附件和官网清单未改变。

## 本地优化包：0.1.30

2026-10-05：新增配合 Harness dev.62 的只读重启检查与固定运行版本。未提交输入、正在执行或保存的修改会阻止自动重启；已持久化的未固化历史可以保留到重启后。修复无关标注增删改使 Agent 编辑误报版本冲突；保留当前任务变化和真实 Deck 修改的冲突保护。明确未提交的拒绝不再要求查询回执。包含此前局部结构编辑、按需上下文、截图复用与跨页撤销／重做修复。Windows 完整包为 `dist/aico-ppt-skill-0.1.30-win32-x64.tgz`，包含私有 Python、浏览器和运行依赖；本地构建不代表官网已发布，也不代表已完成 Windows 整机验收。

在原装 Desktop 的 DSH Terminal 依次安装本地新包（替换为实际路径）：

```powershell
dsh plugin add "C:\Users\z00633277\workspace\AICO-2.0\AICO-Harness-Plugin\dist\aico-harness-2.0.0-dev.62.tgz" --ignore-scripts
dsh plugin add "C:\Users\z00633277\workspace\AICO-2.0\AICO-PPT\dist\aico-ppt-skill-0.1.30-win32-x64.tgz" --ignore-scripts
```

保存工作，从系统托盘完全退出 DSH Desktop，再重新打开一次以加载新的提醒逻辑。
