import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const ROOT = new URL('../../../', import.meta.url);
const FILES = [
  'SKILL.md',
  'README.md',
  'references/editing-guide.md',
  'docs/architecture.md',
];

async function loadDocuments() {
  return Object.fromEntries(await Promise.all(FILES.map(async file => [
    file,
    await readFile(new URL(file, ROOT), 'utf8'),
  ])));
}

function requireClaims(file, contents, claims) {
  for (const [claim, pattern] of Object.entries(claims)) {
    assert.match(contents, pattern, `${file} 缺少文档契约：${claim}`);
  }
}

test('四份入口文档共享后期微调、安全写回与第一版边界', async () => {
  const documents = await loadDocuments();
  for (const [file, contents] of Object.entries(documents)) {
    requireClaims(file, contents, {
      '启动命令': /python3 scripts\/deck-editor\.py <deck\.html>/,
      'sidecar 目录': /\.huawei-deck-editor\//,
      '外部 Agent 而非内置聊天': /外部 (?:Codex|Claude Code|Agent)[\s\S]{0,180}(?:不是|不内置)[\s\S]{0,80}(?:聊天|聊天机器人)/,
      '正式写回经 edit-bundle': /(?:正式)?写回[\s\S]{0,260}scripts\/edit-bundle\.py/,
      '第一版不增删页': /第一版[\s\S]{0,180}(?:不增删页|不支持[^\n]{0,30}增删页)/,
      '第一版不调整页序': /第一版[\s\S]{0,220}(?:不调整页序|不支持[^\n]{0,30}页序)/,
      '第一版不重构复杂动画': /第一版[\s\S]{0,260}(?:不重构复杂动画|不支持[^\n]{0,30}复杂动画)/,
      'bundle 结构验证': /(?:eb\.verify|python3 scripts\/edit-bundle\.py)/,
      '溢出验证': /measure_overflow\.mjs/,
      '截图验证': /shot\.mjs/,
      '动画逐拍验证': /steps\.mjs/,
    });
  }
});

test('用户入口文档覆盖真实启动示例、交互闭环、恢复与 sidecar 生命周期', async () => {
  const documents = await loadDocuments();
  const corpus = Object.values(documents).join('\n');
  requireClaims('四份文档合集', corpus, {
    '真实 renzhi 启动示例': /python3 scripts\/deck-editor\.py Deck-Projects\/renzhi\/renzhi-deck\.html/,
    '区域拉框旁侧输入': /区域拉框[\s\S]{0,100}旁侧输入/,
    '跨页任务 drawer': /跨页[\s\S]{0,100}(?:task drawer|任务 drawer|Agent drawer)/i,
    '直接文字移动缩放': /(?:直接)?文字[\s\S]{0,80}移动[\s\S]{0,80}缩放/,
    '外部 Agent 读任务和提交动作': /外部 (?:Codex|Claude Code|Agent)[\s\S]{0,180}读取任务[\s\S]{0,180}提交动作/,
    'sidecar 内容': /\.huawei-deck-editor\/[\s\S]{0,260}会话[\s\S]{0,100}任务[\s\S]{0,100}快照[\s\S]{0,100}动作[\s\S]{0,100}诊断[\s\S]{0,100}备份/,
    'sidecar 不进交付与版本控制': /\.huawei-deck-editor\/[\s\S]{0,300}(?:不进入|不会进入)[^\n]{0,60}(?:交付 deck|最终交付)[\s\S]{0,180}(?:忽略提交|Git 忽略|gitignore)/i,
    '三重写回闸门': /editor online[\s\S]{0,180}文件指纹[\s\S]{0,180}无新增溢出[\s\S]{0,180}(?:bundle verify|eb\.verify)/i,
    '临时文件备份原子替换': /临时文件[\s\S]{0,120}备份[\s\S]{0,120}原子替换/,
    '预览和自动保存不碰 source deck': /(?:预览|自动会话保存)[\s\S]{0,160}(?:不触碰|不修改)[^\n]{0,50}(?:source deck|原始 deck)/i,
    'Agent 动作安全字段': /token[\s\S]{0,100}revision[\s\S]{0,100}locator[\s\S]{0,100}事务/i,
    '冲突不静默覆盖': /(?:冲突|验证失败)[\s\S]{0,120}(?:不静默覆盖|拒绝覆盖)/,
    '恢复与外部变化': /session[\s\S]{0,120}(?:重开|恢复)[\s\S]{0,180}RECOVERY_REQUIRED[\s\S]{0,180}(?:重载|另存副本)/i,
  });

  requireClaims('references/editing-guide.md', documents['references/editing-guide.md'], {
    '五种模式': /预览[\s\S]{0,80}区域标记[\s\S]{0,80}文字[\s\S]{0,80}移动[\s\S]{0,80}缩放/,
    '撤销与重做': /撤销[\s\S]{0,80}重做/,
    '保存会话与写回有区别': /保存会话[\s\S]{0,180}(?:不同于|不等于|区别)[\s\S]{0,180}(?:正式)?写回/,
    '稳定错误码': /DECK_CHANGED[\s\S]{0,120}NEW_OVERFLOW[\s\S]{0,120}EDITOR_OFFLINE[\s\S]{0,120}RECOVERY_REQUIRED/,
    '目标缺失或歧义': /目标[\s\S]{0,40}(?:缺失|不存在)[\s\S]{0,80}(?:歧义|多个候选)/,
  });
});

test('Skill、README 与架构文档各自承担入口、仓库和开发者职责', async () => {
  const documents = await loadDocuments();
  requireClaims('SKILL.md', documents['SKILL.md'], {
    '启动器文件导航': /`scripts\/deck-editor\.py`/,
    '编辑器目录文件导航': /`scripts\/editor\/`/,
    '批量重构仍由 Agent 完成': /(?:新建|批量重构)[\s\S]{0,180}Agent[\s\S]{0,120}edit-bundle/,
  });
  requireClaims('README.md', documents['README.md'], {
    '依赖体检': /python3 scripts\/check_deps\.py/,
    '回环地址': /(?:loopback|回环地址|127\.0\.0\.1)/i,
    '浏览器工作台': /浏览器工作台/,
  });
  requireClaims('docs/architecture.md', documents['docs/architecture.md'], {
    '浏览器双层': /browser parent[\s\S]{0,100}frame/i,
    '桥和持久化组件': /BridgeService[\s\S]{0,180}SessionStore[\s\S]{0,100}PatchJournal/,
    '可信 sidecar I/O': /persistent dirfd helper/,
    '写回组件': /bundle adapter[\s\S]{0,180}diagnostics[\s\S]{0,100}watch[\s\S]{0,100}write gate/i,
    '状态与动作模型': /session registry[\s\S]{0,120}transaction record[\s\S]{0,120}revision[\s\S]{0,120}mutation queue[\s\S]{0,120}canonical action[\s\S]{0,120}authoritative reload/i,
    '信任边界': /loopback[\s\S]{0,100}token[\s\S]{0,100}Origin[\s\S]{0,100}dirfd[\s\S]{0,100}fingerprint/i,
  });
});
