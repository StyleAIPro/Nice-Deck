import assert from 'node:assert/strict';
import { copyFile, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import test from 'node:test';

import { WorkCatalog } from '../work-catalog.mjs';
import { openDeckBinding } from '../deck-binding-coordinator.mjs';

function sequence(values) {
  let index = 0;
  return () => values[index++];
}

test('旧编辑记录迁移为稳定工作项，修改显示名称不修改 Deck 文件', async t => {
  const root = await mkdtemp(join(tmpdir(), 'deck-work-catalog-'));
  t.after(() => rm(root, { recursive:true, force:true }));
  const deckPath = join(root, '技术解析.html');
  const original = '<!doctype html><title>技术解析</title>';
  await writeFile(deckPath, original);
  const legacy = {
    async list() {
      return {
        version:1,
        creation:[],
        editing:[{
          deckPath,
          deckName:basename(deckPath),
          directory:root,
          modifiedAt:'2026-08-16T08:00:00.000Z',
          lastOpenedAt:'2026-08-16T07:00:00.000Z',
          provider:'codex',
          progress:'继续编辑',
        }],
      };
    },
  };
  const catalog = new WorkCatalog({
    filePath:join(root, 'work-catalog.json'),
    legacyHistory:legacy,
    randomUUID:sequence([
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
    ]),
  });

  const first = (await catalog.list()).editing[0];
  assert.equal(first.workId, '11111111-1111-4111-8111-111111111111');
  assert.equal(first.deckId, '22222222-2222-4222-8222-222222222222');
  assert.equal(first.displayName, '技术解析.html');
  assert.equal(first.nameSource, 'auto');
  assert.equal(first.binding.state, 'bound');

  const renamed = await catalog.rename({
    workId:first.workId,
    displayName:'昇腾课程最终版',
    expectedRevision:first.revision,
  });
  assert.equal(renamed.displayName, '昇腾课程最终版');
  assert.equal(renamed.nameSource, 'custom');
  assert.equal(await readFile(deckPath, 'utf8'), original);

  const reopened = new WorkCatalog({
    filePath:join(root, 'work-catalog.json'),
    legacyHistory:{ async list() { return { version:1, creation:[], editing:[] }; } },
    randomUUID:() => assert.fail('重新打开不应生成新身份'),
  });
  const persisted = (await reopened.list()).editing[0];
  assert.equal(persisted.workId, first.workId);
  assert.equal(persisted.deckId, first.deckId);
  assert.equal(persisted.displayName, '昇腾课程最终版');
});

test('创建工作项在左上角改名后不再被 Brief 标题覆盖', async t => {
  const root = await mkdtemp(join(tmpdir(), 'deck-work-catalog-creation-'));
  t.after(() => rm(root, { recursive:true, force:true }));
  let title = '未命名 Deck';
  const legacyHistory = {
    async list() {
      return {
        version:1,
        editing:[],
        creation:[{
          kind:'creation',
          draftId:'draft-creation',
          projectRoot:root,
          title,
          progress:'需求沟通中',
          provider:'codex',
          updatedAt:'2026-08-16T09:00:00.000Z',
        }],
      };
    },
  };
  const catalog = new WorkCatalog({
    filePath:join(root, 'work-catalog.json'),
    legacyHistory,
    randomUUID:sequence(['33333333-3333-4333-8333-333333333333']),
  });

  const first = (await catalog.list()).creation[0];
  assert.equal(first.workId, '33333333-3333-4333-8333-333333333333');
  assert.equal(first.displayName, '未命名 Deck');
  assert.equal(first.nameSource, 'auto');

  const renamed = await catalog.rename({
    workId:first.workId,
    displayName:'客户评审版',
    expectedRevision:first.revision,
  });
  assert.equal(renamed.displayName, '客户评审版');
  assert.equal(renamed.nameSource, 'custom');

  title = 'Brief 已经改名';
  const listed = (await catalog.list()).creation[0];
  assert.equal(listed.displayName, '客户评审版');
  assert.equal(listed.title, '客户评审版');
  assert.equal(listed.briefTitle, 'Brief 已经改名');
});

test('创建工作项的其他窗口状态只反映当前活锁，不能持久化陈旧锁', async t => {
  const root = await mkdtemp(join(tmpdir(), 'deck-work-catalog-live-lock-'));
  t.after(() => rm(root, { recursive:true, force:true }));
  let active = true;
  const legacyHistory = {
    async list() {
      return {
        version:1,
        editing:[],
        creation:active ? [{
          kind:'creation',
          draftId:'draft-live-lock',
          projectRoot:root,
          title:'锁状态测试',
          progress:'等待开始对话',
          provider:'codex',
          updatedAt:'2026-08-16T09:00:00.000Z',
          locked:true,
        }] : [],
      };
    },
  };
  const catalog = new WorkCatalog({
    filePath:join(root, 'work-catalog.json'),
    legacyHistory,
  });

  assert.equal((await catalog.list()).creation[0].locked, true);
  active = false;
  assert.equal((await catalog.list()).creation[0].locked, false);

  const persisted = JSON.parse(await readFile(join(root, 'work-catalog.json'), 'utf8'));
  assert.equal(persisted.workItems[0].locked, false);
});

test('删除工作项后即使旧历史仍存在也不会被重新导入', async t => {
  const root = await mkdtemp(join(tmpdir(), 'deck-work-catalog-dismiss-'));
  t.after(() => rm(root, { recursive:true, force:true }));
  const deckPath = join(root, 'legacy.html');
  await writeFile(deckPath, '<!doctype html>');
  const catalog = new WorkCatalog({
    filePath:join(root, 'catalog.json'),
    legacyHistory:{ async list() { return { version:1, creation:[], editing:[{ deckPath }] }; } },
  });

  const initial = await catalog.list();
  await catalog.dismiss({
    workId:initial.editing[0].workId,
    expectedRevision:initial.editing[0].revision,
  });

  assert.deepEqual((await catalog.list()).editing, []);
});

test('用户明确重新打开已隐藏的 Deck 时恢复原工作项身份和首页入口', async t => {
  const root = await mkdtemp(join(tmpdir(), 'deck-work-catalog-reopen-'));
  t.after(() => rm(root, { recursive:true, force:true }));
  const deckPath = join(root, '重新打开.html');
  await writeFile(deckPath, '<!doctype html>');
  const catalog = new WorkCatalog({
    filePath:join(root, 'catalog.json'),
    legacyHistory:{ async list() { return { version:1, creation:[], editing:[{ deckPath }] }; } },
  });

  const initial = (await catalog.list()).editing[0];
  await catalog.dismiss({
    workId:initial.workId,
    expectedRevision:initial.revision,
  });
  assert.deepEqual((await catalog.list()).editing, [], '普通历史同步不得复活已隐藏任务');

  const reopened = await catalog.reopenEditing({ deckPath });
  assert.equal(reopened.workId, initial.workId);
  assert.equal(reopened.deckId, initial.deckId);
  assert.equal(reopened.revision, initial.revision + 2);

  const history = await catalog.list();
  assert.equal(history.editing.length, 1);
  assert.equal(history.editing[0].workId, initial.workId);
});

test('Editor 关闭期间 Deck 被外部改名，任务以原 deckId 自动恢复到新路径', async t => {
  const root = await mkdtemp(join(tmpdir(), 'deck-work-catalog-rebind-'));
  t.after(() => rm(root, { recursive:true, force:true }));
  const oldPath = join(root, '旧文件名.html');
  const newPath = join(root, '新文件名.html');
  await writeFile(oldPath, '<!doctype html><title>不变身份</title>');
  const legacyHistory = {
    async list() {
      return { version:1, creation:[], editing:[{ deckPath:oldPath, projectRoot:root }] };
    },
  };
  const filePath = join(root, 'catalog.json');
  const firstCatalog = new WorkCatalog({ filePath, legacyHistory });
  const before = (await firstCatalog.list()).editing[0];
  await rename(oldPath, newPath);

  const reopened = new WorkCatalog({ filePath, legacyHistory });
  const history = await reopened.list();

  assert.equal(history.editing.length, 1);
  assert.equal(history.editing[0].deckId, before.deckId);
  assert.equal(history.editing[0].workId, before.workId);
  assert.equal(history.editing[0].deckPath, await realpath(newPath));
  assert.equal(history.editing[0].displayName, '新文件名.html');
  assert.equal(history.editing[0].binding.reason, 'renamed');
  assert.equal((await reopened.resolve(before.workId)).deckPath, await realpath(newPath));
});

test('可信固化更新后的文件见证持久化，重启不会把正常发布误判为 replaced', async t => {
  const root = await mkdtemp(join(tmpdir(), 'deck-work-catalog-published-'));
  t.after(() => rm(root, { recursive:true, force:true }));
  const deckPath = join(root, 'source.html');
  const replacement = join(root, 'replacement.html');
  await writeFile(deckPath, '<!doctype html><title>before</title>');
  const filePath = join(root, 'catalog.json');
  const legacyHistory = {
    async list() { return { version:1, creation:[], editing:[{ deckPath, projectRoot:root }] }; },
  };
  const catalog = new WorkCatalog({ filePath, legacyHistory });
  const before = (await catalog.list()).editing[0];
  await writeFile(replacement, '<!doctype html><title>after</title>');
  await rename(replacement, deckPath);
  const publishedBinding = await openDeckBinding({
    deckId:before.deckId,
    initialBinding:{ currentPath:deckPath, trustedRoot:root, revision:before.binding.revision },
    storageRoot:root,
    watch:false,
  });
  const snapshot = publishedBinding.snapshot();
  await publishedBinding.close();

  await catalog.updateEditingBinding({
    workId:before.workId,
    deckId:before.deckId,
    binding:snapshot,
  });

  const reopened = new WorkCatalog({ filePath, legacyHistory });
  const after = (await reopened.list()).editing[0];
  assert.equal(after.binding.state, 'bound');
  assert.deepEqual(after.binding.witness, snapshot.witness);
  assert.equal(after.binding.sourceFingerprint, snapshot.sourceFingerprint);
});

test('缺失源文件可由用户确认相同内容副本并保持原工作项和 Deck 身份', async t => {
  const root = await mkdtemp(join(tmpdir(), 'deck-work-catalog-manual-rebind-'));
  t.after(() => rm(root, { recursive:true, force:true }));
  const oldPath = join(root, 'old.html');
  const copyPath = join(root, 'copy.html');
  await writeFile(oldPath, '<!doctype html><title>copy</title>');
  const legacyHistory = {
    async list() { return { version:1, creation:[], editing:[{ deckPath:oldPath }] }; },
  };
  const catalog = new WorkCatalog({ filePath:join(root, 'catalog.json'), legacyHistory });
  const before = (await catalog.list()).editing[0];
  await copyFile(oldPath, copyPath);
  await rm(oldPath);
  const missing = (await catalog.list()).editing[0];
  assert.equal(missing.binding.state, 'needs-rebind');

  const rebound = await catalog.rebindEditing({
    workId:before.workId,
    candidatePath:copyPath,
    confirmation:'verified-copy',
    expectedBindingRevision:missing.binding.revision,
  });

  assert.equal(rebound.workId, before.workId);
  assert.equal(rebound.deckId, before.deckId);
  assert.equal(rebound.deckPath, await realpath(copyPath));
  assert.equal(rebound.binding.state, 'bound');
});

test('Creation 发布后原位转换为 Editing，并保留 workId、名称和 DSH 会话', async t => {
  const root = await mkdtemp(join(tmpdir(), 'deck-work-catalog-promote-'));
  t.after(() => rm(root, { recursive:true, force:true }));
  const deckPath = join(root, 'published.html');
  await writeFile(deckPath, '<!doctype html><title>published</title>');
  let creationActive = true;
  const legacyHistory = {
    async list() {
      return {
        version:1,
        creation:creationActive ? [{
          draftId:'draft-promote', projectRoot:root, title:'创建中的 Deck', provider:'codex',
        }] : [],
        editing:creationActive ? [] : [{ deckPath, projectRoot:root, provider:'codex' }],
      };
    },
  };
  const catalog = new WorkCatalog({
    filePath:join(root, 'catalog.json'),
    legacyHistory,
    randomUUID:sequence(['49111111-1111-4111-8111-111111111111']),
  });
  let creation = (await catalog.list()).creation[0];
  creation = await catalog.rename({
    workId:creation.workId,
    displayName:'客户评审主任务',
    expectedRevision:creation.revision,
  });
  const operationId = '49222222-2222-4222-8222-222222222222';
  await catalog.beginDshSessionProvision({
    workId:creation.workId,
    operationId,
    workspaceId:'workspace-project',
    sessionId:'session-project',
    origin:'fresh',
    expectedBindingRevision:creation.dshBinding.revision,
  });
  creation = await catalog.completeDshSessionProvision({ workId:creation.workId, operationId });

  const deckId = '49333333-3333-4333-8333-333333333333';
  const coordinator = await openDeckBinding({
    deckId,
    initialBinding:{
      revision:0, state:'bound', reason:'none', currentPath:deckPath,
      previousPath:null, trustedRoot:root,
    },
    storageRoot:root,
    watch:false,
  });
  const binding = coordinator.snapshot();
  await coordinator.close();
  creationActive = false;

  const promoted = await catalog.promoteCreationToEditing({
    workId:creation.workId,
    deckPath,
    deckId,
    binding,
    provider:'codex',
    projectRoot:root,
  });

  assert.equal(promoted.kind, 'editing');
  assert.equal(promoted.workId, creation.workId);
  assert.equal(promoted.deckId, deckId);
  assert.equal(promoted.displayName, '客户评审主任务');
  assert.equal(promoted.nameSource, 'custom');
  assert.equal(promoted.dshBinding.activeSessionId, 'session-project');
  assert.equal(promoted.dshBinding.sessions[0].sessionId, 'session-project');
  assert.equal((await catalog.resolveByDshSession('session-project')).kind, 'editing');
  const history = await catalog.list();
  assert.equal(history.creation.length, 0);
  assert.deepEqual(history.editing.map(item => item.workId), [creation.workId]);

  const retried = await catalog.promoteCreationToEditing({
    workId:creation.workId, deckPath, deckId, binding,
  });
  assert.equal(retried.revision, promoted.revision);
});

test('schema v2 原样迁移工作项身份并初始化空 DSH 关联，不猜测旧会话', async t => {
  const root = await mkdtemp(join(tmpdir(), 'deck-work-catalog-v2-'));
  t.after(() => rm(root, { recursive:true, force:true }));
  const deckPath = join(root, '迁移.html');
  const filePath = join(root, 'catalog.json');
  await writeFile(deckPath, '<!doctype html>');
  const seeded = new WorkCatalog({
    filePath,
    legacyHistory:{ async list() { return { version:1, creation:[], editing:[{ deckPath }] }; } },
    randomUUID:sequence([
      '41111111-1111-4111-8111-111111111111',
      '42222222-2222-4222-8222-222222222222',
    ]),
  });
  const before = (await seeded.list()).editing[0];
  const stored = JSON.parse(await readFile(filePath, 'utf8'));
  stored.version = 2;
  delete stored.workItems[0].dshBinding;
  await writeFile(filePath, JSON.stringify(stored, null, 2) + '\n');

  const reopened = new WorkCatalog({
    filePath,
    legacyHistory:{ async list() { return { version:1, creation:[], editing:[] }; } },
    randomUUID:() => assert.fail('迁移不得生成新的工作项身份'),
  });
  const after = (await reopened.list()).editing[0];

  assert.equal(after.workId, before.workId);
  assert.equal(after.deckId, before.deckId);
  assert.deepEqual(after.dshBinding, {
    revision:0,
    workspaceId:null,
    activeSessionId:null,
    sessions:[],
    pendingOperation:null,
  });
  assert.equal(JSON.parse(await readFile(filePath, 'utf8')).version, 3);
});

test('DSH 会话创建以 pending operation 固化，完成重试幂等并建立反向索引', async t => {
  const root = await mkdtemp(join(tmpdir(), 'deck-work-catalog-dsh-provision-'));
  t.after(() => rm(root, { recursive:true, force:true }));
  const deckPath = join(root, '关联.html');
  await writeFile(deckPath, '<!doctype html>');
  const catalog = new WorkCatalog({
    filePath:join(root, 'catalog.json'),
    legacyHistory:{ async list() { return { version:1, creation:[], editing:[{ deckPath }] }; } },
  });
  const workItem = (await catalog.list()).editing[0];
  const operationId = '43333333-3333-4333-8333-333333333333';

  const pending = await catalog.beginDshSessionProvision({
    workId:workItem.workId,
    operationId,
    workspaceId:'workspace-a',
    sessionId:'session-a',
    origin:'fresh',
    expectedBindingRevision:0,
  });
  assert.equal(pending.dshBinding.revision, 1);
  assert.equal(pending.dshBinding.activeSessionId, null);
  assert.equal(pending.dshBinding.pendingOperation.sessionId, 'session-a');

  const completed = await catalog.completeDshSessionProvision({
    workId:workItem.workId,
    operationId,
  });
  assert.equal(completed.dshBinding.revision, 2);
  assert.equal(completed.dshBinding.activeSessionId, 'session-a');
  assert.equal(completed.dshBinding.pendingOperation, null);
  assert.deepEqual(completed.dshBinding.sessions[0], {
    operationId,
    sessionId:'session-a',
    workspaceId:'workspace-a',
    origin:'fresh',
    state:'available',
    createdAt:pending.dshBinding.pendingOperation.startedAt,
  });
  assert.equal((await catalog.resolveByDshSession('session-a')).workId, workItem.workId);

  const retried = await catalog.completeDshSessionProvision({
    workId:workItem.workId,
    operationId,
  });
  assert.equal(retried.revision, completed.revision);
  assert.equal(retried.dshBinding.sessions.length, 1);
});

test('一个 DSH 会话不能关联两个 Work Item', async t => {
  const root = await mkdtemp(join(tmpdir(), 'deck-work-catalog-dsh-unique-'));
  t.after(() => rm(root, { recursive:true, force:true }));
  const firstPath = join(root, 'first.html');
  const secondPath = join(root, 'second.html');
  await writeFile(firstPath, '<!doctype html>');
  await writeFile(secondPath, '<!doctype html>');
  const catalog = new WorkCatalog({
    filePath:join(root, 'catalog.json'),
    legacyHistory:{
      async list() {
        return { version:1, creation:[], editing:[{ deckPath:firstPath }, { deckPath:secondPath }] };
      },
    },
  });
  const [first, second] = (await catalog.list()).editing;
  await catalog.beginDshSessionProvision({
    workId:first.workId,
    operationId:'44444444-4444-4444-8444-444444444444',
    workspaceId:'workspace-shared',
    sessionId:'session-unique',
    origin:'fresh',
    expectedBindingRevision:0,
  });
  await catalog.completeDshSessionProvision({
    workId:first.workId,
    operationId:'44444444-4444-4444-8444-444444444444',
  });

  await assert.rejects(() => catalog.beginDshSessionProvision({
    workId:second.workId,
    operationId:'45555555-5555-4555-8555-555555555555',
    workspaceId:'workspace-shared',
    sessionId:'session-unique',
    origin:'adopted',
    expectedBindingRevision:0,
  }), error => error.code === 'DSH_SESSION_ALREADY_LINKED'
    && error.ownerWorkId === first.workId);
});

test('DSH 归档会话持久化为不可用关联，活动指针与反向导航同步清理', async t => {
  const root = await mkdtemp(join(tmpdir(), 'deck-work-catalog-dsh-archive-'));
  t.after(() => rm(root, { recursive:true, force:true }));
  const deckPath = join(root, '归档.html');
  await writeFile(deckPath, '<!doctype html>');
  const catalog = new WorkCatalog({
    filePath:join(root, 'catalog.json'),
    legacyHistory:{ async list() { return { version:1, creation:[], editing:[{ deckPath }] }; } },
  });
  let current = (await catalog.list()).editing[0];
  for (const [operationId, sessionId] of [
    ['45111111-1111-4111-8111-111111111111', 'session-a'],
    ['45222222-2222-4222-8222-222222222222', 'session-b'],
  ]) {
    current = await catalog.beginDshSessionProvision({
      workId:current.workId,
      operationId,
      workspaceId:'workspace-a',
      sessionId,
      origin:'fresh',
      expectedBindingRevision:current.dshBinding.revision,
    });
    current = await catalog.completeDshSessionProvision({
      workId:current.workId,
      operationId,
    });
  }
  assert.equal(current.dshBinding.activeSessionId, 'session-b');

  const archivedInactive = await catalog.archiveDshSessions({
    workId:current.workId,
    sessionIds:['session-a'],
    expectedBindingRevision:current.dshBinding.revision,
  });
  assert.equal(archivedInactive.dshBinding.sessions[0].state, 'archived');
  assert.equal(archivedInactive.dshBinding.activeSessionId, 'session-b');
  assert.equal(await catalog.resolveByDshSession('session-a'), null);

  const archivedActive = await catalog.archiveDshSessions({
    workId:current.workId,
    sessionIds:['session-b'],
    expectedBindingRevision:archivedInactive.dshBinding.revision,
  });
  assert.equal(archivedActive.dshBinding.sessions[1].state, 'archived');
  assert.equal(archivedActive.dshBinding.activeSessionId, null);
  assert.equal(await catalog.resolveByDshSession('session-b'), null);

  const retried = await catalog.archiveDshSessions({
    workId:current.workId,
    sessionIds:['session-b'],
    expectedBindingRevision:current.dshBinding.revision,
  });
  assert.equal(retried.dshBinding.revision, archivedActive.dshBinding.revision,
    '重复归档必须幂等，不能因旧 revision 报错或重复写入');
});

test('更换 DSH Workspace 会历史化旧会话并清除活动指针', async t => {
  const root = await mkdtemp(join(tmpdir(), 'deck-work-catalog-dsh-workspace-'));
  t.after(() => rm(root, { recursive:true, force:true }));
  const deckPath = join(root, '换目录.html');
  await writeFile(deckPath, '<!doctype html>');
  const catalog = new WorkCatalog({
    filePath:join(root, 'catalog.json'),
    legacyHistory:{ async list() { return { version:1, creation:[], editing:[{ deckPath }] }; } },
  });
  const initial = (await catalog.list()).editing[0];
  await catalog.beginDshSessionProvision({
    workId:initial.workId,
    operationId:'46666666-6666-4666-8666-666666666666',
    workspaceId:'workspace-old',
    sessionId:'session-old',
    origin:'fresh',
    expectedBindingRevision:0,
  });
  const linked = await catalog.completeDshSessionProvision({
    workId:initial.workId,
    operationId:'46666666-6666-4666-8666-666666666666',
  });

  const moved = await catalog.setDshWorkspace({
    workId:initial.workId,
    workspaceId:'workspace-new',
    expectedBindingRevision:linked.dshBinding.revision,
  });
  assert.equal(moved.dshBinding.workspaceId, 'workspace-new');
  assert.equal(moved.dshBinding.activeSessionId, null);
  assert.equal(moved.dshBinding.sessions[0].state, 'historical');

  await assert.rejects(() => catalog.activateDshSession({
    workId:initial.workId,
    sessionId:'session-old',
    expectedBindingRevision:moved.dshBinding.revision,
  }), error => error.code === 'DSH_SESSION_NOT_AVAILABLE');
});

test('明确失败只清除对应 pending，不改变原活动会话', async t => {
  const root = await mkdtemp(join(tmpdir(), 'deck-work-catalog-dsh-fail-'));
  t.after(() => rm(root, { recursive:true, force:true }));
  const deckPath = join(root, '失败恢复.html');
  await writeFile(deckPath, '<!doctype html>');
  const catalog = new WorkCatalog({
    filePath:join(root, 'catalog.json'),
    legacyHistory:{ async list() { return { version:1, creation:[], editing:[{ deckPath }] }; } },
  });
  const initial = (await catalog.list()).editing[0];
  await catalog.beginDshSessionProvision({
    workId:initial.workId,
    operationId:'47777777-7777-4777-8777-777777777777',
    workspaceId:'workspace-a',
    sessionId:'session-a',
    origin:'fresh',
    expectedBindingRevision:0,
  });
  const first = await catalog.completeDshSessionProvision({
    workId:initial.workId,
    operationId:'47777777-7777-4777-8777-777777777777',
  });
  const pending = await catalog.beginDshSessionProvision({
    workId:initial.workId,
    operationId:'48888888-8888-4888-8888-888888888888',
    workspaceId:'workspace-a',
    sessionId:'session-b',
    origin:'fresh',
    expectedBindingRevision:first.dshBinding.revision,
  });

  const recovered = await catalog.failDshSessionProvision({
    workId:initial.workId,
    operationId:'48888888-8888-4888-8888-888888888888',
    expectedBindingRevision:pending.dshBinding.revision,
  });
  assert.equal(recovered.dshBinding.activeSessionId, 'session-a');
  assert.equal(recovered.dshBinding.pendingOperation, null);
  assert.equal(recovered.dshBinding.sessions.length, 1);
});
