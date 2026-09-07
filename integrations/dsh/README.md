# DSH 插件集成

这里是 AICO-PPT 在 DeepSeek Harness（DSH）中的适配层，不是第二份 Skill，也不是第二套 Editor。普通用户安装 AICO-Harness 独立应用，再通过“设置 → 插件 → 插件商店”安装 AICO-PPT；正式步骤见[安装指南](../../INSTALL.md)。本文的 Web profile 与本地安装命令只用于开发调试。

插件把 DSH 原生对话与原 AICO-PPT Editor 并排组合：左边始终是当前 DSH 会话，右边是可缩放的通用 workbench；AICO-PPT 使用跨 Session 常驻的 `workbench.persistent-view`。Editor 的页面栏、画布、属性栏、区域任务、时间线、固化和导出全部继续运行仓库内原有实现。

| 文件 | 所属平面 | 责任 |
|---|---|---|
| `index.mjs` | Plugin Host | 注册根目录唯一 `SKILL.md`；按 `aicoRuntime` 配置选择私有 Worker 或源码 Editor；向 Client 注入带随机令牌的入口 URL 和品牌资源 |
| `runtime-env.mjs` | 私有运行时 | 校验插件目录内的 Python / 浏览器 / Office，构造独立环境；Node 复用 Host 的可执行文件 |
| `runtime-host.mjs` / `runtime-worker.mjs` | Worker 生命周期 | 在独立环境中加载原 `startAppServer({ embeddedMode:'dsh' })`，报告实际 loopback URL，等待关闭并处理超时和崩溃 |
| `runtime-run.mjs` | 模型脚本入口 | 读取本包 `.aico-runtime.json`，用同一私有环境运行 `python3` 或 `node`；保留当前工作目录、标准输入和解释器参数 |
| `client.js` | Plugin Client | 在 `sidebar.footer.action` 注册 AICO-PPT 入口；在 `workbench.persistent-view` 注册 iframe 宿主；通过 `ctx.sessionStarts` 向 DSH 统一“新会话”入口发布一行 AICO-PPT 标签及其当前优先的确切 Deck 子菜单；提供 Workspace / Session 创建、打开、查询和精确发送命令 |
| `../../scripts/editor/public/deck-task-coordinator.mjs` | Editor Client | 用 `workId` 协调 WorkCatalog 持久关系与 DSH 原生 Workspace / Session 副作用；处理预分配身份与 pending 恢复 |
| `../../cordis.patch.yml` | Plugin Bundle | 安装时加入 Host/Client 插件行 |
| `brand-spec.md` | UI 设计源 | 记录 Logo、颜色、字体、间距、圆角、阴影与动效来源 |

## 使用逻辑

1. 用户从 DSH 左侧边栏底部、Settings 上方点击 `AICO-PPT`。
2. DSH 保留左侧原生对话，在右侧打开可拖动宽度的 workbench；再次点击关闭，切换 Session 不销毁 Editor iframe。
3. 如果已有活动 Deck，原 App Server 直接恢复该 Editor；否则显示原工作台的“新建 Deck / 修改 Deck”入口和最近任务。
4. 新建 Deck 先用系统目录选择器确定 `projectRoot`；修改 Deck 使用已确认或恢复的项目根。插件按规范目录幂等解析 DSH Workspace，再为工作项创建独立 Session。
5. DSH 左侧“新会话”是唯一入口。只要 WorkCatalog 中存在可用 Deck，菜单就显示一行 `AICO-PPT` 专属标签；右侧箭头打开项目子菜单，当前关联项目或最近项目位于首项，Editor 关闭或当前会话未关联也不会隐藏该入口。“新建普通会话”保留在页脚。每个项目选项显式携带自己的 `workId` 和绑定 revision key；选择项目后按需打开 workbench，先导航到目标页面，目标页面发布同一 key 后才创建，避免旧页面误接请求。已有 `workspaceId` 时直接复用持久关联，不重复等待远端 Workspace 创建。新 Session 在打开前写入“创建/修改 Deck：任务名”的持久中文标题，多会话追加“会话 2/3”序号，并预加载历史窗口；不能根据目录、标题或 `/aico-ppt` 文本猜测关联。
6. 打开已有 Deck 后进入原 Editor Runtime。预览、编辑、区域标记三种一级模式，以及页序、富文本、拖移、缩放、删除、属性、任务、撤销 / 重做、固化和 PPTX 导出均走原来的 Managed Workspace 与 frame bridge。
7. 区域任务点击“交给 Agent”时，Editor Server 在捕获执行批次时固定 `assignedSessionId`，生成带任务 ID、revision 和 CLI capability 的 `/aico-ppt` 提示词，并精确提交到该工作项的活动 DSH Session。后续切换页面或会话不会迁移在途批次。
8. 点击已关联 Session 会反向找到 `workId` 并切换对应 Editor 工作项；Editor 已关闭时会先重新打开 workbench，Editor 已经显示 AICO-PPT 时重复事件不会再次调用打开或重载 iframe。点击普通 Session 会自动收起 AICO-PPT Workbench，但不改变任何工作项，也不会把后续请求误投到普通 Session。
9. Creation 发布出 Deck 后，同一 Work Item 原位转为 Editing，不产生重复任务卡；项目根不变时保留 `workId`、Workspace 和全部 Session Link，显式换根时历史化旧 Link 并清空旧 Workspace 与活动指针。

