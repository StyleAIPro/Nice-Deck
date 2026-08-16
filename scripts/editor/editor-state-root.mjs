import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const STATE_ROOT_ENV = 'HUAWEI_DECK_EDITOR_STATE_ROOT';

export function resolveEditorStateRoot({
  environment = process.env,
  homeDirectory = homedir(),
  processId = process.pid,
} = {}) {
  const override = environment?.[STATE_ROOT_ENV];
  if (typeof override === 'string' && override.trim()) return resolve(override);
  if (environment?.NODE_TEST_CONTEXT) {
    return join(tmpdir(), `huawei-deck-editor-tests-${processId}`);
  }
  return join(resolve(homeDirectory), '.huawei-deck-editor');
}
