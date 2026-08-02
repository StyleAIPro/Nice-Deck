import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, parse } from 'node:path';

export class RevisionConflict extends Error {}

const sha256 = data => createHash('sha256').update(data).digest('hex');

export class SessionStore {
  static async open({ deckPath, rootDir = join(dirname(deckPath), '.huawei-deck-editor') }) {
    const bytes = await readFile(deckPath);
    const deckFingerprint = sha256(bytes);
    const sessionDir = join(rootDir, `${parse(deckPath).name}-${deckFingerprint.slice(0, 8)}`);
    await mkdir(join(sessionDir, 'snapshots'), { recursive: true });
    await mkdir(join(sessionDir, 'backups'), { recursive: true });

    const store = new SessionStore(deckPath, deckFingerprint, sessionDir);
    try {
      store.state = JSON.parse(await readFile(store.sessionPath, 'utf8'));
    } catch {
      await store.#persist();
    }
    return store;
  }

  constructor(deckPath, deckFingerprint, sessionDir) {
    this.deckPath = deckPath;
    this.sessionDir = sessionDir;
    this.sessionPath = join(sessionDir, 'session.json');
    this.state = {
      version: 1,
      deckPath,
      deckFingerprint,
      revision: 0,
      tasks: [],
      groups: [],
      redo: [],
    };
  }

  #expect(revision) {
    if (revision !== this.state.revision) {
      throw new RevisionConflict(`版本号 ${revision} 与当前版本 ${this.state.revision} 不一致`);
    }
  }

  async #persist() {
    const temporaryPath = `${this.sessionPath}.tmp`;
    await writeFile(temporaryPath, JSON.stringify(this.state, null, 2));
    await rename(temporaryPath, this.sessionPath);
  }

  async createTask(input, expectedRevision) {
    this.#expect(expectedRevision);
    const now = new Date().toISOString();
    const task = {
      ...input,
      id: randomUUID(),
      status: 'pending',
      candidates: input.candidates ?? [],
      snapshotPath: input.snapshotPath ?? null,
      createdAt: now,
      updatedAt: now,
    };
    this.state.tasks.push(task);
    this.state.revision += 1;
    await this.#persist();
    return { task, revision: this.state.revision };
  }
}
