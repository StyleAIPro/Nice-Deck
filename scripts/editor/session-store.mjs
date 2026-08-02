import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, parse } from 'node:path';

export class RevisionConflict extends Error {}

const sha256 = data => createHash('sha256').update(data).digest('hex');
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
export const MAX_SNAPSHOT_BYTES = 512 * 1024;

function snapshotError(code, statusCode, message) {
  return Object.assign(new Error(message), { code, statusCode });
}

function decodeSnapshot(snapshot) {
  if (snapshot === undefined || snapshot === null) return null;
  if (typeof snapshot !== 'string') {
    throw snapshotError('INVALID_SNAPSHOT', 400, 'snapshot 必须为 PNG data URL 或 null');
  }
  const match = snapshot.match(/^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})$/);
  if (!match || match[1].length % 4 !== 0) {
    throw snapshotError('INVALID_SNAPSHOT', 400, 'snapshot 不是有效的 PNG base64');
  }
  const bytes = Buffer.from(match[1], 'base64');
  if (bytes.toString('base64') !== match[1]
    || bytes.length < PNG_SIGNATURE.length
    || !bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw snapshotError('INVALID_SNAPSHOT', 400, 'snapshot 缺少有效 PNG 签名');
  }
  if (bytes.length > MAX_SNAPSHOT_BYTES) {
    throw snapshotError('SNAPSHOT_TOO_LARGE', 413, `snapshot 不得超过 ${MAX_SNAPSHOT_BYTES} 字节`);
  }
  return bytes;
}

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
    const snapshotBytes = decodeSnapshot(input.snapshot);
    const now = new Date().toISOString();
    const id = randomUUID();
    const snapshotPath = snapshotBytes ? `snapshots/${id}.png` : null;
    const { snapshot: _snapshot, snapshotPath: _snapshotPath, ...taskInput } = input;
    const task = {
      ...taskInput,
      id,
      status: 'pending',
      candidates: input.candidates ?? [],
      snapshotPath,
      createdAt: now,
      updatedAt: now,
    };
    const temporarySnapshotPath = snapshotBytes
      ? join(this.sessionDir, 'snapshots', `.${id}.${randomUUID()}.tmp`)
      : null;
    const finalSnapshotPath = snapshotPath ? join(this.sessionDir, snapshotPath) : null;
    const previousRevision = this.state.revision;
    const previousTasks = structuredClone(this.state.tasks);
    try {
      if (snapshotBytes) {
        await writeFile(temporarySnapshotPath, snapshotBytes);
        await rename(temporarySnapshotPath, finalSnapshotPath);
      }
      this.state.tasks.push(task);
      this.state.revision += 1;
      await this.#persist();
      return { task, revision: this.state.revision };
    } catch (error) {
      this.state.revision = previousRevision;
      this.state.tasks = previousTasks;
      await Promise.all([
        temporarySnapshotPath ? unlink(temporarySnapshotPath).catch(() => {}) : undefined,
        finalSnapshotPath ? unlink(finalSnapshotPath).catch(() => {}) : undefined,
        unlink(`${this.sessionPath}.tmp`).catch(() => {}),
      ]);
      throw error;
    }
  }
}
