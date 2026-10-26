# AICO-PPT

HTML Deck 制作与可视化编辑，交付原装 DSH Desktop 业务插件和独立 Skill，共用根目录 `SKILL.md`。当前适配官方 Desktop／DSH `0.2.1-rc.2`，桌面包为 Windows x64，macOS 暂缓。

源码版本以 [package.json](package.json) 为准；公开包与本地候选统一见[版本与发布](docs/releases.md)，完整入口见[文档导航](docs/README.md)。

## 安装与使用

从[官方安装页](https://openx.huawei.com/project/7665/AICO-Plugin-Web_master/install-official.html)下载并校验完整包，在原装“插件 → 添加插件”中填写本地 `.tgz` 完整路径。先安装并启用 Harness，再安装 PPT；更新前保存工作和未发送草稿，按原装结果决定是否重启。步骤见[安装指南](INSTALL.md)。

左侧使用原装对话，右侧运行 Editor。新建 Deck 选择项目目录，修改时打开已有 HTML；直接编辑或跨页框选后，将任务交给关联会话。切换普通对话不会把在途任务转移到其他项目。

支持五套离线单文件模板、放映／滚动、逐步动画、撤销／重做、参考材料提取及 PPTX 导出。聊天附件、区域附件、本地路径和 file URL 可直接内嵌，图片需通过加载与解码检查。固化成功后回收不再需要的完整 HTML 历史，默认保留最近一份固化前备份；未固化历史仍保留。

- [快速开始](docs/user-guide/quick-start.md)、[创建 Deck](docs/user-guide/create-deck.md)、[编辑 Deck](docs/user-guide/edit-deck.md)。
- [预览与任务](docs/user-guide/preview-and-tasks.md)、[验证与导出](docs/user-guide/verify-and-export.md)、[故障排查](docs/user-guide/troubleshooting.md)。
- [制作流程](references/workflow.md)、[设计规范](references/design-system.md)、[配图与材料](references/artwork.md)。

![Deck 操作演示](docs/showcase/deck-demo.gif)

## 独立 Skill

从完整源码注册；无需 Harness，制作与导出依赖按任务准备：

```bash
python3 scripts/install.py install --skill-only
python3 scripts/check_deps.py --profile editor-core --check-only
```

Windows 使用 `py -3 scripts\install.py install --skill-only`。安装器保留已有项目、工作副本与会话，不覆盖来源不明的同名目录。独立 Skill 的跨平台能力不代表桌面插件已交付相应平台包。

## 开发与维护

`integrations/dsh/` 是宿主适配入口，`scripts/` 是制作、编辑和验证工具，`references/` 是 Skill 按需参考，`assets/` 是五套模板与配套素材。

- [架构](docs/architecture.md)、[领域语言](CONTEXT.md)、[DSH 接入](integrations/dsh/README.md)。
- [项目生命周期](docs/design/project-lifecycle.md)、[会话管理及未完成项](docs/design/dsh-deck-workspace-session-management-design.md)、[Deck 身份与文件绑定](docs/design/editor-deck-identity-file-binding-design.md)。
- [开发约束](AGENTS.md)、[执行规范](SKILL.md)、[版本化验证](docs/verification/README.md)。

运行 `npm run test:dsh-plugin` 和适用的 `test:editor:*` 回归。模板改动还需溢出检测、截图、逐拍验证和 bundle 结构检查。Windows 执行 Agent、业务和工具，WSL 只连接模型；组件检查不能代替原装 Desktop、最终包和双连接业务验收。

许可与素材范围见 [LICENSE](LICENSE) 和[品牌来源](assets/huawei-refs/README.md)。
