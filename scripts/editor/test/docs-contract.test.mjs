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
    '任务接口同时列出 list detail create': /tasks[^。\n]{0,80}`GET \/api\/tasks`[^。\n]{0,80}`GET \/api\/tasks\/<TASK_ID>`[^。\n]{0,80}`POST \/api\/tasks`/,
  });
});

test('四份文档准确区分 Agent HTTP、observer WS、editor capability 与写回职责', async () => {
  const documents = await loadDocuments();
  for (const [file, contents] of Object.entries(documents)) {
    requireClaims(file, contents, {
      'Agent 读取 session/status': /外部 (?:Codex|Claude Code|Agent)[\s\S]{0,260}\/api\/session/,
      'Agent 读取 tasks': /外部 (?:Codex|Claude Code|Agent)[\s\S]{0,360}\/api\/tasks/,
      'Agent 提交 actions': /外部 (?:Codex|Claude Code|Agent)[\s\S]{0,460}\/api\/actions/,
      'Agent undo/redo': /\/api\/groups\/<GROUP_ID>\/(?:undo|redo)[\s\S]{0,160}(?:undo|redo)/i,
      'Agent 正式写回': /\/api\/write-deck/,
      'observer WS 只订阅 events': /observer WebSocket[\s\S]{0,100}\/events[\s\S]{0,100}(?:只|仅)[^。\n]{0,40}(?:订阅|接收)/i,
      '唯一 editor capability 只传 frame 事务 ACK': /唯一 editor capability WebSocket[\s\S]{0,160}frame[\s\S]{0,100}(?:事务|命令)[\s\S]{0,80}ACK[\s\S]{0,100}(?:不对外|不能用于|不用于)[^。\n]{0,40}(?:提交|动作)/i,
      'edit-bundle 只操作系统临时工作副本': /scripts\/edit-bundle\.py[\s\S]{0,120}(?:仅|只)[\s\S]{0,80}系统临时工作副本[\s\S]{0,160}load[\s\S]{0,80}get_template[\s\S]{0,80}set_template[\s\S]{0,80}save[\s\S]{0,80}(?:eb\.verify|verify)/,
      'adapter writer 负责持久写回': /bundle adapter \/ writer[\s\S]{0,180}sidecar 备份[\s\S]{0,120}同目录候选[\s\S]{0,120}transaction[\s\S]{0,120}fingerprint[\s\S]{0,120}os\.replace[\s\S]{0,120}恢复/i,
    });
    assert.doesNotMatch(
      contents,
      /外部 (?:Codex|Claude Code|Agent)[^。\n]{0,180}(?:WebSocket|capability WS)[^。\n]{0,120}(?:提交动作|提交 actions)/i,
      `${file} 错误宣称外部 Agent 可经 WebSocket 提交动作`,
    );
    assert.doesNotMatch(
      contents,
      /scripts\/edit-bundle\.py[^；。\n]{0,160}(?:处理|生成|创建|负责)[^；。\n]{0,100}(?:备份|transaction|原子替换|os\.replace)/,
      `${file} 错误把持久备份或原子替换归给 edit-bundle.py`,
    );
  }
});

test('editing guide 准确说明 drawer 撤销且不承诺缩略图', async () => {
  const documents = await loadDocuments();
  const guide = documents['references/editing-guide.md'];
  requireClaims('references/editing-guide.md', guide, {
    '左栏是文字页序列表和 badge': /左侧文字页序列表[\s\S]{0,100}badge/,
    'drawer 可撤销已完成任务': /drawer[\s\S]{0,180}已完成[\s\S]{0,100}撤销/,
    'undo 由 CLI 或 HTTP 完成': /undo[\s\S]{0,100}(?:CLI|HTTP)/i,
    'redo 由 HTTP 完成': /redo[\s\S]{0,100}HTTP/i,
  });
  assert.doesNotMatch(guide, /页缩略图/, 'references/editing-guide.md 左栏不是页缩略图');
});

