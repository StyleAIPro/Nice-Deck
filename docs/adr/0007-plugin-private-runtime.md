# ADR-0007：插件目录安装与 PPT 私有运行时

状态：已实现。

用户选择将 AICO-Harness 与 AICO-PPT 分开发行。Host 安装器不包含 PPT 模板或 Python / 浏览器 / Office；桌面插件管理器下载并校验本插件的准备产物，再通过既有 DSH Web profile 注册它。此决策替代完整应用首次启动时下载整套 PPT 运行时的方案。

PPT Host 入口接受显式 `aicoRuntime:{ root, paths:{ python, browser, office } }`。描述中只允许工具路径，实际文件经 realpath 校验后必须位于该插件发行根目录。管理器向插件包根目录写入相同 JSON 的 `.aico-runtime.json`；该文件不含凭据、用户配置或自定义环境。Node 复用 Host 的 `process.execPath`。

配置运行时时，原 Editor App Server 在受 Host 持有的 Worker 中启动。Worker 环境在导入任何 Editor 模块前固定，防止模块级 Python 默认值串用 Host 或其他插件的运行时。环境移除继承的工具覆盖与凭据变量，并设置私有 Python / PATH / 浏览器 / Office；现有 AICO 和 PPT 数据目录保持不变。源码 `apply(ctx)` 仍直接启动原 App Server。

Worker 就绪后报告实际 loopback URL，Host 沿用原有 index-inject 提供 Editor 入口。启动与运行中异常分别拒绝激活或报告 Host 日志与注入错误。卸载请求先等待 `app.close()` 和 Worker 退出；15 秒关闭期限后强制终止 Worker 并等待完成，30 秒启动期限内无法就绪则拒绝激活。

模型读取的规范 Skill 仅在桌面配置存在时追加 `runtime-run.mjs` 调用说明。包装器读取相同描述并重建独立环境，允许 `python3` / `node` 的常规解释器参数、stdin 与项目脚本；执行权限由 Harness 的审批与沙箱管理，包装器不建立第二套脚本权限规则。工作目录、标准输入输出与脚本退出码保留，规范 `SKILL.md` 文件不作桌面专用改写。

验证覆盖真实 Editor HTTP 启动 / 关闭、私有诊断环境、路径逃逸和额外字段拒绝、Worker 崩溃与关闭失败、强制关闭完成、源码 Skill 回退，以及模型脚本的参数、stdin、目录和退出码。桌面完整浏览器渲染与 Office 导出由发行验收继续覆盖。

桌面文件与目录选择能力通过 Host 到 Worker 的私有启动参数传递，仅注入系统选择器回调；地址与认证令牌不进入 Worker 通用环境、模型脚本或运行时描述文件。启动时验证通道必须是带认证信息的本机 `/pick` 地址。真实 Worker 到 Electron 对话框桥的回归覆盖 HTML 选择和创建项目目录选择，同时保留无令牌及带浏览器 Origin 请求的拒绝检查。