项目子菜单根据当前 DSH Session 的持久 `workId` 关联为唯一的对应项显示“当前”徽标；普通会话不会标记任何项目。

## UI 边界

- DSH 拥有：左侧会话、模型选择、审批、计划、消息记录、右 workbench 几何和插件入口。
- AICO-PPT Editor 拥有：顶栏、页序、三种模式、16:9 画布、顶部属性栏、右下角悬浮任务 drawer、Managed Workspace、动作历史、固化和导出。
- Editor 顶部任务会话控件只展示和切换关联会话，不再放第二个创建按钮；修改页在同一区域显示当前 Deck HTML 文件名，完整路径放在悬停说明中。新任务会话统一从 DSH 左侧入口创建。
- DSH 嵌入态不导入或实例化 Agent Terminal，不下发 xterm 资源，不自动启动 `node-pty`，也不连接 `/agent-terminal`；顶栏不再保留重复的机器人 / Agent 入口，执行状态由左侧 DSH 会话与右下任务 drawer 表达。
- WorkCatalog 是 Work Item ↔ Session Link 的唯一权威；DSH 仍是 Workspace、Session 和对话内容的唯一权威。一个 Session 最多关联一个 Work Item，一个 Work Item 可关联多个 Session，但同时只有一个活动 Session。
- WorkCatalog 先写入带预分配 Session 身份的 pending operation，再调用 DSH 创建 Session；响应丢失时重试采用同一身份。`complete-session` 只固化 Link，目标 Session 在 DSH 打开成功后才通过 `activate-session` 切换活动指针；打开失败保留原活动会话。
- Session 创建与打开命令同时携带不超过 DSH 80 字节上限的稳定中文标题；pending 恢复或旧 Link 激活只为尚未命名的 Session 补名，不覆盖用户或 DSH 已经持久化的标题。打开命令非阻塞预加载 Session history window，并立即切换 DSH 当前选择；标题补写和历史连接都不能阻塞 Editor 导航。
- 属性栏在 DSH 嵌入态固定停靠于画布上方，避免占用画布横向空间；任务 drawer 保持原来的右下角悬浮位置。
- Client 只嵌入原 App/Editor 页面，不复制 Editor DOM、业务状态或事务代码。
- 会话提示词单独限制为非空白文本、最多 262144 个 UTF-16 代码单元，以容纳安装目录与页面规划；会话、路径及标题等字段仍保留原有限制。

## 应用内插件运行时

AICO-Harness 桌面安装器只安装 Host。用户从设置中的插件目录安装 AICO-PPT 后，插件管理器负责下载与校验本包及 Python、浏览器、Office，准备成功后再注册现有 Web profile；卸载只移除插件注册与可回收发行文件，项目和用户数据保持原位。独立 Skill 与源码安装不要求桌面运行时描述文件。

桌面管理器调用 `apply(ctx, { aicoRuntime:{ root, paths:{ python, browser, office } } })`。`root` 是当前插件发行目录，三个工具路径均为存在的绝对文件路径；跟随软链接后的实际文件必须位于该目录内。描述对象只接受这些字段，不接受凭据或任意环境变量。管理器将同一个 `aicoRuntime` 对象写入插件包根目录的 `.aico-runtime.json`，供模型脚本包装器读取。Node 始终使用 `process.execPath`，不在 PPT 插件内安装第二份 Node。

