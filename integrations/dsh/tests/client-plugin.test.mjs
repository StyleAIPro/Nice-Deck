import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import test from 'node:test'

const CLIENT_URL = new URL('../client.js', import.meta.url)

async function loadClientBundle({ fetchImpl, brand } = {}) {
  const source = await readFile(CLIENT_URL, 'utf8')
  let handoff
  const styles = new Map()
  const effects = []
  const intervalCallbacks = new Map()
  const windowListeners = new Map()
  let nextIntervalId = 1
  const document = {
    head: {
      appendChild(node) {
        styles.set(node.id, node)
      },
    },
    createElement(tag) {
      return {
        tag,
        id: '',
        textContent: '',
        remove() { styles.delete(this.id) },
      }
    },
    getElementById(id) {
      return styles.get(id) ?? null
    },
  }
  const window = {
    location:{ origin:'http://127.0.0.1:3080' },
    addEventListener(type, listener) {
      const listeners = windowListeners.get(type) ?? new Set()
      listeners.add(listener)
      windowListeners.set(type, listeners)
    },
    removeEventListener(type, listener) {
      windowListeners.get(type)?.delete(listener)
    },
    __ModuleLoader__: {
      load(value) { handoff = value },
    },
  }
  vm.runInNewContext(source, {
    window, document, console, URL,
    fetch:fetchImpl ?? (async () => ({ ok:true, json:async () => ({ status:'unlinked' }) })),
    setTimeout, clearTimeout,
    setInterval(callback) {
      const id = nextIntervalId++
      intervalCallbacks.set(id, callback)
      return id
    },
    clearInterval(id) { intervalCallbacks.delete(id) },
    __AICO_PPT_BRAND__:brand ?? {
      appUrl:'http://127.0.0.1:4100/app/?token=test',
      logo:'data:image/png;base64,dGVzdC1sb2dv',
    },
  }, { filename: fileURL(CLIENT_URL) })
  assert.ok(handoff)
  const React = {
    Fragment: Symbol('Fragment'),
    createElement(type, props, ...children) { return { type, props:props ?? {}, children } },
    useEffect(effect) { effects.push(effect) },
    useRef() { return { current: null } },
    useState(value) { return [value, () => {}] },
  }
  return {
    source,
    styles,
    effects,
    intervalCallbacks,
    windowListeners,
    handoff,
    plugin: handoff.factory((specifier) => {
      if (specifier === 'react') return React
      throw new Error(`测试未声明的 Client 外部模块：${specifier}`)
    }),
  }
}

function fileURL(url) {
  return url.pathname
}

