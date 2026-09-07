# ADR-0006：桌面发行通过环境接口提供运行能力

状态：已实现。插件私有运行时的配置与隔离由 [ADR-0007](0007-plugin-private-runtime.md) 定义。

## 背景

AICO-Harness 桌面 Host 与 PPT 分开发行。用户在插件商店安装 PPT 及其私有 Python、浏览器和 Office 后，无需另装这些系统工具，同时保留 PPT 作为独立 Skill 和 DSH 插件的职责。

## 决策

桌面窗口、Host 安装器、插件目录与归档下载由 AICO-Harness 管理；PPT 接受显式运行时描述并拥有 Editor Worker 生命周期。PPT 不导入 Electron、不访问桌面资源布局，继续复用 Editor Core、Managed Workspace 和 DSH 插件协议。

| 环境变量 | 含义 |
| --- | --- |
| `AICO_RUNTIME_KIND=desktop` | 诊断仅报告内置能力，拒绝修改包内依赖的自动修复，不检查独立 Skill 注册或 Dev Shell |
| `PYTHON` | PPT 插件准备产物中的私有 Python 可执行文件 |
| `AICO_BROWSER_EXECUTABLE` | 截图、逐拍验证、溢出检测、托管 headless runtime 和导出共用的 Chromium 可执行文件 |
| `AICO_SOFFICE_EXECUTABLE` | 文档解析使用的 LibreOffice 可执行文件 |
| `AICO_DESKTOP_DIALOG_URL` / `AICO_DESKTOP_DIALOG_TOKEN` | 后台调用桌面原生文件/目录对话框的私有地址和认证令牌，不下发到网页 |

显式浏览器路径不使用系统 Chrome 回退；显式 LibreOffice 路径优先于系统查找。未提供桌面配置时，独立 Skill 的浏览器和 Python 文件选择机制保持原有行为。这些工具变量只在 PPT 私有 Worker 及 `runtime-run.mjs` 脚本包装器中设置，Host 全局 PATH 不加入插件 Python、浏览器或 Office。模型脚本通过包装器读取同一 `.aico-runtime.json`，重建私有环境；Node 复用 Host 的 `process.execPath`。

原生文件选择请求只传入 `deck` 或 `directory`，返回用户选择的路径或取消结果。桌面端限制单个活动对话框；后端仍按已有路径和文件安全检查打开内容，原生对话框不扩大文件处理接口。

## 验证与影响

依赖诊断测试覆盖显式工具选择、缺失资源与桌面能力列表；文件选择测试覆盖认证请求和取消。浏览器启动参数统一由 `chromiumLaunchOptions` 提供，避免不同导出/验证入口选择不同浏览器。Harness 的 Host 安装器与插件发布验收分别验证宿主启动和安装后的实际工具、编辑、导出与生命周期。独立 Skill 的宿主安装、模板和项目数据格式保持独立。
