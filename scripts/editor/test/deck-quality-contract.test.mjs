import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildSkillContractInstructions,
  coreQualityRules,
} from '../deck-quality-contract.mjs';

test('所有入口原样复用同一质量契约且 phase 不产生分支', () => {
  const expected = buildSkillContractInstructions({ skillRoot:'/skill' });
  for (const phase of ['新建', '初版制作', '编辑', '区域任务']) {
    assert.deepEqual(
      buildSkillContractInstructions({ skillRoot:'/skill', phase }),
      expected,
      `${phase} 不得产生另一份质量规范`,
    );
  }
  const prompt = expected.join('\n');
  assert.match(prompt, /Huawei Deck 单一作业规范/);
  assert.match(prompt, /不得按“新建 \/ 初版制作 \/ 修改 \/ 区域任务”切换、删减或降级质量要求/);
  assert.match(prompt, /所有入口原样复用以下单一质量契约/);
  assert.doesNotMatch(prompt, /当前属于 Huawei Deck .*流程/);
});

test('统一质量规则同时覆盖已有外壳与目录结构修改', () => {
  const rules = coreQualityRules().join('\n');
  assert.match(rules, /已有 Deck 默认继承现有外壳/);
  assert.match(rules, /修改涉及章数、章名、章节目标、页序、目录 DOM 或目录动画/);
  assert.match(rules, /无关修改则保持目录结构不变/);
});
