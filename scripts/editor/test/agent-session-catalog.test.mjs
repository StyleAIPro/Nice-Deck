import test from 'node:test';
import assert from 'node:assert/strict';
import {
  containsSkillEvidence, createAgentSessionCatalog,
} from '../agent-session-catalog.mjs';

test('会话目录隔离不可用 provider、按时间排序并只读检测 Skill 证据', async () => {
  const catalog = createAgentSessionCatalog({
    adapters:[
      {
        id:'codex', name:'Codex',
        async list() {
          return [{ provider:'codex', id:'new', updatedAt:'2026-08-04T02:00:00Z' }];
        },
        async inspectSkill(sessionId) {
          assert.equal(sessionId, 'new');
          return 'detected';
        },
      },
      {
        id:'opencode', name:'OpenCode',
        async list() { throw Object.assign(new Error('missing'), { code:'AGENT_NOT_INSTALLED' }); },
      },
    ],
  });

  const result = await catalog.list();
  assert.equal(result.sessions[0].id, 'new');
  assert.deepEqual(result.providers.map(provider => provider.available), [true, false]);
  assert.equal((await catalog.inspectSkill('codex', 'new')).skillStatus, 'detected');
  assert.equal(containsSkillEvidence('先使用 $huawei-deck 再修改'), true);
});