test('Client bundle 注册左侧入口与跨会话常驻 workbench 视图', async () => {
  const loaded = await loadClientBundle()
  assert.equal(loaded.handoff.id, 'aico-ppt-skill')
  assert.deepEqual(Array.from(loaded.plugin.inject), [
    'slots', 'sessions', 'workspaces', 'conversation', 'workbench', 'sessionStarts',
  ])
  assert.doesNotMatch(loaded.source, /node-pty|agent-terminal-panel|\/agent-terminal/u)
  assert.match(loaded.source, /clipboard-read \*; clipboard-write \*; fullscreen \*/u)
  assert.doesNotMatch(loaded.source, /allowFullScreen:true/u)

  const registrations = []
  const sent = []
  const toggled = []
  const sessionOperations = []
  let sessionStartContribution
  let blockSessionOpen = false
  let blockSessionRename = false
  let currentSessionId = 'session-1'
  const sessionRows = {
    'session-1':{ displayTitle:'会话一', cwd:'/project', running:false },
    'session-2':{ title:'session-2', displayTitle:'session-2', cwd:'/project', running:true },
  }
  const ctx = {
    effect(effect) { return effect() },
    on() { return () => {} },
    slots: {
      inject(name, mount) {
        assert.ok(['sidebar.footer.action', 'workbench.persistent-view'].includes(name))
        return mount()
      },
      register(options, component) {
        registrations.push({ options, component })
        return () => {}
      },
    },
    sessions: {
      list: {
        getSnapshot() { return { current:currentSessionId, byId:sessionRows } },
        subscribe() { return () => {} },
      },
      async create({ workspaceId, sessionId }) {
        assert.equal(workspaceId, 'workspace-project')
        sessionRows[sessionId] ??= { displayTitle:sessionId, running:false }
        return sessionId
      },
      async fork({ sessionId, increaseTitle }) {
        assert.equal(sessionId, 'session-1')
        assert.equal(increaseTitle, true)
        sessionRows['session-fork'] = { displayTitle:'会话一 2', cwd:'/project', running:false }
        return 'session-fork'
      },
      open(sessionId) {
        sessionOperations.push(['select', sessionId])
        currentSessionId = sessionId
      },
      binding(sessionId) {
        return {
          session: {
            async rename(title) {
              sessionOperations.push(['rename', sessionId, title])
              if (blockSessionRename) await new Promise(() => {})
              sessionRows[sessionId].title = title
              sessionRows[sessionId].displayTitle = title
              return { ok:true, value:{ title, seq:1 } }
            },
            async open() {
              sessionOperations.push(['prepare', sessionId])
              if (blockSessionOpen) await new Promise(() => {})
            },
          },
          ctx: {
            get(service) {
              assert.equal(service, 'conversation')
              return { send: async prompt => { sent.push([sessionId, prompt]) } }
            },
          },
        }
      },
    },
    workspaces: {
      list: {
        getSnapshot() { return { archivedSessionIds:[] } },
        subscribe() { return () => {} },
      },
      async create({ path }) {
        assert.equal(path, '/project')
        return { workspaceId:'workspace-project', path, title:'project' }
      },
    },
    workbench: {
      toggle(target, width) { toggled.push([target, width]) },
    },
    sessionStarts:{
      register(contribution) {
        sessionStartContribution = contribution
        return () => { sessionStartContribution = undefined }
      },
    },
  }

  loaded.plugin.apply(ctx)
  assert.equal(loaded.styles.has('aico-ppt-dsh-style'), true)
  const launcher = registrations.find(row => row.options.name === 'sidebar.footer.action')
  const workbench = registrations.find(row => row.options.name === 'workbench.persistent-view')
  assert.ok(launcher)
  assert.ok(workbench)
  assert.equal(launcher.options.id, 'aico-ppt')
  assert.equal(workbench.options.id, 'aico-ppt')
  assert.equal(typeof workbench.component, 'function')
  const launcherTree = launcher.component({ ...launcher.options.inject(), wide:true })
  assert.equal(launcherTree.children[0].children[0].type, 'img')
  assert.equal(
    launcherTree.children[0].children[0].props.src,
    'data:image/png;base64,dGVzdC1sb2dv',
  )
  assert.equal(sessionStartContribution.id, 'aico-ppt')
  assert.equal(sessionStartContribution.label, 'AICO-PPT')
  assert.deepEqual(JSON.parse(JSON.stringify(sessionStartContribution.source.getSnapshot())), [])

  launcher.options.inject().toggleWorkbench()
  assert.deepEqual(toggled, [['aico-ppt', 1100]])
  const face = workbench.options.inject()
  await assert.rejects(
    () => face.sendTask('/aico-ppt\n缺少会话的任务'),
    /sessionId 无效/u,
  )
  await face.sendTask('/aico-ppt\n测试任务', 'session-1')
  currentSessionId = 'session-2'
  await face.sendTask('/aico-ppt\n第二个任务', 'session-2')
  assert.deepEqual(sent, [
    ['session-1', '/aico-ppt\n测试任务'],
    ['session-2', '/aico-ppt\n第二个任务'],
  ])

  const tree = workbench.component(face)
  const iframe = tree.children[0]
  const contentWindow = { postMessage() {} }
  iframe.props.ref.current = { contentWindow }
  const cleanups = loaded.effects.map(effect => effect()).filter(Boolean)
  for (const listener of loaded.windowListeners.get('message') ?? []) {
    await listener({
      source:contentWindow,
      origin:'http://127.0.0.1:4100',
      data:{
        type:'aico-ppt:create-request',
        prompt:'/aico-ppt\n旧协议不得发送',
        sessionId:'session-1',
      },
    })
  }
  assert.deepEqual(sent, [
    ['session-1', '/aico-ppt\n测试任务'],
    ['session-2', '/aico-ppt\n第二个任务'],
  ], '没有 requestId 的旧消息不得绕过 DSH Bridge')

  assert.deepEqual(JSON.parse(JSON.stringify(
    await face.executeDshCommand('ensure-workspace', { path:'/project' }),
  )), {
    workspaceId:'workspace-project', path:'/project', title:'project',
  })
  assert.deepEqual(JSON.parse(JSON.stringify(await face.executeDshCommand('create-session', {
    workspaceId:'workspace-project', sessionId:'session-new', title:'修改 Deck：技术解析.html',
  }))), {
    sessionId:'session-new', title:'修改 Deck：技术解析.html', cwd:null, running:false,
    archived:false,
  })
  await face.executeDshCommand('create-session', {
    workspaceId:'workspace-project', sessionId:'session-new', title:'修改 Deck：重复恢复不应改名',
  })
  assert.equal((await face.executeDshCommand('fork-session', {
    sourceSessionId:'session-1',
  })).sessionId, 'session-fork')
  await face.executeDshCommand('open-session', {
    sessionId:'session-1', title:'修改 Deck：旧任务补名',
  })
  assert.deepEqual(sessionOperations, [
    ['rename', 'session-new', '修改 Deck：技术解析.html'],
    ['rename', 'session-1', '修改 Deck：旧任务补名'],
    ['prepare', 'session-1'],
    ['select', 'session-1'],
  ])
  await face.executeDshCommand('send-to-session', {
    sessionId:'session-1', prompt:'指定会话',
  })
  assert.deepEqual(sent.at(-1), ['session-1', '指定会话'])
  assert.equal((await face.executeDshCommand('current-session')).sessionId, 'session-1')
  blockSessionOpen = true
  void face.executeDshCommand('open-session', { sessionId:'session-2' })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(
    currentSessionId,
    'session-2',
    '目标会话仍在加载历史时也必须立即切换，不能把 Editor 项目导航一起卡住',
  )
  blockSessionRename = true
  currentSessionId = 'session-1'
  void face.executeDshCommand('open-session', {
    sessionId:'session-2', title:'修改 Deck：补中文标题',
  })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(
    currentSessionId,
    'session-2',
    '中文标题补写仍在等待时，也必须立即选中会话并继续 Editor 导航',
  )
  const createWhileRenaming = face.executeDshCommand('create-session', {
    workspaceId:'workspace-project', sessionId:'session-background-title',
    title:'创建 Deck：后台补名',
  })
  const immediateCreate = await Promise.race([
    createWhileRenaming,
    new Promise(resolve => setImmediate(() => resolve('blocked'))),
  ])
  assert.notEqual(immediateCreate, 'blocked', '新会话不能因补写标题而卡住')
  assert.equal(immediateCreate.title, '创建 Deck：后台补名')
  await assert.rejects(() => face.executeDshCommand('unknown-command'), /不支持的 DSH Bridge 命令/u)
  for (const cleanup of cleanups.reverse()) cleanup()
})

