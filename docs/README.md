# AICO-PPT 文档导航

先从 [项目首页](../README.md)了解用途，再按下表进入当前流程。版本信息只维护在[版本与发布](releases.md)；公开附件由官网清单登记，源码身份读取 `package.json`。

## 当前操作与设计

| 要做的事 | 入口 |
| --- | --- |
| 桌面／独立 Skill 安装 | [阅读](../INSTALL.md) |
| 快速开始 | [阅读](user-guide/quick-start.md) |
| 创建 Deck | [阅读](user-guide/create-deck.md) |
| 编辑 Deck | [阅读](user-guide/edit-deck.md) |
| 预览与任务 | [阅读](user-guide/preview-and-tasks.md) |
| 验证与导出 | [阅读](user-guide/verify-and-export.md) |
| 故障排查 | [阅读](user-guide/troubleshooting.md) |
| 架构 | [阅读](architecture.md) |
| 项目生命周期 | [阅读](design/project-lifecycle.md) |
| 会话管理和待完成项 | [阅读](design/dsh-deck-workspace-session-management-design.md) |
| Deck 身份与文件绑定 | [阅读](design/editor-deck-identity-file-binding-design.md) |
| 领域语言 | [阅读](../CONTEXT.md) |
| AI 执行规范 | [阅读](../SKILL.md) |

## 验证与研究

- [验证记录](verification/README.md)：按包版本、宿主和环境限定的分项检查、失败与回执。
- [研究资料](research/README.md)：带日期的源码／协议研究，不能替代当前操作步骤或验收。


## 其他维护契约与决策

- [Deck 身份独立于文件路径](adr/0001-deck-identity-independent-from-file-path.md)
- [编辑历史采用线性游标与补偿修改](adr/0002-linear-edit-timeline-and-compensation.md)
- [Agent 执行批次冻结成员并与下一批候选分离](adr/0003-agent-execution-batches-freeze-membership.md)
- [ADR-0004：Deck 工作项显式关联 DSH 会话，Editor Workbench 跨会话常驻](adr/0004-explicit-dsh-session-links-and-persistent-workbench.md)
- [ADR-0005：AICO 配套安装与旧历史导入](adr/0005-aico-installation-and-history-import.md)
- [ADR-0007：插件私有运行时](adr/0007-plugin-private-runtime.md)
- [对话补充保留反馈任务身份，独立修改显式分离](adr/0008-feedback-followup-intent.md)
- [ADR-0009：DSH 插件与 AICO-PPT Skill 的边界](adr/0009-dsh-plugin-skill-seam.md)
- [ADR-0010：DSH 是正式窗口壳，独立 Editor 降级为 Dev Shell](adr/0010-dsh-primary-and-standalone-dev-shell.md)
- [任职与项目评审通用模板验证](design/business-template-validation.md)
- [从一句「我要答辩」到 28 页华为红答辩 deck —— 一次 AI 全程陪跑实录](showcase/showcase-1.md)
- [快捷键](user-guide/shortcuts.md)

## 维护规则

日常操作写入当前指南，架构与接口写入相应契约；不为每次小修复新增一份安装／版本说明。发布变化汇总到 `releases.md`，精确包摘要、测试范围和原始失败放在 `verification/`。研究资料写明日期与适用基线。

已完成阶段计划、被替代设计与重复快照，在合并仍有效约束和未完成要求后直接删除，不建立文档归档。来源、许可证、版本决策、数据迁移规则和验证证据保留。整理文档不代表重新执行原装 Desktop／本机与 WSL 的全系统验收。
