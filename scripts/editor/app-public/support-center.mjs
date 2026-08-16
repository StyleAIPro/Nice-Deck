const SUPPORT_TITLES = {
  onboarding:'开始使用',
  help:'帮助中心',
  diagnostics:'安装与诊断',
};
const ONBOARDING_STORAGE_KEY = 'huawei-deck-onboarding-v1';


function createElement(tag, className = '', text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}


function appendInlineText(parent, text) {
  for (const part of String(text).split(/(`[^`]+`)/g)) {
    if (part.startsWith('`') && part.endsWith('`')) {
      parent.append(createElement('code', '', part.slice(1, -1)));
    } else {
      parent.append(document.createTextNode(part));
    }
  }
}


function markdownCells(line) {
  return line.trim().replace(/^\||\|$/g, '').split('|').map(value => value.trim());
}


export function renderHelpMarkdown(markdown) {
  const fragment = document.createDocumentFragment();
  const lines = String(markdown).replace(/\r\n/g, '\n').split('\n');
  let list = null;
  let code = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.startsWith('```')) {
      list = null;
      if (code) {
        code = null;
      } else {
        const pre = document.createElement('pre');
        code = document.createElement('code');
        pre.append(code);
        fragment.append(pre);
      }
      continue;
    }
    if (code) {
      code.textContent += (code.textContent ? '\n' : '') + line;
      continue;
    }
    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      list = null;
      const node = document.createElement(`h${heading[1].length}`);
      appendInlineText(node, heading[2]);
      fragment.append(node);
      continue;
    }
    if (line.includes('|') && lines[index + 1]?.match(/^\s*\|?[\s:-]+\|/)) {
      list = null;
      const table = document.createElement('table');
      const head = document.createElement('thead');
      const headRow = document.createElement('tr');
      for (const value of markdownCells(line)) {
        const cell = document.createElement('th');
        appendInlineText(cell, value);
        headRow.append(cell);
      }
      head.append(headRow);
      table.append(head);
      index += 2;
      const body = document.createElement('tbody');
      while (index < lines.length && lines[index].includes('|') && lines[index].trim()) {
        const row = document.createElement('tr');
        for (const value of markdownCells(lines[index])) {
          const cell = document.createElement('td');
          appendInlineText(cell, value);
          row.append(cell);
        }
        body.append(row);
        index += 1;
      }
      index -= 1;
      table.append(body);
      fragment.append(table);
      continue;
    }
    const bullet = line.match(/^\s*[-*]\s+(.+)$/);
    const numbered = line.match(/^\s*\d+\.\s+(.+)$/);
    if (bullet || numbered) {
      const kind = numbered ? 'ol' : 'ul';
      if (!list || list.tagName.toLowerCase() !== kind) {
        list = document.createElement(kind);
        fragment.append(list);
      }
      const item = document.createElement('li');
      appendInlineText(item, (bullet || numbered)[1]);
      list.append(item);
      continue;
    }
    if (!line.trim()) {
      list = null;
      continue;
    }
    list = null;
    const paragraph = document.createElement('p');
    appendInlineText(paragraph, line);
    fragment.append(paragraph);
  }
  return fragment;
}


