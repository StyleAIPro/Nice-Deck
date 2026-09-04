# DSH 插件集成

这里是 AICO-PPT 在 DeepSeek Harness（DSH）中的适配层，不是第二份 Skill，也不是第二套 Editor。

插件把 DSH 原生对话与原 AICO-PPT Editor 并排组合：左边始终是当前 DSH 会话，右边是可缩放的通用 workbench；AICO-PPT 使用跨 Session 常驻的 `workbench.persistent-view`。Editor 的页面栏、画布、属性栏、区域任务、时间线、固化和导出全部继续运行仓库内原有实现。

| 文件 | 所属平面 | 责任 |
|---|---|---|
| `index.mjs` | Plugin Host | 注册根目录唯一 `SKILL.md`；启动原 `startAppServer({ embeddedMode: 'dsh' })`；向 Client 注入带随机令牌的入口 URL 和品牌资源 |
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
9. Creation 发布出 Deck 后，同一 Work Item 原位转为 Editing，保留 `workId`、项目根、Workspace 和全部 Session Link，不产生重复任务卡。

项目子菜单根据当前 DSH Session 的持久 `workId` 关联为唯一的对应项显示“当前”徽标；普通会话不会标记任何项目。

## UI 边界

- DSH 拥有：左侧会话、模型选择、审批、计划、消息记录、右 workbench 几何和插件入口。
- AICO-PPT Editor 拥有：顶栏、页序、三种模式、16:9 画布、顶部属性栏、右下角悬浮任务 drawer、Managed Workspace、动作历史、固化和导出。
- Editor 顶部任务会话控件只展示和切换关联会话，不再放第二个创建按钮；修改页在同一区域显示当前 Deck HTML 文件名，完整路径放在悬停说明中。新任务会话统一从 DSH 左侧入口创建。
- DSH 嵌入态不导入或实例化 Agent Terminal，不下发 xterm 资源，不自动启动 `node-pty`，也不连接 `/agent-terminal`；顶栏不再保留重复的机器人 / Agent 入口，执行状态由左侧 DSH 会话与右下任务 drawer 表达。
- WorkCatalog 是 Work Item ↔ Session Link 的唯一权威；DSH 仍是 Workspace、Session 和对话内容的唯一权威。一个 Session 最多关联一个 Work Item，一个 Work Item 可关联多个 Session，但同时只有一个活动 Session。
- WorkCatalog 先写入带预分配 Session 身份的 pending operation，再调用 DSH 创建 Session；响应丢失时重试采用同一身份，完成关联后才打开会话。
- Session 创建与打开命令同时携带不超过 DSH 80 字节上限的稳定中文标题；pending 恢复或旧 Link 激活只为尚未命名的 Session 补名，不覆盖用户或 DSH 已经持久化的标题。打开命令非阻塞预加载 Session history window，并立即切换 DSH 当前选择；标题补写和历史连接都不能阻塞 Editor 导航。
- 属性栏在 DSH 嵌入态固定停靠于画布上方，避免占用画布横向空间；任务 drawer 保持原来的右下角悬浮位置。
- Client 只嵌入原 App/Editor 页面，不复制 Editor DOM、业务状态或事务代码。

## 本地安装

从本仓库根目录执行：

```bash
dsh plugin --profile web add .
```

安装后重新构建并重启 `web` profile。当前 `package.json` 保留 `private: true`，所以这是本地开发安装，不代表已经发布到公共 registry。

当前适配只支持浏览器与 Editor 都位于同一台机器的 loopback DSH Web；Editor 服务不会暴露到局域网。

DSH 运行时对应 `editor-core` 依赖 Profile；它不因本机缺少 Agent CLI、`node-pty` 或 xterm 而失败。原桌面入口对应 `dev-shell` Profile，仅供开发、回归和故障排查。两者的定位决策见 `../../docs/adr/0002-dsh-primary-and-standalone-dev-shell.md`；Work Item / Workspace / Session 关系见 `../../docs/adr/0004-explicit-dsh-session-links-and-persistent-workbench.md`。

## 验证

```bash
npm run test:dsh-plugin
node --test scripts/editor/test/dsh-embedded-renzhi.e2e.mjs
```

第二条测试复制 `Deck-Projects/renzhi/renzhi-deck.html` 到临时目录，验证 21 页加载、三种模式、顶部属性栏、原任务 drawer、任务转交、历史、固化和导出，并确认源文件字节没有变化。
