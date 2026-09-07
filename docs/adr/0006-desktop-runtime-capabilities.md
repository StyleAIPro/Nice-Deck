# ADR-0006：桌面发行通过环境接口提供运行能力

状态：已实现。插件私有运行时的配置与隔离由 [ADR-0007](0007-plugin-private-runtime.md) 定义。

## 背景

AICO-Harness 桌面 Host 与 PPT 分开发行。用户在插件商店安装 PPT 及其私有 Python 后，通过 Host 已有的 Electron 完成截图与验证，无需另装浏览器，同时保留 PPT 作为独立 Skill 和 DSH 插件的职责。

## 决策

桌面窗口、Host 安装器、插件目录与归档下载由 AICO-Harness 管理；PPT 接受显式运行时描述并拥有 Editor Worker 生命周期。PPT 不导入 Electron、不访问桌面资源布局，继续复用 Editor Core、Managed Workspace 和 DSH 插件协议。

| 环境变量 | 含义 |
| --- | --- |
| `AICO_RUNTIME_KIND=desktop` | 诊断仅报告内置能力，拒绝修改包内依赖的自动修复，不检查独立 Skill 注册或 Dev Shell |
| `PYTHON` | PPT 插件准备产物中的私有 Python 可执行文件 |
| `AICO_HOME` | 私有 `desktop-renderer.json` 能力文件所在目录；截图、逐拍验证、溢出检测、托管 headless runtime 和导出共用 Host 的 Electron 服务 |
| `PYTHONDONTWRITEBYTECODE=1` | 桌面 Worker 和脚本包装器不在私有 Python 目录生成字节码缓存 |

桌面渲染服务通过认证的回环 TCP 连接管理隐藏沙箱页面，连接关闭即释放页面；能力文件不进入插件归档或网页配置。新发布声明 `apiVersion: 2` 与 `requires: {desktopRenderer: 1}`，缺少兼容 Host 能力时不能使用桌面渲染，也不回退系统 Chrome。独立 Skill 保留 Playwright 与本机 Chrome。这些工具变量只在 PPT 私有 Worker 及 `runtime-run.mjs` 脚本包装器中设置，Host 全局 PATH 不加入插件 Python。模型脚本通过包装器读取同一 `.aico-runtime.json`，重建私有环境；Node 复用 Host 的 `process.execPath`。

原生文件选择请求只传入 `deck` 或 `directory`，返回用户选择的路径或取消结果。桌面端限制单个活动对话框；后端仍按已有路径和文件安全检查打开内容，原生对话框不扩大文件处理接口。

参考 PPTX 仅用标准库提取标题、正文、备注、表格与原始内嵌图片，供 AI 直接阅读，不提供 PPTX 渲染或转 PDF 能力。`pptx-read` 只检查随包提取工具；PPTX 截图组装也只用标准库，可选 HTML 附件图标使用 Pillow。`materials` 只检查 PyMuPDF 与 pypdf，前者负责普通 PDF 操作，后者负责 AcroForm 字段填写；运行时不再设置 `AICO_SOFFICE_EXECUTABLE`，仍过滤继承的同名变量。

## 验证与影响

依赖诊断测试覆盖显式工具选择、缺失资源与桌面能力列表；文件选择测试覆盖认证请求和取消。`loadChromium` 在桌面选择 Host 渲染服务，在独立环境选择 Playwright；`chromiumLaunchOptions` 保持各导出和验证入口一致。Harness 的 Host 安装器与插件发布验收分别验证宿主启动和安装后的实际工具、编辑、导出与生命周期。独立 Skill 的宿主安装、模板和项目数据格式保持独立。