test('Editor 关闭时仍按项目目录显示 AICO-PPT 入口，并在选择后打开和导航', async () => {
  const target = {
    kind:'editing', workId:'work-catalog', revision:4,
    deckName:'可靠性设计.html', deckPath:'/project/reliability/可靠性设计.html',
    displayName:'不应显示的目录名', projectRoot:'/project/reliability', projectName:'reliability',
  }
  const loaded = await loadClientBundle({
    fetchImpl:async (url, options) => {
      if (String(url).includes('/api/work-history')) {
        return { ok:true, json:async () => ({ creation:[], editing:[target] }) }
      }
      assert.ok(options?.body)
      return { ok:true, json:async () => ({ status:'unlinked', workItem:null }) }
    },
  })
  const registrations = []
  const opened = []
  let sessionStartContribution
  let activeWorkbench = null
  const ctx = {
    effect(effect) { return effect() },
    on() { return () => {} },
    slots:{
      inject(_name, mount) { return mount() },
      register(options, component) {
        registrations.push({ options, component })
        return () => {}
      },
    },
    sessions:{
      list:{
        getSnapshot:() => ({ current:'ordinary-session', byId:{} }),
        subscribe:() => () => {},
      },
      binding:() => null,
    },
    workspaces:{ list:{ getSnapshot:() => ({ archivedSessionIds:[] }), subscribe:() => () => {} } },
    workbench:{
      active:() => activeWorkbench,
      open(id, width) {
        activeWorkbench = id
        opened.push([id, width])
      },
      close() { activeWorkbench = null },
      toggle() {},
    },
    sessionStarts:{
      register(contribution) {
        sessionStartContribution = contribution
        return () => {}
      },
    },
  }

  loaded.plugin.apply(ctx)
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(JSON.parse(JSON.stringify(sessionStartContribution.source.getSnapshot())), [{
    key:'work-catalog:4', label:'可靠性设计.html', description:'reliability', current:false,
  }])

  const starting = sessionStartContribution.start(sessionStartContribution.source.getSnapshot()[0])
  assert.deepEqual(opened, [['aico-ppt', 1100]])

  const registration = registrations.find(row => row.options.name === 'workbench.persistent-view')
  const tree = registration.component(registration.options.inject())
  const iframe = tree.children[0]
  const posted = []
  const contentWindow = { postMessage(message, origin) { posted.push({ message, origin }) } }
  iframe.props.ref.current = { contentWindow }
  const cleanups = loaded.effects.map(effect => effect()).filter(Boolean)
  for (const listener of loaded.windowListeners.get('message') ?? []) {
    await listener({
      source:contentWindow,
      origin:'http://127.0.0.1:4100',
      data:{
        type:'aico-ppt:dsh-work-context', context:null,
        targets:[{
          workId:'work-catalog', contextKey:'work-catalog:4', kind:'editing',
          displayName:'可靠性设计.html', projectRoot:'/project/reliability', projectName:'reliability',
        }],
      },
    })
  }
  const navigation = posted.at(-1).message
  assert.equal(navigation.type, 'aico-ppt:navigate-work-session-target-request')
  for (const listener of loaded.windowListeners.get('message') ?? []) {
    await listener({
      source:contentWindow,
      origin:'http://127.0.0.1:4100',
      data:{
        type:'aico-ppt:dsh-work-context',
        context:{
          workId:'work-catalog', contextKey:'work-catalog:4', kind:'editing',
          displayName:'可靠性设计.html', projectRoot:'/project/reliability', projectName:'reliability',
        },
        targets:[],
      },
    })
  }
  const creation = posted.at(-1).message
  assert.equal(creation.type, 'aico-ppt:create-work-session-request')
  for (const listener of loaded.windowListeners.get('message') ?? []) {
    await listener({
      source:contentWindow,
      origin:'http://127.0.0.1:4100',
      data:{
        type:'aico-ppt:create-work-session-result', requestId:creation.requestId,
        ok:true, result:{ workId:'work-catalog', sessionId:'session-created' },
      },
    })
  }
  assert.deepEqual(JSON.parse(JSON.stringify(await starting)), {
    workId:'work-catalog', sessionId:'session-created',
  })
  for (const cleanup of cleanups.reverse()) cleanup()
})