test('四份入口文档与 steps 无动画页行为一致', async () => {
  const documents = await loadDocuments();
  for (const [file, contents] of Object.entries(documents)) {
    assert.doesNotMatch(
      contents,
      /无动画页[^。\n]{0,100}(?:生成|得到|输出)[^。\n]{0,80}(?:起始|开始)[^。\n]{0,40}(?:结束|末尾)[^。\n]{0,20}(?:两帧|2\s*帧)/,
      `${file} 不得声称 steps.mjs 为无动画页生成两帧`,
    );
    requireClaims(file, contents, {
      '无动画页明确不生成逐拍截图': /无动画页[^。\n]{0,120}(?:不生成|不会生成|不输出)[^。\n]{0,80}(?:逐拍)?截图/,
    });
  }
});

test('四份入口文档完整说明全局历史与任务附件边界', async () => {
  const documents = await loadDocuments();
  for (const [file, contents] of Object.entries(documents)) {
    requireClaims(file, contents, {
      '顶栏全局撤销重做': /顶栏[\s\S]{0,120}撤销[\s\S]{0,40}重做/,
      '人工与 Agent 共用权威历史': /人工文字[\s\S]{0,80}移动[\s\S]{0,80}缩放[\s\S]{0,120}Agent[^。\n]{0,80}(?:动作组|group)/i,
      '任务行定点撤销': /任务行[\s\S]{0,80}定点撤销/,
      '文件与粘贴入口': /选择文件[\s\S]{0,100}粘贴图片/,
      '附件数量与大小限制': /最多 8 个[\s\S]{0,100}25 MiB/,
      '粘贴图片转 PNG': /粘贴图片[\s\S]{0,80}(?:转为|转换为|转成) PNG/,
      'sidecar 附件目录': /sidecar[\s\S]{0,160}attachments\//,
      '浏览器不提供原绝对路径': /浏览器[\s\S]{0,100}(?:无法|不能)[^。\n]{0,50}原文件[^。\n]{0,30}绝对路径/,
      '任务列表与详情派生副本绝对路径': /GET \/api\/tasks[\s\S]{0,80}GET \/api\/tasks\/<TASK_ID>[\s\S]{0,220}副本[^。\n]{0,50}绝对 (?:path|路径)/i,
      '创建和事件任务 payload 派生绝对路径': /POST \/api\/tasks[\s\S]{0,160}task-created[\s\S]{0,80}task-updated[\s\S]{0,180}绝对 (?:path|路径)/i,
      'CLI tasks task 派生绝对路径': /CLI[\s\S]{0,100}`tasks`[\s\S]{0,40}`task`[\s\S]{0,140}绝对 (?:path|路径)/i,
      'session API 与磁盘只含相对路径': /GET \/api\/session[\s\S]{0,120}session\.json[\s\S]{0,100}relativePath[\s\S]{0,120}(?:不保存|不会保存)[\s\S]{0,40}(?:不返回|不会返回)[^。\n]{0,40}绝对路径/i,
      '附件不进入成品': /附件[^。\n]{0,100}不进入最终 deck/i,
      '附件随 sidecar 生命周期管理': /附件[^。\n]{0,120}sidecar[^。\n]{0,80}生命周期/,
    });
  }
});

test('架构文档列出附件 sidecar 目录与可信 dirfd 生命周期', async () => {
  const documents = await loadDocuments();
  requireClaims('docs/architecture.md', documents['docs/architecture.md'], {
    '正式附件目录': /attachments\//,
    '附件暂存目录': /attachments\/\.staging/,
    '附件目录 dirfd 生命周期': /attachments\/[\s\S]{0,180}dirfd[\s\S]{0,180}(?:绑定|生命周期)[\s\S]{0,180}(?:关闭|释放)/,
  });
});

test('浏览器 E2E 使用单并发串行执行', async () => {
  const packageJson = JSON.parse(await readFile(new URL('../../../package.json', import.meta.url), 'utf8'));
  assert.equal(
    packageJson.scripts['test:editor:e2e'],
    'node --test --test-concurrency=1 scripts/editor/test/*.e2e.mjs',
  );
});