export function createSupportCenter({
  requestJson,
  post,
  getAppState,
  onSampleCreated,
} = {}) {
  const ui = {
    layer:document.querySelector('[data-support-layer]'),
    title:document.querySelector('[data-support-title]'),
    tabs:[...document.querySelectorAll('[data-support-tab]')],
    views:[...document.querySelectorAll('[data-support-view]')],
    openers:[...document.querySelectorAll('[data-support-open]')],
    closers:[...document.querySelectorAll('[data-support-close]')],
    helpTopics:document.querySelector('[data-help-topic-list]'),
    helpArticle:document.querySelector('[data-help-article]'),
    diagnostics:document.querySelector('[data-diagnostic-groups]'),
    diagnosticsStatus:document.querySelector('[data-diagnostics-status]'),
    refreshDiagnostics:document.querySelector('[data-refresh-diagnostics]'),
    onboardingStatus:document.querySelector('[data-onboarding-status]'),
    onboardingChecks:[...document.querySelectorAll('[data-onboarding-step]')],
    createSample:document.querySelector('[data-create-sample]'),
    openDiagnostics:document.querySelector('[data-open-diagnostics]'),
  };
  let helpCatalog = null;
  let activeHelpTopic = 'quick-start';
  let diagnosticsLoading = false;

  const status = (node, message = '', kind = '') => {
    node.textContent = message;
    node.dataset.kind = kind;
  };
  const restoreProgress = () => {
    let completed = [];
    try { completed = JSON.parse(localStorage.getItem(ONBOARDING_STORAGE_KEY) || '[]'); }
    catch { completed = []; }
    for (const input of ui.onboardingChecks) {
      input.checked = completed.includes(input.dataset.onboardingStep);
    }
  };
  const saveProgress = () => {
    const completed = ui.onboardingChecks
      .filter(input => input.checked)
      .map(input => input.dataset.onboardingStep);
    try { localStorage.setItem(ONBOARDING_STORAGE_KEY, JSON.stringify(completed)); }
    catch { /* 禁用本机存储时只保留当前页面状态。 */ }
  };

  const selectTopic = topicId => {
    if (!helpCatalog) return;
    const topic = helpCatalog.topics.find(value => value.id === topicId) ?? helpCatalog.topics[0];
    activeHelpTopic = topic.id;
    for (const button of ui.helpTopics.querySelectorAll('button')) {
      button.dataset.active = String(button.dataset.helpTopic === topic.id);
    }
    ui.helpArticle.replaceChildren(renderHelpMarkdown(topic.markdown));
  };

  const loadHelp = async () => {
    if (helpCatalog) {
      selectTopic(activeHelpTopic);
      return;
    }
    ui.helpTopics.replaceChildren(createElement('p', '', '正在读取帮助内容…'));
    try {
      helpCatalog = await requestJson('/api/help-catalog');
      ui.helpTopics.replaceChildren();
      for (const topic of helpCatalog.topics) {
        const button = createElement('button');
        button.type = 'button';
        button.dataset.helpTopic = topic.id;
        button.append(
          createElement('strong', '', topic.title),
          createElement('small', '', topic.summary),
        );
        button.addEventListener('click', () => selectTopic(topic.id));
        ui.helpTopics.append(button);
      }
      selectTopic(activeHelpTopic);
    } catch (error) {
      ui.helpTopics.replaceChildren(createElement('p', '', error.message || '帮助内容读取失败'));
    }
  };

  const checksForProfile = (environment, profileId) => {
    const profile = environment.profiles[profileId];
    return (profile?.missing || []).map(key => (
      environment.checks.find(item => item.key === key)
      ?? { key, label:key, state:'manual-action-required', remediation:null }
    ));
  };

  const makeRow = ({ label, description, detail, state, repair, guidance = [] }) => {
    const row = createElement('div', 'diagnostic-row');
    row.dataset.state = state;
    const marker = createElement('span', 'diagnostic-state', state === 'ready' ? '✓' : '!');
    const copy = createElement('span', 'diagnostic-copy');
    copy.append(createElement('strong', '', label), createElement('small', '', description));
    row.append(marker, copy, createElement('span', 'diagnostic-detail', detail));
    if (repair && state !== 'ready') {
      const button = createElement('button', 'diagnostic-action', '修复并复检');
      button.type = 'button';
      button.addEventListener('click', async () => {
        button.disabled = true;
        button.textContent = '正在修复…';
        button.setAttribute('aria-busy', 'true');
        diagnosticsLoading = true;
        ui.refreshDiagnostics.disabled = true;
        status(ui.diagnosticsStatus, `正在修复 ${label}…`, 'working');
        try {
          await post('/api/diagnostics/repair', repair);
          const snapshot = await requestJson('/api/diagnostics');
          renderDiagnostics(snapshot);
          const updated = repair.kind === 'profile'
            ? snapshot.environment.profiles[repair.profile] : null;
          if (updated?.ready || (repair.kind === 'skill' && snapshot.installation.ready)) {
            status(ui.diagnosticsStatus, `${label}已修复并通过复检。`, 'success');
          } else if (updated) {
            const remaining = checksForProfile(snapshot.environment, repair.profile);
            const names = remaining.map(item => item.label).join('、') || '未知依赖';
            status(ui.diagnosticsStatus, `已完成复检；${label}仍需处理：${names}。`, 'error');
          } else {
            status(ui.diagnosticsStatus, `${label}修复后仍未就绪，请查看目标目录。`, 'error');
          }
        } catch (error) {
          status(ui.diagnosticsStatus, error.message || `${label} 修复失败`, 'error');
        } finally {
          diagnosticsLoading = false;
          ui.refreshDiagnostics.disabled = false;
          button.disabled = false;
          button.textContent = '修复并复检';
          button.removeAttribute('aria-busy');
        }
      });
      row.append(button);
    } else if (guidance.length && state !== 'ready') {
      const button = createElement('button', 'diagnostic-action', '查看安装方法');
      button.type = 'button';
      button.addEventListener('click', () => {
        status(ui.diagnosticsStatus, guidance.join('；'), 'working');
      });
      row.append(button);
    } else {
      row.append(document.createElement('span'));
    }
    return row;
  };

  const makeGroup = (title, rows) => {
    const group = createElement('section', 'diagnostic-group');
    group.append(createElement('h4', '', title), ...rows);
    return group;
  };

  const renderDiagnostics = snapshot => {
    const { environment, installation } = snapshot;
    const registration = installation.registrations?.find(item => item.host === 'codex');
    const skillState = registration?.state === 'ready' ? 'ready'
      : registration?.state === 'occupied' ? 'manual-action-required' : 'repairable';
    const profileRow = (profileId, description) => {
      const profile = environment.profiles[profileId];
      const missing = checksForProfile(environment, profileId);
      const automatic = missing.filter(item => item.remediation?.kind === 'automatic');
      const guidance = missing
        .filter(item => item.remediation?.kind === 'manual')
        .map(item => `${item.label}：${item.remediation?.hint || item.detail || '请手动安装'}`);
      const problems = missing.map(item => (
        item.detail?.startsWith('已安装')
          ? `${item.label}（${item.detail}）` : item.label
      ));
      return makeRow({
        label:profile.label,
        description,
        detail:profile.ready ? '已就绪' : `未就绪：${problems.join('、') || '未知依赖'}`,
        state:profile.state,
        repair:automatic.length ? { kind:'profile', profile:profileId } : null,
        guidance,
      });
    };
    ui.diagnostics.replaceChildren(
      makeGroup('基础使用', [
        makeRow({
          label:'Huawei Deck Skill',
          description:'让 Codex 发现本仓库的工作流',
          detail:registration ? `${registration.targetPath} · ${registration.state}` : '未找到注册信息',
          state:skillState,
          repair:{ kind:'skill' },
        }),
        profileRow('editor-core', '启动 Editor 与真实 Agent 终端'),
      ]),
      makeGroup('质量验证', [profileRow('verify', '截图、溢出检测和动画逐拍检查')]),
      makeGroup('导出与材料', [
        profileRow('pptx-export', '将 HTML Deck 导出为 PPTX'),
        profileRow('materials', '读取 PDF/PPTX 参考材料'),
      ]),
    );
    const skillInput = ui.onboardingChecks.find(input => input.dataset.onboardingStep === 'skill');
    const agentInput = ui.onboardingChecks.find(input => input.dataset.onboardingStep === 'agent');
    const agentCheck = environment.checks.find(item => item.key === 'agent-cli');
    if (skillInput && skillState === 'ready') skillInput.checked = true;
    if (agentInput && agentCheck?.present) agentInput.checked = true;
    saveProgress();
  };

  async function loadDiagnostics(force = false) {
    if (diagnosticsLoading && !force) return;
    diagnosticsLoading = true;
    ui.refreshDiagnostics.disabled = true;
    ui.diagnostics.replaceChildren(createElement('p', '', '正在检查 Skill、Editor Core 和可选能力…'));
    status(ui.diagnosticsStatus, '诊断只读取本机状态，不读取 Deck 内容。', 'working');
    try {
      const snapshot = await requestJson('/api/diagnostics');
      renderDiagnostics(snapshot);
      status(ui.diagnosticsStatus, '检查完成。缺失的可选能力不会阻塞 Editor Core。');
      return snapshot;
    } catch (error) {
      ui.diagnostics.replaceChildren(createElement('p', '', '无法读取诊断结果。'));
      status(ui.diagnosticsStatus, error.message || '诊断失败', 'error');
    } finally {
      diagnosticsLoading = false;
      ui.refreshDiagnostics.disabled = false;
    }
    return null;
  }

  const setView = name => {
    const view = SUPPORT_TITLES[name] ? name : 'onboarding';
    ui.title.textContent = SUPPORT_TITLES[view];
    for (const tab of ui.tabs) tab.dataset.active = String(tab.dataset.supportTab === view);
    for (const panel of ui.views) panel.hidden = panel.dataset.supportView !== view;
    if (view === 'help') void loadHelp();
    if (view === 'diagnostics') void loadDiagnostics();
  };
  const open = name => {
    restoreProgress();
    setView(name);
    ui.layer.hidden = false;
    document.body.dataset.supportOpen = 'true';
    ui.layer.querySelector('.support-close')?.focus();
  };
  const close = () => {
    ui.layer.hidden = true;
    delete document.body.dataset.supportOpen;
  };

  for (const opener of ui.openers) opener.addEventListener('click', () => open(opener.dataset.supportOpen));
  for (const closer of ui.closers) closer.addEventListener('click', close);
  for (const tab of ui.tabs) tab.addEventListener('click', () => setView(tab.dataset.supportTab));
  for (const input of ui.onboardingChecks) input.addEventListener('change', saveProgress);
  ui.openDiagnostics.addEventListener('click', () => setView('diagnostics'));
  ui.refreshDiagnostics.addEventListener('click', () => void loadDiagnostics(true));
  ui.createSample.addEventListener('click', async () => {
    if (getAppState() !== 'idle') {
      status(ui.onboardingStatus, '请先返回“初始页”，再创建示例副本。', 'error');
      return;
    }
    ui.createSample.disabled = true;
    status(ui.onboardingStatus, '请选择存放示例项目的目录…', 'working');
    try {
      const result = await post('/api/onboarding/sample', {});
      if (result.status === 'cancelled') {
        status(ui.onboardingStatus, '已取消，可以稍后再试。');
        return;
      }
      const sample = ui.onboardingChecks.find(input => input.dataset.onboardingStep === 'sample');
      if (sample) sample.checked = true;
      saveProgress();
      close();
      onSampleCreated(result);
    } catch (error) {
      status(ui.onboardingStatus, error.message || '示例项目创建失败', 'error');
    } finally {
      ui.createSample.disabled = false;
    }
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !ui.layer.hidden) close();
  });
  restoreProgress();
  return { open, close, setView, loadDiagnostics };
}