test('workbench 对会话切换提供轮询兜底，并在 Editor ready 后重放当前会话', async () => {
  const loaded = await loadClientBundle()
  const registrations = []
  let currentSessionId = 'session-1'
  let archivedSessionIds = []
  const workspaceSubscribers = new Set()
  let sessionStartContribution
  const sessionRows = {
    'session-1':{ displayTitle:'创建 Deck：技术研究', cwd:'/creation', running:false },
    'session-2':{ displayTitle:'修改 Deck：技术解析', cwd:'/editing', running:true },
  }
  const ctx = {
    effect(effect) { return effect() },
    on() { return () => {} },
    slots: {
      inject(_name, mount) { return mount() },
      register(options, component) {
        registrations.push({ options, component })
        return () => {}
      },
    },
    sessions: {
      list: {
        getSnapshot() { return { current:currentSessionId, byId:sessionRows } },
        // 精确模拟实机问题：选中态已变化，但宿主没有及时触发订阅回调。
        subscribe() { return () => {} },
      },
      binding() { return null },
    },
    workspaces:{
      list:{
        getSnapshot() { return { archivedSessionIds } },
        subscribe(listener) {
          workspaceSubscribers.add(listener)
          return () => workspaceSubscribers.delete(listener)
        },
      },
    },
    workbench:{ toggle() {} },
    sessionStarts:{
      register(contribution) {
        sessionStartContribution = contribution
        return () => { sessionStartContribution = undefined }
      },
    },
  }
  loaded.plugin.apply(ctx)
  const registration = registrations.find(row => row.options.name === 'workbench.persistent-view')
  const face = registration.options.inject()
  const tree = registration.component(face)
  const iframe = tree.children[0]
  const posted = []
  const contentWindow = { postMessage(message, origin) { posted.push({ message, origin }) } }
  iframe.props.ref.current = { contentWindow }
  const cleanups = loaded.effects.map(effect => effect()).filter(Boolean)

  assert.equal(posted.at(-1).message.session.sessionId, 'session-1')
  for (const listener of loaded.windowListeners.get('message') ?? []) {
    await listener({
      source:contentWindow,
      origin:'http://127.0.0.1:4100',
      data:{
        type:'aico-ppt:dsh-work-context',
        context:{
          workId:'work-1', contextKey:'work-1:2', kind:'editing',
          displayName:'技术解析', projectRoot:'/project/deck', projectName:'deck',
        },
        targets:[
          {
            workId:'work-1', contextKey:'work-1:2', kind:'editing',
            displayName:'技术解析', projectRoot:'/project/deck', projectName:'deck',
          },
          {
            workId:'work-2', contextKey:'work-2:5', kind:'editing',
            displayName:'季度汇报.html', projectRoot:'/project/report', projectName:'report',
          },
        ],
      },
    })
  }
  assert.deepEqual(JSON.parse(JSON.stringify(sessionStartContribution.source.getSnapshot())), [
    {
      key:'work-1:2',
      label:'技术解析',
      description:'deck',
      current:false,
    },
    {
      key:'work-2:5',
      label:'季度汇报.html',
      description:'report',
      current:false,
    },
  ])
  const alternativeStart = sessionStartContribution.start(
    sessionStartContribution.source.getSnapshot()[1],
  )
  const navigationRequest = posted.at(-1)
  assert.equal(navigationRequest.message.type, 'aico-ppt:navigate-work-session-target-request')
  assert.equal(navigationRequest.message.workId, 'work-2')
  assert.equal(navigationRequest.message.contextKey, 'work-2:5')
  for (const listener of loaded.windowListeners.get('message') ?? []) {
    await listener({
      source:contentWindow,
      origin:'http://127.0.0.1:4100',
      data:{
        type:'aico-ppt:dsh-work-context',
        context:{
          workId:'work-2', contextKey:'work-2:5', kind:'editing',
          displayName:'季度汇报.html', projectRoot:'/project/report', projectName:'report',
        },
        targets:[
          {
            workId:'work-2', contextKey:'work-2:5', kind:'editing',
            displayName:'季度汇报.html', projectRoot:'/project/report', projectName:'report',
          },
        ],
      },
    })
  }
  const alternativeRequest = posted.at(-1)
  assert.equal(alternativeRequest.message.type, 'aico-ppt:create-work-session-request')
  for (const listener of loaded.windowListeners.get('message') ?? []) {
    await listener({
      source:contentWindow,
      origin:'http://127.0.0.1:4100',
      data:{
        type:'aico-ppt:create-work-session-result',
        requestId:alternativeRequest.message.requestId,
        ok:true,
        result:{ workId:'work-2', sessionId:'session-other-project' },
      },
    })
  }
  assert.deepEqual(JSON.parse(JSON.stringify(await alternativeStart)), {
    workId:'work-2', sessionId:'session-other-project',
  })
  for (const listener of loaded.windowListeners.get('message') ?? []) {
    await listener({
      source:contentWindow,
      origin:'http://127.0.0.1:4100',
      data:{
        type:'aico-ppt:dsh-work-context',
        context:{
          workId:'work-1', contextKey:'work-1:2', kind:'editing',
          displayName:'技术解析', projectRoot:'/project/deck', projectName:'deck',
        },
        targets:[
          {
            workId:'work-1', contextKey:'work-1:2', kind:'editing',
            displayName:'技术解析', projectRoot:'/project/deck', projectName:'deck',
          },
          {
            workId:'work-2', contextKey:'work-2:5', kind:'editing',
            displayName:'季度汇报.html', projectRoot:'/project/report', projectName:'report',
          },
        ],
      },
    })
  }
  const contextualStart = sessionStartContribution.start(
    sessionStartContribution.source.getSnapshot()[0],
  )
  const contextualRequest = posted.at(-1)
  assert.equal(contextualRequest.message.type, 'aico-ppt:create-work-session-request')
  assert.equal(contextualRequest.message.workId, 'work-1')
  assert.equal(contextualRequest.message.contextKey, 'work-1:2')
  for (const listener of loaded.windowListeners.get('message') ?? []) {
    await listener({
      source:contentWindow,
      origin:'http://127.0.0.1:4100',
      data:{
        type:'aico-ppt:create-work-session-result',
        requestId:contextualRequest.message.requestId,
        ok:true,
        result:{ workId:'work-1', sessionId:'session-new' },
      },
    })
  }
  assert.deepEqual(JSON.parse(JSON.stringify(await contextualStart)), {
    workId:'work-1', sessionId:'session-new',
  })
  currentSessionId = 'session-2'
  for (const callback of loaded.intervalCallbacks.values()) callback()
  assert.equal(
    posted.at(-1).message.session.sessionId,
    'session-2',
    '即使宿主漏发订阅通知，也应发现当前会话已变化',
  )

  posted.length = 0
  archivedSessionIds = ['session-1']
  delete sessionRows['session-1']
  for (const listener of workspaceSubscribers) listener()
  assert.equal(posted.length, 1, '归档非当前会话也必须强制通知 Editor 刷新选择器')
  assert.equal(posted[0].message.session.sessionId, 'session-2')
  assert.equal((await face.executeDshCommand('describe-sessions', {
    sessionIds:['session-1'],
  }))[0].archived, true)

  posted.length = 0
  for (const listener of loaded.windowListeners.get('message') ?? []) {
    await listener({
      source:contentWindow,
      origin:'http://127.0.0.1:4200',
      data:{ type:'aico-ppt:dsh-ready' },
    })
  }
  assert.equal(posted.length, 0, '未由启动页注册的随机本地 Origin 也不能访问 DSH Bridge')
  for (const listener of loaded.windowListeners.get('message') ?? []) {
    await listener({
      source:contentWindow,
      origin:'http://127.0.0.1:4300',
      data:{ type:'aico-ppt:dsh-frame-origin', origin:'http://127.0.0.1:4300' },
    })
  }
  assert.equal(posted.length, 0, '非启动页来源不能自行注册 Editor Origin')
  for (const listener of loaded.windowListeners.get('message') ?? []) {
    await listener({
      source:contentWindow,
      origin:'http://127.0.0.1:4100',
      data:{ type:'aico-ppt:dsh-frame-origin', origin:'https://outside.example.test' },
    })
  }
  assert.equal(posted.length, 0, '启动页不能注册非本地 Editor Origin')
  for (const listener of loaded.windowListeners.get('message') ?? []) {
    await listener({
      source:contentWindow,
      origin:'http://127.0.0.1:4100',
      data:{ type:'aico-ppt:dsh-frame-origin', origin:'http://127.0.0.1:4200' },
    })
  }
  for (const listener of loaded.windowListeners.get('message') ?? []) {
    await listener({
      source:contentWindow,
      origin:'http://127.0.0.1:4200',
      data:{ type:'aico-ppt:dsh-ready' },
    })
  }
  assert.equal(posted.at(-1).message.session.sessionId, 'session-2')
  assert.equal(posted.at(-1).origin, 'http://127.0.0.1:4200')
  posted.length = 0
  for (const listener of loaded.windowListeners.get('message') ?? []) {
    await listener({
      source:contentWindow,
      origin:'http://127.0.0.1:4200',
      data:{
        type:'aico-ppt:dsh-request', requestId:'request-current',
        command:'current-session', payload:{},
      },
    })
  }
  assert.equal(posted.at(-1).message.result.sessionId, 'session-2')
  assert.equal(posted.at(-1).origin, 'http://127.0.0.1:4200')
  posted.length = 0
  for (const listener of loaded.windowListeners.get('message') ?? []) {
    await listener({
      source:contentWindow,
      origin:'http://127.0.0.1:4100',
      data:{ type:'aico-ppt:dsh-ready' },
    })
  }
  assert.equal(posted.at(-1).message.session.sessionId, 'session-2')
  assert.equal(
    posted.at(-1).origin,
    'http://127.0.0.1:4100',
    '从修改任务切回创建任务时，应将发布目标恢复为启动页 Origin',
  )
  for (const cleanup of cleanups.reverse()) cleanup()
})

