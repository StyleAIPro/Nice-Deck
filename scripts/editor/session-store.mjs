import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { basename, dirname, join, parse } from 'node:path';
import { localDurableIO } from './sidecar-io.mjs';

export class RevisionConflict extends Error {}

const sha256 = data => createHash('sha256').update(data).digest('hex');
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
export const MAX_SNAPSHOT_BYTES = 512 * 1024;

function snapshotError(code, statusCode, message) {
  return Object.assign(new Error(message), { code, statusCode });
}

const isCommittedSession = error => error?.committed === true
  && error?.commitScope === 'session';
const isCommittedSnapshot = error => error?.committed === true
  && error?.commitScope === 'snapshot';

function compensatedSnapshotError(error) {
  return Object.assign(new Error(error?.message ?? 'snapshot 持久化失败'), {
    code:typeof error?.code === 'string' && error.code.startsWith('SNAPSHOT_')
      ? error.code : 'SNAPSHOT_WRITE_FAILED',
    statusCode:Number.isInteger(error?.statusCode) ? error.statusCode : 500,
    stage:error?.stage ?? 'snapshot-write',
    committed:false,
    commitScope:'snapshot',
    compensated:true,
    cause:error,
  });
}

function snapshotRecoveryError(writeError, compensationError) {
  return Object.assign(new Error('snapshot 已发布但补偿删除失败，需要重启服务恢复'), {
    code:'SNAPSHOT_RECOVERY_REQUIRED',
    statusCode:503,
    stage:'snapshot-compensation',
    committed:false,
    commitScope:'snapshot',
    sessionCandidateCommitted:false,
    cause:compensationError,
    writeError,
  });
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
  static async open({
    deckPath,
    rootDir = join(dirname(deckPath), '.huawei-deck-editor'),
    sessionDir: selectedSessionDir,
    sidecarGuard = async () => {},
    sidecarIO = localDurableIO,
    directoriesPrepared = false,
    deckFingerprint: selectedDeckFingerprint,
    sessionId: selectedSessionId,
    persistedState,
  }) {
    await sidecarGuard();
    const deckFingerprint = selectedDeckFingerprint ?? sha256(await readFile(deckPath));
    const sessionDir = selectedSessionDir
      ?? join(rootDir, `${parse(deckPath).name}-${deckFingerprint.slice(0, 8)}`);
    if (!directoriesPrepared) {
      await sidecarGuard();
      await mkdir(join(sessionDir, 'snapshots'), { recursive: true });
      await mkdir(join(sessionDir, 'backups'), { recursive: true });
    }

    let persisted = persistedState;
    if (persisted === undefined) {
      try {
        persisted = JSON.parse((await readFile(join(sessionDir, 'session.json'))).toString('utf8'));
      } catch {
        persisted = null;
      }
    }
    const sessionId = selectedSessionId ?? persisted?.sessionId ?? randomUUID();
    const store = new SessionStore(
      deckPath, deckFingerprint, sessionDir, sidecarGuard, sidecarIO, sessionId,
    );
    const applyPersisted = persisted => {
      if (persisted.sessionId !== undefined && persisted.sessionId !== sessionId) {
        throw new Error('session.json 的 sessionId 与 registry 不一致');
      }
      if (persisted.deckPath !== undefined && persisted.deckPath !== deckPath) {
        throw new Error('session.json 的 deckPath 与当前 Deck 不一致');
      }
      store.state = {
        ...store.state,
        ...persisted,
        deckPath,
        sessionId,
        tasks:Array.isArray(persisted.tasks) ? persisted.tasks : [],
        groups:Array.isArray(persisted.groups) ? persisted.groups : [],
        redo:Array.isArray(persisted.redo) ? persisted.redo : [],
        diagnosticsBaseline:persisted.diagnosticsBaseline ?? {},
        diagnosticsCurrent:persisted.diagnosticsCurrent ?? {},
        conflict:persisted.conflict ?? null,
      };
    };
    await sidecarGuard();
    if (persisted === null) await store.#persist();
    else applyPersisted(persisted);
    return store;
  }

  constructor(
    deckPath,
    deckFingerprint,
    sessionDir,
    sidecarGuard = async () => {},
    sidecarIO = localDurableIO,
    sessionId = randomUUID(),
  ) {
    this.deckPath = deckPath;
    this.sessionDir = sessionDir;
    this.sessionPath = join(sessionDir, 'session.json');
    this.sidecarGuard = sidecarGuard;
    this.sidecarIO = sidecarIO;
    this.state = {
      version: 1,
      sessionId,
      deckPath,
      deckFingerprint,
      revision: 0,
      tasks: [],
      groups: [],
      redo: [],
      diagnosticsBaseline: {},
      diagnosticsCurrent: {},
      diagnosticsRevision: null,
      conflict: null,
    };
  }

  #expect(revision) {
    if (revision !== this.state.revision) {
      throw new RevisionConflict(`版本号 ${revision} 与当前版本 ${this.state.revision} 不一致`);
    }
  }

  async #persist(state = this.state) {
    await this.sidecarGuard();
    if (typeof this.sidecarIO.writeSession === 'function') {
      await this.sidecarIO.writeSession({
        sessionId:state.sessionId,
        bytes:Buffer.from(JSON.stringify(state, null, 2)),
      });
      return;
    }
    await this.sidecarIO.atomicWrite({
      directory:dirname(this.sessionPath),
      name:basename(this.sessionPath),
      bytes:Buffer.from(JSON.stringify(state, null, 2)),
      commitScope:'session',
    });
  }

  #publish(state) {
    const candidate = structuredClone(state);
    for (const key of Object.keys(this.state)) {
      if (!(key in candidate)) delete this.state[key];
    }
    Object.assign(this.state, candidate);
    return this.state;
  }

  async persistState(state = this.state) {
    const candidate = structuredClone(state);
    try {
      await this.#persist(candidate);
    } catch (error) {
      if (isCommittedSession(error)) this.#publish(candidate);
      throw error;
    }
    return this.#publish(candidate);
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
    const snapshotsDirectory = join(this.sessionDir, 'snapshots');
    const snapshotName = snapshotBytes ? `${id}.png` : null;
    const candidate = structuredClone(this.state);
    candidate.tasks.push(task);
    candidate.revision += 1;
    const cleanupSnapshot = () => {
      if (!snapshotName) return Promise.resolve();
      return typeof this.sidecarIO.deleteSnapshot === 'function'
        ? this.sidecarIO.deleteSnapshot({ snapshotId:id })
        : this.sidecarIO.unlink({
          directory:snapshotsDirectory, name:snapshotName, missingOk:true,
        });
    };
    if (snapshotBytes) {
      try {
        await this.sidecarGuard();
        if (typeof this.sidecarIO.writeSnapshot === 'function') {
          await this.sidecarIO.writeSnapshot({ snapshotId:id, bytes:snapshotBytes });
        } else {
          await this.sidecarIO.atomicWrite({
            directory:snapshotsDirectory,
            name:snapshotName,
            bytes:snapshotBytes,
            commitScope:'snapshot',
          });
        }
      } catch (error) {
        if (isCommittedSnapshot(error)) {
          try { await cleanupSnapshot(); }
          catch (cleanupError) { throw snapshotRecoveryError(error, cleanupError); }
          throw compensatedSnapshotError(error);
        }
        await cleanupSnapshot().catch(() => {});
        throw error;
      }
    }
    try {
      await this.persistState(candidate);
      return { task, revision: this.state.revision };
    } catch (error) {
      if (!isCommittedSession(error)) await cleanupSnapshot().catch(() => {});
      throw error;
    }
  }
}