Host 在创建 Worker 时传入独立环境，Worker 收到环境后才导入 Editor 模块，并显式传入 `pythonExecutable`。私有 PATH 包含声明的工具、Host Node 和基本系统工具目录；继承的 Python / Node / Playwright 运行时覆盖与凭据变量被移除。`AICO_HOME`、`AICO_PPT_EDITOR_STATE_ROOT`、项目 sidecar 和工作副本仍由现有状态解析器管理，插件不修改全局 `process.env`。没有 `aicoRuntime` 时，`apply(ctx)` 沿用源码 Editor 行为。

只有配置桌面运行时的 Skill 定义会在规范正文后追加包装器说明，磁盘上的 `SKILL.md` 不变。包装器允许 `python3` / `node` 的普通参数、`-m` / `-c` / `-e`、stdin 和项目脚本；它只选择环境，命令审批与沙箱仍归 Harness。调用保持原工作目录，文档中的 `scripts/` 相对路径须解析到本 Skill 根目录，输出继续指向用户项目。

启动失败直接拒绝插件激活；启动后的 Worker 崩溃写入 Host 日志，并使后续页面注入报告失败。移除插件时先请求 `app.close()`，随后等待 Worker 退出；超过 15 秒仍未退出时，等待强制终止完成并报告关闭超时。启动超过 30 秒也会终止并拒绝激活。

### 源码联调（仅开发）

配套 Harness 网页启动器位于其 `tools/dev-web/`，默认使用 `~/.aico-harness-dev-web`，与正式 AICO 应用数据隔离。源码配套安装和启动命令统一见[开发调试说明](../../INSTALL.md#开发调试)。

需要单独验证 DSH 的本地插件安装协议时，从本仓库根目录执行；为此次调试显式指定独立 `DSH_HOME`：

```bash
DSH_HOME="$HOME/.aico-ppt-dsh-dev" dsh plugin --profile web add .
```

这是不带桌面运行时配置的高级源码测试。安装后重新构建，并使用同一开发 `DSH_HOME` 重启 `web` profile；当前 `package.json` 保留 `private: true`，不代表已经发布到公共 registry。

当前适配只支持浏览器与 Editor 都位于同一台机器的 loopback DSH Web；Editor 服务不会暴露到局域网。

DSH 运行时对应 `editor-core` 依赖 Profile；它不因本机缺少 Agent CLI、`node-pty` 或 xterm 而失败。原桌面入口对应 `dev-shell` Profile，仅供开发、回归和故障排查。两者的定位决策见 `../../docs/adr/0002-dsh-primary-and-standalone-dev-shell.md`；Work Item / Workspace / Session 关系见 `../../docs/adr/0004-explicit-dsh-session-links-and-persistent-workbench.md`。

## 验证

```bash
npm run test:dsh-plugin
node --test scripts/editor/test/dsh-embedded-renzhi.e2e.mjs
```

第二条测试复制 `Deck-Projects/renzhi/renzhi-deck.html` 到临时目录，验证 21 页加载、三种模式、顶部属性栏、原任务 drawer、任务转交、历史、固化和导出，并确认源文件字节没有变化。

`test:dsh-plugin` 同时验证源码回退、桌面 Skill 追加说明、实际 Worker HTTP 启停、私有环境诊断、异常退出、关闭超时、模型 Node 参数和 Python stdin。运行时描述与子进程夹具全部位于测试独占临时目录；测试不会写入用户插件描述文件。设计决策见 [ADR-0007](../../docs/adr/0007-plugin-private-runtime.md)。

桌面文件与目录选择能力通过 Host 到 Worker 的私有启动参数传递，仅注入系统选择器回调；地址与认证令牌不进入 Worker 通用环境、模型脚本或运行时描述文件。启动时验证通道必须是带认证信息的本机 `/pick` 地址。真实 Worker 到 Electron 对话框桥的回归覆盖 HTML 选择和创建项目目录选择，同时保留无令牌及带浏览器 Origin 请求的拒绝检查。

Creation CLI 每次通过 `--capability-file` 读取 Draft 的本机服务 URL 与凭据；恢复 Draft 时以 0600 权限更新同一路径的动态端口与凭据，无需把秘密写入会话提示或 Host 环境。