test('会话选择只在绑定状态变化时打开或关闭 Editor，重复事件不得反复重载', async () => {
  const requests = []
  const linkedWorkItem = {
    kind:'editing', workId:'work-linked', revision:3,
    deckName:'当前项目.html', deckPath:'/project/current/当前项目.html',
    projectRoot:'/project/current', projectName:'current',
  }
  const loaded = await loadClientBundle({
    fetchImpl:async (_url, options) => {
      if (!options?.body) {
        return { ok:true, json:async () => ({ creation:[], editing:[linkedWorkItem] }) }
      }
      const input = JSON.parse(options.body)
      requests.push(input.sessionId)
      return {
        ok:true,
        async json() {
          return input.sessionId === 'session-linked'
            ? { status:'linked', workItem:linkedWorkItem }
            : { status:'unlinked', workItem:null }
        },
      }
    },
  })
  const openSubscribers = new Set()
  const opened = []
  const closed = []
  let sessionStartContribution
  let activeWorkbench = 'aico-ppt'
  let currentSessionId = 'session-linked'
  const ctx = {
    effect(effect) { return effect() },
    on(type, listener) {
      assert.equal(type, 'session/open-requested')
      openSubscribers.add(listener)
      return () => openSubscribers.delete(listener)
    },
    slots:{
      inject(_name, mount) { return mount() },
      register() { return () => {} },
    },
    sessions:{
      list:{
        getSnapshot() { return { current:currentSessionId, byId:{} } },
        subscribe() { return () => {} },
      },
    },
    workspaces:{ list:{ getSnapshot:() => ({ archivedSessionIds:[] }), subscribe:() => () => {} } },
    workbench:{
      active() { return activeWorkbench },
      open(target, width) {
        opened.push([target, width])
        activeWorkbench = target
      },
      close() {
        closed.push(activeWorkbench)
        activeWorkbench = null
      },
      toggle() {},
    },
    sessionStarts:{
      register(contribution) {
        sessionStartContribution = contribution
        return () => {}
      },
    },
  }

  loaded.plugin.apply(ctx)
  for (const listener of openSubscribers) listener(currentSessionId)
  for (const listener of openSubscribers) listener(currentSessionId)
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(opened, [], 'Editor 已打开时，重复的同会话事件不能再次打开或重载')
  assert.equal(sessionStartContribution.source.getSnapshot()[0].current, true)

  currentSessionId = 'session-other'
  for (const listener of openSubscribers) listener(currentSessionId)
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(closed, ['aico-ppt'], '普通会话必须自动关闭当前 AICO-PPT Editor')
  assert.equal(sessionStartContribution.source.getSnapshot()[0].current, false)

  currentSessionId = 'session-linked'
  for (const listener of openSubscribers) listener(currentSessionId)
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(requests, [
    'session-linked', 'session-linked', 'session-linked', 'session-other', 'session-linked',
  ])
  assert.deepEqual(opened, [['aico-ppt', 1100]])
  assert.equal(sessionStartContribution.source.getSnapshot()[0].current, true)

  for (const listener of openSubscribers) listener(currentSessionId)
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(opened, [['aico-ppt', 1100]], '已打开时再次收到同会话事件仍不得重载')

  activeWorkbench = null
  for (const listener of openSubscribers) listener(currentSessionId)
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(
    opened,
    [['aico-ppt', 1100], ['aico-ppt', 1100]],
    'Editor 关闭后再次点击当前已关联会话，也必须重新打开',
  )
})

