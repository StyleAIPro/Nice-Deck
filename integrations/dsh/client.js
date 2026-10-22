window.__ModuleLoader__.load({
  id: "aico-ppt-skill",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    const React = require("react");
    const h = React.createElement;

    // 此提示独立于 Harness 服务，使用原装只读清单，不执行安装或启用。
    function harnessVersionSupported(version) {
      const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(version || '');
      if (!match) return null;
      const [, major, minor, patch, pre] = match;
      if (Number(major) !== 2) return false;
      if (Number(minor) > 0 || Number(patch) > 0 || !pre) return true;
      const minimum = ['dev', '75'], parts = pre.split('.');
      for (let index = 0; index < Math.max(parts.length, minimum.length); index++) {
        if (parts[index] === undefined) return false;
        if (minimum[index] === undefined) return true;
        if (parts[index] === minimum[index]) continue;
        const a = parts[index], b = minimum[index], an = /^\d+$/.test(a), bn = /^\d+$/.test(b);
        return an && bn ? Number(a) > Number(b) : an !== bn ? !an : a > b;
      }
      return true;
    }
    async function readHarnessDependency(ctx, signal) {
      const manager = ctx.get?.('remote')?.pluginManager;
      if (!manager?.listBundles) return { state: 'unknown' };
      let timer;
      try {
        const answer = await Promise.race([
          manager.listBundles(signal),
          new Promise((_, reject) => { timer = setTimeout(() => reject(Error('依赖状态读取超时')), 5000); }),
        ]);
        if (signal?.aborted) return { state: 'unknown' };
        if (!answer?.ok || !Array.isArray(answer.value)) return { state: 'unknown' };
        const row = answer.value.find(item => item.name === 'aico-harness');
        if (!row || row.installed === false) return { state: 'missing' };
        if (row.error) return { state: 'unavailable' };
        const compatible = harnessVersionSupported(row.version);
        if (compatible === false) return { state: 'incompatible', version: row.version };
        if (row.enabled === false) return { state: 'disabled', version: row.version };
        if (compatible === null) return { state: 'unknown' };
        return { state: ['workbench', 'sessionStarts', 'aicoHarnessClient'].every(name => ctx.get(name)) ? 'ready' : 'unavailable', version: row.version };
      } catch { return { state: 'unknown' }; }
      finally { clearTimeout(timer); }
    }
    function HarnessDependencyNotice({ ctx, label }) {
      const [status, setStatus] = React.useState({ state: 'checking' });
      const [revision, setRevision] = React.useState(0);
      React.useEffect(() => {
        const controller = new AbortController();
        let timer;
        const refresh = async () => {
          const value = await readHarnessDependency(ctx, controller.signal);
          if (controller.signal.aborted) return;
          setStatus(value);
          timer = setTimeout(refresh, 5000);
        };
        void refresh();
        return () => { controller.abort(); clearTimeout(timer); };
      }, [ctx, revision]);
      const messages = {
        checking: '正在检查 AICO-Harness 依赖状态…',
        missing: '未安装 AICO-Harness。请先在“插件 → 添加插件”中安装兼容的 Harness 包，再开启它的开关。',
        disabled: 'AICO-Harness 已安装，但尚未启用。请在“插件”页开启 aico-harness 的开关。',
        incompatible: 'AICO-Harness 版本不兼容。请安装与本业务插件配套的 Harness 版本（>=2.0.0-dev.75 且 <3.0.0）。',
        unavailable: 'AICO-Harness 的运行服务尚未就绪。请检查“插件”页的启用状态和错误提示，按提示完整退出并重开桌面。',
        unknown: '暂时无法确认 AICO-Harness 的安装状态。请在“插件”页核对是否安装、启用且版本兼容，然后刷新；不要重复安装。',
        ready: 'AICO-Harness 已就绪。如业务入口仍未恢复，请保存工作并完整退出、重新打开桌面。',
      };
      return h('section', { 'data-aico-dependency': '', style: { padding: 24, lineHeight: 1.6 } },
        h('h2', null, label + ' 依赖检查'),
        h('p', { role: status.state === 'ready' || status.state === 'checking' ? 'status' : 'alert' }, messages[status.state]),
        status.version && h('p', null, '已安装 Harness：' + status.version),
        h('p', null, '依赖恢复前业务入口暂停，已有业务文件与历史记录保留。安装顺序：Harness → 启用 Harness → 业务插件。'),
        h('p', null, '卸载时请先卸载所有 AICO 业务插件，再卸载 Harness；已停用但仍安装的业务插件也需要先卸载。官方管理器可能不会阻止直接卸载 Harness。'),
        h('button', { type: 'button', onClick: () => setRevision(value => value + 1) }, '刷新依赖状态'));
    }

    let brand = globalThis.__AICO_PPT_BRAND__;
    let selectedAppUrl;
    const runtimeAppUrl = () => selectedAppUrl ?? brand?.appUrl;
    const optimisticSessionTitles = new Map();
    const sessionTitleWrites = new Map();

    const STYLE_ID = "aico-ppt-dsh-style";
    const STYLE = `
.hwd-workbench{position:relative;width:100%;height:100%;min-width:0;min-height:0;overflow:hidden;border-left:1px solid color-mix(in srgb,currentColor 12%,transparent);background:#eef0f3}
.hwd-workbench-frame{display:block;width:100%;height:100%;border:0;background:#eef0f3}
.hwd-workbench-error{position:absolute;inset:0;z-index:2;display:grid;place-items:center;padding:32px;background:#eef0f3;color:#5f6268;font:13px/1.7 "Noto Sans SC","Microsoft YaHei",sans-serif;text-align:center}
.hwd-workbench-toast{position:absolute;z-index:3;top:12px;left:50%;max-width:min(560px,calc(100% - 32px));padding:9px 12px;border:1px solid color-mix(in srgb,#c7000b 22%,transparent);border-radius:9px;background:color-mix(in srgb,#fff 94%,transparent);box-shadow:0 8px 28px rgba(20,22,28,.14);color:#8f0008;font:12px/1.5 "Noto Sans SC","Microsoft YaHei",sans-serif;transform:translateX(-50%);pointer-events:none}
.hwd-sidebar-action{display:flex;width:100%;height:36px;align-items:center;gap:10px;padding:0 10px;border:0;border-radius:8px;background:transparent;color:inherit;font:inherit;cursor:pointer;transition:background-color 150ms ease,color 150ms ease}
.hwd-sidebar-action:hover{background:color-mix(in srgb,currentColor 8%,transparent)}
.hwd-sidebar-action:focus-visible{outline:2px solid color-mix(in srgb,#c7000b 42%,transparent);outline-offset:1px}
.hwd-sidebar-action[data-wide=false]{width:36px;justify-content:center;padding:0}
.hwd-sidebar-icon{display:grid;width:18px;height:18px;flex:0 0 18px;place-items:center;color:#c7000b}
.hwd-sidebar-icon svg{display:block;width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}
.hwd-sidebar-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
@media(prefers-reduced-motion:reduce){.hwd-sidebar-action{transition:none}}
`;

    function embeddedEditorUrl() {
      if (typeof runtimeAppUrl() !== "string") return null;
      try {
        const url = new URL(runtimeAppUrl());
        url.searchParams.set("embedded", "dsh");
        url.searchParams.set("parentOrigin", window.location.origin);
        return url.href;
      } catch (_error) {
        return null;
      }
    }

    function registeredLocalOrigin(value) {
      try {
        const url = new URL(value);
        if (url.protocol !== "http:"
          || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) return null;
        return url.origin;
      } catch (_error) {
        return null;
      }
    }

    function appCommandUrl(pathname) {
      if (typeof runtimeAppUrl() !== "string") return null;
      try {
        const appUrl = new URL(runtimeAppUrl());
        const token = appUrl.searchParams.get("token");
        if (!token) return null;
        const endpoint = new URL(pathname, appUrl);
        endpoint.searchParams.set("token", token);
        return endpoint.href;
      } catch (_error) {
        return null;
      }
    }

    async function resolveDshSession(sessionId, includeRemoved = false) {
      const endpoint = appCommandUrl("/api/dsh-work-items/resolve-session");
      if (endpoint === null) return { status:"unlinked", workItem:null };
      const response = await fetch(endpoint, {
        method:"POST",
        // text/plain 保持简单跨源请求；App Server 只对带令牌的本地 DSH Origin
        // 开放这一条只读解析命令，不扩大其他写接口的 Origin 边界。
        headers:{ "content-type":"text/plain;charset=UTF-8" },
        body:JSON.stringify({ sessionId, includeRemoved }),
      });
      if (!response.ok) throw new Error(`工作项关联查询失败：HTTP ${response.status}`);
      return response.json();
    }

    function requireBridgeString(value, label) {
      if (typeof value !== "string" || value.length === 0 || value.length > 4096) {
        throw new Error(`${label} 无效`);
      }
      return value;
    }

    async function waitForWorkspaceReady(ctx) {
      const source = ctx.workspaces.list;
      if (source.getSnapshot()?.phase === "ready") return;
      await new Promise((resolve, reject) => {
        let unsubscribe = () => {};
        const timer = setTimeout(() => {
          unsubscribe();
          reject(Object.assign(new Error("工作区及归档状态仍在加载，请稍后重试"), { code:"WORKSPACE_NOT_READY" }));
        }, 30_000);
        const check = () => {
          if (source.getSnapshot()?.phase !== "ready") return;
          clearTimeout(timer);
          unsubscribe();
          resolve();
        };
        unsubscribe = source.subscribe(check);
        check();
      });
    }

    function archivedSessionIds(ctx) {
      const snapshot = ctx.workspaces?.list?.getSnapshot?.();
      if (snapshot?.phase !== "ready") throw Object.assign(new Error("工作区及归档状态尚未就绪"), { code:"WORKSPACE_NOT_READY" });
      return new Set(snapshot.archivedSessionIds);
    }

    function sessionSummary(ctx, sessionId) {
      if (ctx.workspaces.list.getSnapshot()?.phase !== "ready") return undefined;
      if (typeof sessionId !== "string") return null;
      const row = ctx.sessions.list.getSnapshot().byId?.[sessionId];
      const persistentTitle = typeof row?.title === "string"
        && row.title
        && row.title !== sessionId
        ? row.title
        : null;
      const displayTitle = typeof row?.displayTitle === "string"
        && row.displayTitle
        && row.displayTitle !== sessionId
        ? row.displayTitle
        : null;
      return {
        sessionId,
        title:persistentTitle
          || optimisticSessionTitles.get(sessionId)
          || displayTitle
          || sessionId,
        cwd:row?.cwd || null,
        running:Boolean(row?.running),
        archived:archivedSessionIds(ctx).has(sessionId),
      };
    }

    async function usingSession(ctx, sessionId, operation) {
      if (typeof ctx.sessions.using === "function") {
        return ctx.sessions.using(sessionId, { source:"controllerOperation" }, reference => operation(reference.binding));
      }
      const binding = ctx.sessions.binding(sessionId);
      if (!binding) throw new Error(`DSH 会话不可用：${sessionId}`);
      return operation(binding);
    }

    async function ensureSessionTitle(ctx, sessionId, title) {
      title = requireBridgeString(title, "title");
      const row = ctx.sessions.list.getSnapshot().byId?.[sessionId];
      if (typeof row?.title === "string" && row.title && row.title !== sessionId) return;
      return usingSession(ctx, sessionId, async ({ session }) => {
      if (!session || typeof session.rename !== "function") {
        throw new Error(`DSH 会话不可命名：${sessionId}`);
      }
      const renamed = await session.rename(title);
      if (!renamed?.ok) {
        const code = renamed?.error?.code ? `${renamed.error.code}: ` : "";
        throw new Error(`DSH 会话命名失败：${code}${renamed?.error?.message || sessionId}`);
      }
      });
    }

    function scheduleSessionTitle(ctx, sessionId, title) {
      title = requireBridgeString(title, "title");
      const row = ctx.sessions.list.getSnapshot().byId?.[sessionId];
      if (typeof row?.title === "string" && row.title && row.title !== sessionId) return;
      optimisticSessionTitles.set(sessionId, title);
      const current = sessionTitleWrites.get(sessionId);
      if (current?.title === title) return;
      const write = ensureSessionTitle(ctx, sessionId, title).catch(error => {
        if (optimisticSessionTitles.get(sessionId) === title) {
          optimisticSessionTitles.delete(sessionId);
        }
        console.warn(`DSH 会话中文标题补写失败：${sessionId}`, error);
      }).finally(() => {
        if (sessionTitleWrites.get(sessionId)?.write === write) {
          sessionTitleWrites.delete(sessionId);
        }
      });
      sessionTitleWrites.set(sessionId, { title, write });
    }

    function prepareSession(ctx, sessionId) {
      const session = ctx.sessions.binding(sessionId)?.session;
      if (!session || typeof session.open !== "function") {
        throw new Error(`DSH 会话不可打开：${sessionId}`);
      }
      // DSH 自己的 session follower 也以非阻塞方式启动 history window。
      // 打开中的流可能长期等待远端连接，不能让它阻塞 Session 选中和 Editor 导航。
      const opening = session.open();
      void Promise.resolve(opening).catch(error => {
        console.warn(`DSH 会话历史流打开失败：${sessionId}`, error);
      });
    }

    function sendToSession(ctx, sessionId, prompt) {
      requireBridgeString(sessionId, "sessionId");
      // 提示词含多个发行路径及页面规划，不适用标识符的 4096 字符限制。
      if (typeof prompt !== "string" || prompt.length > 256 * 1024 || !prompt.trim()) {
        throw new Error("prompt 无效");
      }
      return usingSession(ctx, sessionId, binding => {
      const conversation = binding.ctx.get("conversation");
      if (!conversation || typeof conversation.send !== "function") {
        throw new Error(`DSH 会话不可用：${sessionId}`);
      }
      return conversation.send(prompt);
      });
    }

    async function restoreLinkedSession(ctx, sessionId) {
      await waitForWorkspaceReady(ctx);
      const linked = await resolveDshSession(sessionId, true);
      const work = linked?.workItem;
      if (!work) return false;
      if (ctx.workspaces.projectSessionCapabilities?.restore === false) {
        throw Object.assign(new Error("当前原装宿主不支持恢复原会话；请恢复项目后新建会话"), { code:"PROJECT_RESTORE_UNSUPPORTED" });
      }
      if (work.lifecycle === "removing") throw new Error("项目正在移除，请先完成移除后恢复会话");
      const workspace = await ctx.workspaces.create({ path:work.projectRoot });
      const response = await fetch(appCommandUrl("/api/dsh-work-items/restore-session"), {
        method:"POST", headers:{ "content-type":"text/plain;charset=UTF-8" },
        body:JSON.stringify({ workId:work.workId, sessionId, workspaceId:workspace.workspaceId, expectedRevision:work.revision }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.message || "项目会话恢复尚未完成，请重试");
      await ctx.workspaces.projectSessions({
        operationId:result.workItem.restoreOperation.operationId,
        action:"restore", sessionIds:[sessionId], workspaceId:workspace.workspaceId,
      });
      const completed = await fetch(appCommandUrl("/api/dsh-work-items/complete-restore"), {
        method:"POST", headers:{ "content-type":"text/plain;charset=UTF-8" },
        body:JSON.stringify({ workId:work.workId, operationId:result.workItem.restoreOperation.operationId }),
      });
      if (!completed.ok) throw new Error("会话恢复收据尚未保存，请在项目首页重试恢复");
      return true;
    }

    function createDshWorkBridge(ctx) {
      return async (command, payload = {}) => {
        await waitForWorkspaceReady(ctx);
        switch (command) {
          case "current-session": {
            return sessionSummary(ctx, ctx.sessions.list.getSnapshot().current);
          }
          case "describe-sessions": {
            if (!Array.isArray(payload.sessionIds)) throw new Error("sessionIds 无效");
            const snapshot = ctx.sessions.list.getSnapshot();
            const archived = archivedSessionIds(ctx);
            return payload.sessionIds.map(sessionId => {
              sessionId = requireBridgeString(sessionId, "sessionId");
              return snapshot.byId?.[sessionId] || archived.has(sessionId)
                ? sessionSummary(ctx, sessionId) : null;
            });
          }
          case "restore-linked-session": {
            return restoreLinkedSession(ctx, requireBridgeString(payload.sessionId, "sessionId"));
          }
          case "project-sessions": {
            if (typeof ctx.workspaces.projectSessions !== "function") throw Object.assign(new Error("当前宿主尚不支持项目关联会话的批量归档与恢复；项目移除未完成，内容文件保留"), { code:"HOST_LIFECYCLE_UNAVAILABLE" });
            return ctx.workspaces.projectSessions(payload);
          }
          case "ensure-workspace": {
            const workspace = await ctx.workspaces.create({
              path:requireBridgeString(payload.path, "path"),
            });
            return {
              workspaceId:workspace.workspaceId,
              path:workspace.path,
              title:workspace.title,
            };
          }
          case "create-session": {
            const workspaceId = requireBridgeString(payload.workspaceId, "workspaceId");
            const sessionId = requireBridgeString(payload.sessionId, "sessionId");
            // 原装 create 只复用空白会话；恢复已发送消息的预留身份时必须读取原会话。
            if (typeof ctx.sessions.refresh === "function") await ctx.sessions.refresh();
            if (archivedSessionIds(ctx).has(sessionId)) {
              throw Object.assign(new Error("预留会话已归档，请明确恢复后重试"), { code:"DSH_SESSION_ARCHIVED" });
            }
            const existing = ctx.sessions.list.getSnapshot().byId?.[sessionId];
            if (existing) {
              const workspace = ctx.workspaces.list.getSnapshot().items?.find(row => row.workspaceId === workspaceId);
              if (!workspace?.sessionIds?.includes(sessionId)) {
                throw Object.assign(new Error("预留会话不属于此项目工作区，不能重新创建或串用"), { code:"DSH_SESSION_WORKSPACE_MISMATCH" });
              }
            }
            const createdId = existing ? sessionId : await ctx.sessions.create({ workspaceId, sessionId });
            if (createdId !== sessionId) {
              throw Object.assign(new Error("原装宿主返回了不同会话身份，项目关联尚未提交，请检查后恢复"), { code:"DSH_SESSION_ID_CHANGED", sessionId:createdId });
            }
            if (payload.title !== undefined) {
              scheduleSessionTitle(ctx, createdId, payload.title);
            }
            return sessionSummary(ctx, createdId) || { sessionId:createdId };
          }
          case "fork-session": {
            const sourceSessionId = requireBridgeString(payload.sourceSessionId, "sourceSessionId");
            const childId = await ctx.sessions.fork({
              sessionId:sourceSessionId,
              increaseTitle:true,
            });
            return sessionSummary(ctx, childId) || { sessionId:childId };
          }
          case "open-session": {
            const sessionId = requireBridgeString(payload.sessionId, "sessionId");
            if (archivedSessionIds(ctx).has(sessionId)) throw new Error("会话已归档，请从历史记录明确恢复");
            if (payload.title !== undefined) {
              scheduleSessionTitle(ctx, sessionId, payload.title);
            }
            await usingSession(ctx, sessionId, async () => {
              if (typeof ctx.sessions.using !== "function") prepareSession(ctx, sessionId);
              await ctx.sessions.open(sessionId);
            });
            return sessionSummary(ctx, sessionId) || { sessionId };
          }
          case "send-to-session": {
            const sessionId = requireBridgeString(payload.sessionId, "sessionId");
            await sendToSession(ctx, sessionId, payload.prompt);
            return { accepted:true, sessionId };
          }
          default:
            throw new Error(`不支持的 DSH Bridge 命令：${String(command)}`);
        }
      };
    }

    function projectName(projectRoot) {
      if (typeof projectRoot !== "string") return "未命名项目";
      const parts = projectRoot.split(/[\\/]+/).filter(Boolean);
      return parts.at(-1) || projectRoot;
    }

    function describeSessionStartTarget(workItem) {
      if (!workItem || typeof workItem !== "object"
        || typeof workItem.workId !== "string"
        || typeof workItem.projectRoot !== "string"
        || !["creation", "editing"].includes(workItem.kind)) return null;
      const revision = workItem.dshBinding?.revision ?? workItem.revision;
      if (!Number.isInteger(revision) || revision < 0) return null;
      const displayName = workItem.kind === "editing"
        ? (workItem.deckName || projectName(workItem.deckPath) || workItem.displayName || "未命名 Deck")
        : (workItem.displayName || workItem.title || "未命名 Deck");
      return {
        workId:workItem.workId,
        contextKey:`${workItem.workId}:${revision}`,
        kind:workItem.kind,
        displayName,
        projectRoot:workItem.projectRoot,
        projectName:workItem.projectName || projectName(workItem.projectRoot),
      };
    }

    function sessionStartTargetsFromHistory(history) {
      const seen = new Set();
      const targets = [];
      for (const workItem of [
        ...(Array.isArray(history?.creation) ? history.creation : []),
        ...(Array.isArray(history?.editing) ? history.editing : []),
      ]) {
        const target = describeSessionStartTarget(workItem);
        if (target === null || seen.has(target.workId)) continue;
        seen.add(target.workId);
        targets.push(target);
      }
      return targets;
    }

    let catalogFetchSequence = 0;
    async function fetchSessionStartTargets() {
      const fetchSequence = ++catalogFetchSequence;
      const endpoint = appCommandUrl("/api/work-history");
      if (endpoint === null) return [];
      const metadataEndpoint = new URL(endpoint);
      metadataEndpoint.searchParams.set("bindings", "metadata");
      const response = await fetch(metadataEndpoint.href, { headers:{ accept:"application/json" } });
      if (!response.ok) throw new Error(`AICO-PPT 项目列表读取失败：HTTP ${response.status}`);
      const targets = sessionStartTargetsFromHistory(await response.json());
      targets.fetchSequence = fetchSequence;
      return targets;
    }

    function createContextualSessionStart(openWorkbench) {
      let active = null;
      let snapshot = [];
      let targetByKey = new Map();
      let preferredWorkId = null;
      let currentWorkId = null;
      let sequence = 0;
      let appliedCatalogSequence = 0;
      const listeners = new Set();
      const pending = new Map();
      const source = {
        getSnapshot:() => snapshot,
        subscribe(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      };
      const publish = () => {
        for (const listener of listeners) listener();
      };
      const clear = (target) => {
        if (target && active?.target !== target) return;
        active = null;
      };
      const validContext = context => Boolean(context && typeof context === "object"
        && typeof context.workId === "string"
        && typeof context.contextKey === "string"
        && ["creation", "editing"].includes(context.kind));
      const replaceTargets = (targets) => {
        if (targets?.fetchSequence < appliedCatalogSequence) return;
        if (targets?.fetchSequence) appliedCatalogSequence = targets.fetchSequence;
        const ordered = [];
        const seen = new Set();
        for (const candidate of Array.isArray(targets) ? targets : []) {
          if (!validContext(candidate) || seen.has(candidate.workId)) continue;
          seen.add(candidate.workId);
          ordered.push(candidate);
        }
        const preferredIndex = ordered.findIndex(row => row.workId === preferredWorkId);
        if (preferredIndex > 0) ordered.unshift(ordered.splice(preferredIndex, 1)[0]);
        const next = ordered.map(row => ({
          key:row.contextKey,
          label:row.displayName || "未命名 Deck",
          description:row.projectName || projectName(row.projectRoot),
          current:row.workId === currentWorkId,
        }));
        targetByKey = new Map(ordered.map(row => [row.contextKey, row]));
        const unchanged = snapshot.length === next.length && snapshot.every((row, index) => (
          row.key === next[index]?.key
          && row.label === next[index]?.label
          && row.description === next[index]?.description
          && row.current === next[index]?.current
        ));
        if (unchanged) return;
        snapshot = next;
        publish();
      };
      const prefer = (workId) => {
        currentWorkId = typeof workId === "string" ? workId : null;
        preferredWorkId = currentWorkId;
        replaceTargets([...targetByKey.values()]);
      };
      const sendCreateRequest = (request, target, origin) => {
        if (request.createSent) return;
        request.createSent = true;
        target.postMessage({
          type:"aico-ppt:create-work-session-request",
          requestId:request.requestId,
          workId:request.context.workId,
          contextKey:request.context.contextKey,
        }, origin);
      };
      const route = (request) => {
        if (active === null) {
          openWorkbench();
          return;
        }
        if (validContext(active.context)
          && request.context.contextKey === active.context.contextKey
          && request.context.workId === active.context.workId) {
          sendCreateRequest(request, active.target, active.origin);
          return;
        }
        if (request.navigateSent) return;
        request.navigateSent = true;
        active.target.postMessage({
          type:"aico-ppt:navigate-work-session-target-request",
          requestId:request.requestId,
          workId:request.context.workId,
          contextKey:request.context.contextKey,
        }, active.origin);
      };
      const adopt = (context, target, origin, targets) => {
        if (targets?.fetchSequence < appliedCatalogSequence) return;
        if (context !== null && !validContext(context)) return;
        const ordered = [];
        const seen = new Set();
        for (const candidate of [
          ...(validContext(context) ? [context] : []),
          ...(Array.isArray(targets) ? targets : []),
        ]) {
          if (!validContext(candidate) || seen.has(candidate.workId)) continue;
          seen.add(candidate.workId);
          ordered.push(candidate);
        }
        active = { context, target, origin };
        if (validContext(context) && currentWorkId === null) preferredWorkId = context.workId;
        ordered.fetchSequence = targets?.fetchSequence;
        if (Array.isArray(targets) || ordered.length > 0) replaceTargets(ordered);
        for (const request of pending.values()) route(request);
      };
      const receive = (message) => {
        const request = pending.get(message.requestId);
        if (!request) return;
        pending.delete(message.requestId);
        clearTimeout(request.timer);
        if (message.ok === true) request.resolve(message.result);
        else request.reject(new Error(message.error?.message || "无法创建任务会话"));
      };
      const start = (option) => {
        const context = targetByKey.get(option.key);
        if (context === undefined || !snapshot.some(candidate => candidate.key === option.key)) {
          return Promise.reject(new Error("当前 Deck 已切换，请重新选择任务会话"));
        }
        const requestId = `aico-ppt-session-${Date.now()}-${++sequence}`;
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            pending.delete(requestId);
            reject(new Error("等待 AICO-PPT 创建任务会话超时"));
          }, 120000);
          const request = {
            requestId, context, resolve, reject, timer,
            createSent:false, navigateSent:false,
          };
          pending.set(requestId, request);
          route(request);
        });
      };
      const dispose = () => {
        clear();
        for (const request of pending.values()) {
          clearTimeout(request.timer);
          request.reject(new Error("AICO-PPT 工作台已关闭"));
        }
        pending.clear();
        targetByKey.clear();
        snapshot = [];
        listeners.clear();
      };
      return { source, adopt, clear, receive, refresh:replaceTargets, prefer, start, dispose };
    }

    function AicoPptWorkbench(props) {
      const frame = React.useRef(null);
      const lastPublishedSession = React.useRef(null);
      const allowedFrameOrigins = React.useRef(null);
      const activeFrameOrigin = React.useRef(null);
      const [error, setError] = React.useState("");
      const editorUrl = embeddedEditorUrl();
      const appOrigin = editorUrl === null ? null : new URL(editorUrl).origin;
      if (allowedFrameOrigins.current === null) {
        allowedFrameOrigins.current = new Set(appOrigin === null ? [] : [appOrigin]);
      }
      if (activeFrameOrigin.current === null) activeFrameOrigin.current = appOrigin;

      const publishCurrentSession = (force = false) => {
        const target = frame.current?.contentWindow;
        const targetOrigin = activeFrameOrigin.current;
        if (targetOrigin === null || !target) return;
        const session = props.currentSession();
        if (session === undefined) return;
        const signature = JSON.stringify(session);
        if (!force && signature === lastPublishedSession.current) return;
        target.postMessage({
          type:"aico-ppt:dsh-session-changed",
          session,
        }, targetOrigin);
        lastPublishedSession.current = signature;
      };

      React.useEffect(() => {
        if (appOrigin === null) return () => {};
        const publish = () => publishCurrentSession(false);
        const unsubscribers = [];
        if (props.sessionSource?.subscribe) {
          unsubscribers.push(props.sessionSource.subscribe(publish));
        }
        if (props.workspaceSource?.subscribe) {
          // 归档非当前会话时，current 摘要不会变化，但 Editor 仍需立刻刷新选择器。
          unsubscribers.push(props.workspaceSource.subscribe(() => publishCurrentSession(true)));
        }
        // 某些 DSH 页面布局切换时，current 已更新但 list 的订阅通知可能晚到或漏发。
        // 轮询只读取本地 snapshot，且仅在摘要变化时发一条消息，作为低成本可靠性兜底。
        const poll = setInterval(publish, 250);
        publishCurrentSession(true);
        return () => {
          clearInterval(poll);
          for (const unsubscribe of unsubscribers) unsubscribe();
          props.sessionStarter.clear(frame.current?.contentWindow);
        };
      }, [appOrigin, props.currentSession, props.sessionSource, props.sessionStarter, props.workspaceSource]);

      React.useEffect(() => {
        const onMessage = async (event) => {
          if (event.source !== frame.current?.contentWindow
            || !event.data || typeof event.data !== "object") return;
          if (event.data.type === "aico-ppt:dsh-frame-origin") {
            if (event.origin !== appOrigin) return;
            const origin = registeredLocalOrigin(event.data.origin);
            if (origin === null) return;
            allowedFrameOrigins.current.add(origin);
            activeFrameOrigin.current = origin;
            return;
          }
          if (!allowedFrameOrigins.current.has(event.origin)) return;
          activeFrameOrigin.current = event.origin;
          if (event.data.type === "aico-ppt:dsh-ready") {
            // iframe 可能晚于 workbench effect 安装消息监听器；ready 后强制重放当前会话。
            publishCurrentSession(true);
            return;
          }
          if (event.data.type === "aico-ppt:dsh-work-context") {
            await waitForWorkspaceReady({ workspaces:{ list:props.workspaceSource } });
            // iframe 的迟到上下文不是项目存在性的证据；以服务端目录为准。
            const targets = await fetchSessionStartTargets();
            const context = targets.find(target => target.workId === event.data.context?.workId) ?? null;
            props.sessionStarter.adopt(context, event.source, event.origin, targets);
            return;
          }
          if (event.data.type === "aico-ppt:create-work-session-result"
            && typeof event.data.requestId === "string") {
            props.sessionStarter.receive(event.data);
            return;
          }
          if (event.data.type === "aico-ppt:close-workbench") {
            props.closeWorkbench();
            return;
          }
          if (event.data.type === "aico-ppt:dsh-request"
            && typeof event.data.requestId === "string"
            && typeof event.data.command === "string") {
            try {
              const result = await props.executeDshCommand(event.data.command, event.data.payload);
              event.source.postMessage({
                type:"aico-ppt:dsh-result",
                requestId:event.data.requestId,
                ok:true,
                result,
              }, event.origin);
              setError("");
            } catch (cause) {
              const message = cause instanceof Error ? cause.message : String(cause);
              event.source.postMessage({
                type:"aico-ppt:dsh-result",
                requestId:event.data.requestId,
                ok:false,
                error:{ message, code:cause?.code || cause?.rpcError?.code },
              }, event.origin);
              setError(`DSH 操作失败：${message}`);
            }
            return;
          }
          if (event.data.type !== "aico-ppt:agent-request"
            || typeof event.data.requestId !== "string"
            || typeof event.data.prompt !== "string") return;
          let accepted = false;
          let message = "";
          try {
            if (typeof props.sendTask !== "function") throw new Error("当前没有可用的 DSH 会话");
            await props.sendTask(event.data.prompt, event.data.sessionId);
            accepted = true;
            setError("");
          } catch (cause) {
            message = cause instanceof Error ? cause.message : String(cause);
            setError(`任务提交失败：${message}`);
          }
          event.source.postMessage({
            type:"aico-ppt:agent-result",
            requestId:event.data.requestId,
            accepted,
            message,
          }, event.origin);
        };
        window.addEventListener("message", onMessage);
        return () => window.removeEventListener("message", onMessage);
      }, [appOrigin, props.closeWorkbench, props.executeDshCommand, props.sendTask, props.sessionStarter]);

      if (editorUrl === null) {
        return h("section", { className:"hwd-workbench" },
          h("div", { className:"hwd-workbench-error", role:"alert" }, brand?.error || "AICO-PPT Editor 运行时没有启动。请重启 DSH Desktop。"));
      }
      return h("section", { className:"hwd-workbench", "aria-label":"AICO-PPT Editor" },
        h("iframe", {
          ref:frame,
          className:"hwd-workbench-frame",
          src:editorUrl,
          title:"AICO-PPT Editor",
          onLoad:() => {
            props.sessionStarter.clear(frame.current?.contentWindow);
            publishCurrentSession(true);
          },
          allow:"clipboard-read *; clipboard-write *; fullscreen *",
          sandbox:"allow-scripts allow-same-origin allow-forms allow-modals allow-downloads allow-popups",
        }),
        error ? h("div", { className:"hwd-workbench-toast", role:"alert" }, error) : null);
    }

    function AicoPptLauncher(props) {
      return h("button", {
        type:"button",
        className:"hwd-sidebar-action",
        "data-wide":String(props.wide),
        "aria-label":"AICO-PPT",
        title:"AICO-PPT",
        onClick:props.toggleWorkbench,
      },
      h("span", { className:"hwd-sidebar-icon", "aria-hidden":"true" },
        h("svg", { viewBox:"0 0 24 24" },
          h("rect", { x:"3.5", y:"4.5", width:"17", height:"15", rx:"2.5" }),
          h("path", { d:"M7 15l3.2-3.2 2.4 2.4 2.4-2.4 2 2" }),
          h("path", { d:"M8 8.5h8" }))),
      props.wide ? h("span", { className:"hwd-sidebar-label" }, "AICO-PPT") : null);
    }

    const inject = ["remote", "remote.pluginManager", "slots", "sessions", "workspaces", "conversation", "uiSession", "uiWorkspace"];

    function apply(ctx) {
      let stopped = false, notice;
      const showNotice = () => {
        if (stopped || ctx.fiber?.state === 5 || ctx.fiber?.uid === null || notice) return;
        notice = ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section', id: 'aico-ppt-dependency', order: 54,
          label: () => 'AICO-PPT（待恢复）',
        }, () => h(HarnessDependencyNotice, { ctx, label: 'AICO-PPT' })));
      };
      ctx.effect(() => () => { stopped = true; notice?.(); notice = undefined; }, 'aico-ppt: 释放依赖提示');
      if (['workbench', 'sessionStarts', 'aicoHarnessClient'].some(name => !ctx.get(name))) showNotice();
      return ctx.inject(['workbench', 'sessionStarts', 'aicoHarnessClient'], owner => {
        const start = () => {
          notice?.(); notice = undefined;
          owner.effect(() => () => { if (['workbench', 'sessionStarts', 'aicoHarnessClient'].some(name => !ctx.get(name))) showNotice(); }, 'aico-ppt: 依赖缺失时显示恢复提示');
          return initialize(owner);
        };
        // 未提供清单接口的宿主保留现有服务注入行为。
        if (!ctx.get?.('remote')?.pluginManager?.listBundles) return start();
        const lifetime = new AbortController();
        owner.effect(() => () => lifetime.abort(), 'aico-ppt: 取消依赖检查');
        return readHarnessDependency(ctx, lifetime.signal).then(dependency => {
          if (lifetime.signal.aborted) return;
          if (['missing', 'disabled', 'incompatible', 'unavailable'].includes(dependency.state)) { showNotice(); return; }
          return start();
        });
      });
    }
    function initialize(ctx) {
      const refresh = ctx.get?.('aicoHarnessClient')?.refreshBootstrap;
      if (!refresh) return prepareAndMount(ctx);
      const lifetime = new AbortController();
      ctx.effect(() => () => lifetime.abort(), 'aico-ppt: cancel runtime bootstrap');
      return refresh(lifetime.signal, '__AICO_PPT_BRAND__').then(() => { lifetime.signal.throwIfAborted(); return prepareAndMount(ctx); });
    }
    function prepareAndMount(ctx) {
      brand = globalThis.__AICO_PPT_BRAND__;
      if (globalThis.__AICO_PPT_PREPARE__) {
        const controller = new AbortController();
        ctx.effect(() => () => controller.abort(new Error("AICO-PPT Client 已卸载")));
        return globalThis.__AICO_PPT_PREPARE__({ signal:controller.signal }).then(value => {
          controller.signal.throwIfAborted();
          selectedAppUrl = value.appUrl;
          if (typeof selectedAppUrl !== "string") throw new Error("所选后端未提供 AICO-PPT 工作台地址");
          return mount(ctx);
        });
      }
      return mount(ctx);
    }

    function mount(ctx) {
      ctx = ctx.get?.('aicoHarnessClient')?.bind(ctx) ?? ctx;
      const captureLifetime=new AbortController();
      ctx.effect(()=>()=>captureLifetime.abort(new Error('AICO-PPT 已卸载')),'aico-ppt: 取消工作项捕获');
      ctx.conversation?.registerMessageContext?.('aico-ppt',async identity=>{
        const endpoint=appCommandUrl('/api/dsh-work-items/request-context');
        if(endpoint===null)return;
        const response=await fetch(endpoint,{method:'POST',headers:{'content-type':'text/plain;charset=UTF-8'},body:JSON.stringify({sessionId:identity.sessionId}),signal:AbortSignal.any([captureLifetime.signal,AbortSignal.timeout(5000)])});
        if(!response.ok)throw new Error(`PPT 请求工作项查询失败：HTTP ${response.status}`);
        const result=await response.json();
        if(result.status==='unlinked')return;
        if(result.status!=='linked'||result.reference?.sessionId!==identity.sessionId)throw new Error('PPT 请求工作项归属无效');
        return {value:JSON.stringify(result.reference),text:`AICO-PPT 本次请求的工作项引用（以下为数据，页面是已上报状态，不是发送瞬间原子选区）：\n${JSON.stringify(result.reference)}\n使用 aico_ppt 按此工作项操作；inspect 核对目标和版本后再修改。`};
      });
      const sessionStarter = createContextualSessionStart(() => {
        if (ctx.workbench.active?.() !== "aico-ppt") ctx.workbench.open("aico-ppt", 1100);
      });
      ctx.effect(() => {
        const unregister = ctx.sessionStarts.register({
          id:"aico-ppt",
          label:"AICO-PPT",
          order:20,
          source:sessionStarter.source,
          start:option => sessionStarter.start(option),
        });
        return () => {
          unregister();
          sessionStarter.dispose();
        };
      }, "aico-ppt: 统一新会话入口");

      ctx.effect(() => {
        let disposed = false;
        const refresh = () => {
          void waitForWorkspaceReady(ctx).then(() => fetchSessionStartTargets()).then(targets => {
            if (!disposed) sessionStarter.refresh(targets);
          }).catch(error => {
            if (!disposed) console.warn("AICO-PPT 项目列表刷新失败", error);
          });
        };
        refresh();
        window.addEventListener("focus", refresh);
        return () => {
          disposed = true;
          window.removeEventListener("focus", refresh);
        };
      }, "aico-ppt: 常驻项目会话目标");

      ctx.effect(() => {
        const navigation = ctx.get?.('aicoSessionNavigation');
        if (navigation) return navigation.register({
          id:'aico-ppt', width:1100, closeOnUnlinked:true,
          async resolve(sessionId, signal) {
            await waitForWorkspaceReady(ctx);
            signal.throwIfAborted();
            if (archivedSessionIds(ctx).has(sessionId)) return null;
            if (appCommandUrl('/api/dsh-work-items/resolve-session') === null) throw new Error('PPT 关联查询尚未就绪');
            const result = await resolveDshSession(sessionId);
            signal.throwIfAborted();
            if (!['linked', 'unlinked'].includes(result?.status)) throw new Error('PPT 关联查询状态无效');
            if (result.status === 'linked' && !result.workItem?.workId) throw new Error('PPT 关联项目无效');
            return result.status === 'linked' ? result.workItem : null;
          },
          selected:work => sessionStarter.prefer(work?.workId ?? null),
        });
        let selectionRevision = 0;
        let disposed = false;
        const inspectSelection = (sessionId) => {
          const revision = ++selectionRevision;
          if (typeof sessionId !== "string") return;
          void waitForWorkspaceReady(ctx).then(() => archivedSessionIds(ctx).has(sessionId)
            ? { status:"unlinked" } : resolveDshSession(sessionId)).then(result => {
            if (disposed || revision !== selectionRevision
              || ctx.sessions.list.getSnapshot().current !== sessionId) return;
            const linked = result?.status === "linked";
            sessionStarter.prefer(linked ? result.workItem?.workId : null);
            const activeWorkbench = ctx.workbench.active?.() ?? null;
            if (linked) {
              if (activeWorkbench !== "aico-ppt") ctx.workbench.open("aico-ppt", 1100);
              return;
            }
            if (activeWorkbench === "aico-ppt") ctx.workbench.close();
          }).catch(error => {
            console.warn(`DSH 会话的 Deck 关联查询失败：${sessionId}`, error);
          });
        };
        const unsubscribe = ctx.on("session/open-requested", inspectSelection);
        inspectSelection(ctx.sessions.list.getSnapshot().current);
        return () => {
          disposed = true;
          selectionRevision += 1;
          unsubscribe?.();
        };
      }, "aico-ppt: 已关联会话自动打开 Editor");

      ctx.effect(() => ctx.on("session/restore-requested", async ({ sessionId }, next) => {
        if (!await restoreLinkedSession(ctx, sessionId)) return next();
        sessionStarter.refresh(await fetchSessionStartTargets());
      }), "aico-ppt: 明确恢复历史会话");

      ctx.effect(() => ctx.get?.('aicoProjectRestores')?.register({
        id:'aico-ppt', label:'AICO-PPT',
        async resolve(sessionId, signal) {
          signal.throwIfAborted();
          const linked = await resolveDshSession(sessionId, true);
          signal.throwIfAborted();
          return linked?.workItem ?? null;
        },
        async restore(sessionId, workId, signal) {
          signal.throwIfAborted();
          const linked = await resolveDshSession(sessionId, true);
          signal.throwIfAborted();
          if (linked?.workItem?.workId !== workId) throw new Error('PPT 项目关联已变化，请重试');
          if (!await restoreLinkedSession(ctx, sessionId)) throw new Error('PPT 项目关联已不存在');
          signal.throwIfAborted();
          sessionStarter.refresh(await fetchSessionStartTargets());
        },
      }), 'aico-ppt: 原装侧栏项目恢复入口');

      ctx.effect(() => {
        if (document.getElementById(STYLE_ID) !== null) return () => {};
        const style = document.createElement("style");
        style.id = STYLE_ID;
        style.textContent = STYLE;
        document.head.appendChild(style);
        return () => style.remove();
      }, "aico-ppt: Editor 嵌入样式");

      ctx.slots.inject("aico-harness.apps.launcher", () => ctx.slots.register({
        name:"aico-harness.apps.launcher",
        id:"aico-ppt",
        order:10,
        inject:() => ({ toggleWorkbench:() => ctx.workbench.toggle("aico-ppt", 1100) }),
      }, AicoPptLauncher));

      ctx.slots.inject("workbench.persistent-view", () => ctx.slots.register({
        name:"workbench.persistent-view",
        id:"aico-ppt",
        order:20,
        inject:() => {
          const executeDshCommand = createDshWorkBridge(ctx);
          const currentSession = () => sessionSummary(ctx, ctx.sessions.list.getSnapshot().current);
          const sendTask = async (prompt, requestedSessionId) => {
            const sessionId = requireBridgeString(requestedSessionId, "sessionId");
            await sendToSession(ctx, sessionId, prompt);
          };
          return {
            currentSession,
            executeDshCommand,
            sendTask,
            sessionStarter,
            sessionSource:ctx.sessions.list,
            workspaceSource:ctx.workspaces.list,
          };
        },
      }, AicoPptWorkbench));
    }

    exports.apply = apply;
    exports.readHarnessDependency = readHarnessDependency;
    exports.HarnessDependencyNotice = HarnessDependencyNotice;
    exports.inject = inject;
    return module.exports;
  }
});
