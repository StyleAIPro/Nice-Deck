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