test('会话关联查询晚到时不得为已经离开的旧会话重开 Editor', async () => {
  let resolveLinked
  const loaded = await loadClientBundle({
    fetchImpl:async (_url, options) => {
      if (!options?.body) {
        return { ok:true, json:async () => ({ creation:[], editing:[] }) }
      }
      const { sessionId } = JSON.parse(options.body)
      if (sessionId === 'session-linked') {
        return new Promise(resolve => { resolveLinked = resolve })
      }
      return { ok:true, json:async () => ({ status:'unlinked' }) }
    },
  })
  const openSubscribers = new Set()
  const opened = []
  let currentSessionId = 'session-linked'
  const ctx = {
    effect(effect) { return effect() },
    on(type, listener) {
      assert.equal(type, 'session/open-requested')
      openSubscribers.add(listener)
      return () => openSubscribers.delete(listener)
    },
    slots:{ inject(_name, mount) { return mount() }, register() { return () => {} } },
    sessions:{
      list:{
        getSnapshot() { return { current:currentSessionId, byId:{} } },
        subscribe() { return () => {} },
      },
    },
    workspaces:{ list:{ getSnapshot:() => ({ archivedSessionIds:[] }), subscribe:() => () => {} } },
    workbench:{
      active() { return null },
      open(target, width) { opened.push([target, width]) },
      close() {},
      toggle() {},
    },
    sessionStarts:{ register() { return () => {} } },
  }

  loaded.plugin.apply(ctx)
  for (const listener of openSubscribers) listener('session-linked')
  await new Promise(resolve => setImmediate(resolve))
  currentSessionId = 'session-ordinary'
  for (const listener of openSubscribers) listener('session-ordinary')
  await new Promise(resolve => setImmediate(resolve))
  resolveLinked({ ok:true, json:async () => ({ status:'linked' }) })
  await new Promise(resolve => setImmediate(resolve))

  assert.deepEqual(opened, [], '旧会话的晚到响应不能覆盖用户更新后的会话选择')
})

test('package manifest 同时声明 Host bundle 与 Client 依赖', async () => {
  const manifest = JSON.parse(await readFile(new URL('../../../package.json', import.meta.url), 'utf8'))
  const patch = await readFile(new URL('../../../cordis.patch.yml', import.meta.url), 'utf8')

  assert.equal(manifest.main, 'integrations/dsh/index.mjs')
  assert.equal(manifest.version, '0.1.0')
  assert.equal(manifest.exports['./client'], './integrations/dsh/client.js')
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(manifest.dsh.client.platform, 'web')
  assert.ok(manifest.dsh.client.inject.includes('@deepseek-ai/dsh-api-session-controller'))
  assert.ok(manifest.dsh.client.inject.includes('@deepseek-ai/dsh-api-workspace-controller'))
  assert.ok(manifest.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-conversation'))
  assert.ok(manifest.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-sidebar'))
  assert.ok(manifest.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-workbench'))
  assert.match(patch, /id: aico-ppt/u)
  assert.match(patch, /name: aico-ppt-skill/u)
})
