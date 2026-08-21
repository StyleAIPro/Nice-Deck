import { randomUUID as systemRandomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { openDeckBinding } from './deck-binding-coordinator.mjs';
import { resolveEditorStateRoot } from './editor-state-root.mjs';

const SCHEMA_VERSION = 2;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function emptyState() {
  return { version:SCHEMA_VERSION, revision:0, workItems:[] };
}

function catalogError(code, statusCode, message, details = {}) {
  return Object.assign(new Error(message), { code, statusCode, ...details });
}

function requireUuid(value, label) {
  if (typeof value !== 'string' || !UUID_V4.test(value)) {
    throw catalogError('INVALID_WORK_IDENTITY', 500, label + ' 必须是规范 UUID v4');
  }
  return value;
}

function normalizeDisplayName(value) {
  if (typeof value !== 'string') {
    throw catalogError('INVALID_WORK_NAME', 400, '工作项名称必须是字符串');
  }
  const displayName = value.trim();
  if (!displayName || [...displayName].length > 80 || /[\u0000-\u001f\u007f]/u.test(displayName)) {
    throw catalogError('INVALID_WORK_NAME', 400, '工作项名称必须为 1–80 个字符且不能包含换行或控制字符');
  }
  return displayName;
}

function isDeckPath(value) {
  return typeof value === 'string' && ['.html', '.htm'].includes(extname(value).toLowerCase());
}

function editingKey(value) {
  return 'editing\0' + resolve(value);
}

function creationKey(projectRoot, draftId) {
  return 'creation\0' + resolve(projectRoot) + '\0' + draftId;
}

async function canonicalDeckPath(value) {
  try { return await realpath(value); }
  catch {
    const parent = await realpath(dirname(value)).catch(() => resolve(dirname(value)));
    return join(parent, basename(value));
  }
}

function publicEditing(item) {
  const path = item.binding.currentPath;
  return {
    kind:'editing',
    workId:item.workId,
    deckId:item.deckId,
    revision:item.revision,
    displayName:item.displayName,
    nameSource:item.nameSource,
    deckPath:path,
    deckName:basename(path),
    directory:dirname(path),
    modifiedAt:item.modifiedAt,
    lastOpenedAt:item.lastOpenedAt,
    provider:item.provider,
    progress:item.progress,
    projectRoot:item.projectRoot,
    runtimeState:item.runtimeState,
    binding:structuredClone(item.binding),
  };
}

function publicCreation(item) {
  return {
    kind:'creation',
    workId:item.workId,
    deckId:item.deckId,
    revision:item.revision,
    displayName:item.displayName,
    nameSource:item.nameSource,
    title:item.displayName,
    briefTitle:item.briefTitle,
    taskId:item.draftId,
    draftId:item.draftId,
    projectRoot:item.projectRoot,
    projectName:item.projectName,
    provider:item.provider,
    phase:item.phase,
    progress:item.progress,
    updatedAt:item.updatedAt,
    lastOpenedAt:item.lastOpenedAt,
    locked:item.locked,
    runtimeState:item.runtimeState,
  };
}

export class WorkCatalog {
  constructor({
    filePath = join(resolveEditorStateRoot(), 'work-catalog.json'),
    legacyHistory = { async list() { return { version:1, creation:[], editing:[] }; } },
    randomUUID = systemRandomUUID,
    now = () => new Date(),
  } = {}) {
    if (typeof legacyHistory?.list !== 'function') {
      throw new TypeError('legacyHistory 必须提供 list()');
    }
    if (typeof randomUUID !== 'function') throw new TypeError('randomUUID 必须是函数');
    this.filePath = filePath === null ? null : resolve(filePath);
    this.memoryState = this.filePath === null ? emptyState() : null;
    this.legacyHistory = legacyHistory;
    this.randomUUID = randomUUID;
    this.now = now;
    this.operations = Promise.resolve();
  }

  #enqueue(operation) {
    const result = this.operations.then(operation);
    this.operations = result.catch(() => {});
    return result;
  }

  async #read() {
    if (this.filePath === null) return structuredClone(this.memoryState);
    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf8'));
      if (parsed?.version !== SCHEMA_VERSION || !Array.isArray(parsed.workItems)) {
        return emptyState();
      }
      return parsed;
    } catch (error) {
      if (error?.code === 'ENOENT' || error instanceof SyntaxError) return emptyState();
      throw error;
    }
  }

  async #write(state) {
    if (this.filePath === null) {
      this.memoryState = structuredClone(state);
      return;
    }
    await mkdir(dirname(this.filePath), { recursive:true, mode:0o700 });
    const temporary = this.filePath + '.' + process.pid + '.' + systemRandomUUID() + '.tmp';
    try {
      await writeFile(temporary, JSON.stringify(state, null, 2) + '\n', {
        encoding:'utf8',
        mode:0o600,
      });
      await rename(temporary, this.filePath);
    } catch (error) {
      await unlink(temporary).catch(() => {});
      throw error;
    }
  }

  #newIdentity(label) {
    return requireUuid(this.randomUUID(), label);
  }

  async #newEditing(entry) {
    const canonicalPath = await canonicalDeckPath(entry.deckPath);
    const exists = await stat(canonicalPath).then(value => value.isFile()).catch(() => false);
    const fileName = basename(canonicalPath);
    const trustedRoot = await realpath(entry.projectRoot ?? dirname(canonicalPath))
      .catch(() => resolve(entry.projectRoot ?? dirname(canonicalPath)));
    const workId = this.#newIdentity('workId');
    const deckId = this.#newIdentity('deckId');
    let binding = {
      revision:0,
      state:exists ? 'bound' : 'needs-rebind',
      reason:exists ? 'none' : 'missing',
      currentPath:canonicalPath,
      previousPath:null,
      trustedRoot,
    };
    if (exists) {
      const coordinator = await openDeckBinding({
        deckId,
        initialBinding:binding,
        storageRoot:dirname(this.filePath ?? canonicalPath),
        watch:false,
      });
      const captured = coordinator.snapshot();
      await coordinator.close();
      const { canPublish, deckId:ignoredDeckId, ...capturedBinding } = captured;
      void canPublish;
      void ignoredDeckId;
      binding = capturedBinding;
    }
    return {
      workId,
      deckId,
      kind:'editing',
      revision:0,
      displayName:normalizeDisplayName(fileName || '未命名 Deck'),
      nameSource:'auto',
      provider:entry.provider ?? 'codex',
      modifiedAt:entry.modifiedAt ?? this.now().toISOString(),
      lastOpenedAt:entry.lastOpenedAt ?? null,
      progress:entry.progress ?? '继续编辑',
      projectRoot:entry.projectRoot ?? null,
      runtimeState:entry.runtimeState,
      hiddenAt:null,
      binding,
    };
  }

  #newCreation(entry) {
    const briefTitle = normalizeDisplayName(entry.title || '未命名 Deck');
    return {
      workId:this.#newIdentity('workId'),
      deckId:null,
      kind:'creation',
      revision:0,
      displayName:briefTitle,
      briefTitle,
      nameSource:'auto',
      draftId:entry.draftId,
      projectRoot:resolve(entry.projectRoot),
      projectName:entry.projectName ?? basename(entry.projectRoot),
      provider:entry.provider ?? 'codex',
      phase:entry.phase,
      progress:entry.progress ?? '等待开始对话',
      updatedAt:entry.updatedAt ?? this.now().toISOString(),
      lastOpenedAt:entry.lastOpenedAt ?? null,
      locked:Boolean(entry.locked),
      runtimeState:entry.runtimeState,
      hiddenAt:null,
    };
  }

  async #refreshEditing(item) {
    const currentPath = item.binding.currentPath;
    const exists = await stat(currentPath).then(value => value.isFile()).catch(() => false);
    if (!item.binding.witness && !exists) {
      if (item.binding.state === 'needs-rebind' && item.binding.reason === 'missing') return item;
      return {
        ...item,
        revision:item.revision + 1,
        binding:{
          ...item.binding,
          revision:item.binding.revision + 1,
          state:'needs-rebind',
          reason:'missing',
        },
      };
    }
    const coordinator = await openDeckBinding({
      deckId:item.deckId,
      initialBinding:item.binding,
      storageRoot:dirname(this.filePath ?? currentPath),
      watch:false,
    });
    const refreshed = await coordinator.reconcile({ cause:'resume' });
    await coordinator.close();
    const { canPublish, deckId, ...nextBinding } = refreshed;
    void canPublish;
    void deckId;
    const nextDisplayName = item.nameSource === 'auto'
      ? basename(nextBinding.currentPath) : item.displayName;
    if (JSON.stringify(item.binding) === JSON.stringify(nextBinding)
      && item.displayName === nextDisplayName) return item;
    return {
      ...item,
      revision:item.revision + 1,
      displayName:nextDisplayName,
      binding:nextBinding,
    };
  }

  async #listUnlocked() {
    const [persisted, legacy] = await Promise.all([this.#read(), this.legacyHistory.list()]);
    const items = persisted.workItems.map(item => structuredClone(item));
    let changed = false;
    for (const item of items) {
      if (item?.kind !== 'editing' || typeof item.binding?.currentPath !== 'string') continue;
      const canonical = await canonicalDeckPath(item.binding.currentPath);
      const canonicalRoot = await realpath(item.binding.trustedRoot)
        .catch(() => resolve(item.binding.trustedRoot));
      if (canonical !== item.binding.currentPath) {
        item.binding.currentPath = canonical;
        changed = true;
      }
      if (canonicalRoot !== item.binding.trustedRoot) {
        item.binding.trustedRoot = canonicalRoot;
        changed = true;
      }
    }
    const editingByPath = new Map(
      items.filter(item => item?.kind === 'editing')
        .flatMap(item => [item.binding.currentPath, item.binding.previousPath]
          .filter(Boolean).map(path => [editingKey(path), item])),
    );
    const creationByDraft = new Map(
      items.filter(item => item?.kind === 'creation')
        .map(item => [creationKey(item.projectRoot, item.draftId), item]),
    );
    const liveCreationKeys = new Set();
    for (const entry of Array.isArray(legacy?.creation) ? legacy.creation : []) {
      if (typeof entry?.projectRoot !== 'string' || typeof entry?.draftId !== 'string') continue;
      const key = creationKey(entry.projectRoot, entry.draftId);
      liveCreationKeys.add(key);
      const existing = creationByDraft.get(key);
      if (!existing) {
        const item = this.#newCreation(entry);
        items.push(item);
        creationByDraft.set(key, item);
        changed = true;
        continue;
      }
      const briefTitle = normalizeDisplayName(entry.title || '未命名 Deck');
      const nextDisplayName = existing.nameSource === 'auto' ? briefTitle : existing.displayName;
      const next = {
        ...existing,
        revision:existing.revision
          + (existing.briefTitle !== briefTitle || existing.displayName !== nextDisplayName ? 1 : 0),
        displayName:nextDisplayName,
        briefTitle,
        projectName:entry.projectName ?? existing.projectName,
        provider:entry.provider ?? existing.provider,
        phase:entry.phase,
        progress:entry.progress ?? existing.progress,
        updatedAt:entry.updatedAt ?? existing.updatedAt,
        lastOpenedAt:entry.lastOpenedAt ?? existing.lastOpenedAt,
        locked:Boolean(entry.locked),
        runtimeState:entry.runtimeState,
      };
      if (JSON.stringify(next) !== JSON.stringify(existing)) {
        const index = items.indexOf(existing);
        items[index] = next;
        creationByDraft.set(key, next);
        changed = true;
      }
    }
    for (const item of items) {
      if (item?.kind !== 'creation'
        || liveCreationKeys.has(creationKey(item.projectRoot, item.draftId))) continue;
      if (item.locked || item.runtimeState !== undefined) {
        item.locked = false;
        delete item.runtimeState;
        changed = true;
      }
    }
    for (const entry of Array.isArray(legacy?.editing) ? legacy.editing : []) {
      if (!isDeckPath(entry?.deckPath)) continue;
      const canonicalLegacyPath = await canonicalDeckPath(entry.deckPath);
      const key = editingKey(canonicalLegacyPath);
      const existing = editingByPath.get(key);
      if (existing) {
        existing.provider = entry.provider ?? existing.provider;
        existing.modifiedAt = entry.modifiedAt ?? existing.modifiedAt;
        existing.lastOpenedAt = entry.lastOpenedAt ?? existing.lastOpenedAt;
        existing.progress = entry.progress ?? existing.progress;
        existing.projectRoot = entry.projectRoot ?? existing.projectRoot;
        existing.runtimeState = entry.runtimeState;
        continue;
      }
      const item = await this.#newEditing({ ...entry, deckPath:canonicalLegacyPath });
      items.push(item);
      editingByPath.set(editingKey(item.binding.currentPath), item);
      changed = true;
    }
    for (let index = 0; index < items.length; index += 1) {
      if (items[index]?.kind !== 'editing') continue;
      const refreshed = await this.#refreshEditing(items[index]);
      if (refreshed !== items[index]) {
        items[index] = refreshed;
        changed = true;
      }
    }
    if (changed || JSON.stringify(items) !== JSON.stringify(persisted.workItems)) {
      await this.#write({
        version:SCHEMA_VERSION,
        revision:persisted.revision + 1,
        workItems:items,
      });
    }
    return {
      version:SCHEMA_VERSION,
      revision:changed ? persisted.revision + 1 : persisted.revision,
      creation:items.filter(item => item.kind === 'creation' && item.hiddenAt === null)
        .map(publicCreation),
      editing:items.filter(item => item.kind === 'editing' && item.hiddenAt === null)
        .map(publicEditing),
    };
  }

  list() {
    return this.#enqueue(() => this.#listUnlocked());
  }

  reopenEditing({ deckPath }) {
    return this.#enqueue(async () => {
      if (!isDeckPath(deckPath)) {
        throw catalogError('INVALID_DECK_PATH', 400, 'Deck 文件路径必须指向 HTML');
      }
      const canonicalPath = await canonicalDeckPath(deckPath);
      const state = await this.#read();
      const index = state.workItems.findIndex(item => (
        item?.kind === 'editing'
        && [item.binding?.currentPath, item.binding?.previousPath]
          .filter(Boolean)
          .some(path => editingKey(path) === editingKey(canonicalPath))
      ));
      if (index < 0) return null;
      const current = state.workItems[index];
      if (current.hiddenAt === null) return publicEditing(current);
      const next = {
        ...current,
        revision:current.revision + 1,
        hiddenAt:null,
      };
      await this.#write({
        ...state,
        revision:state.revision + 1,
        workItems:state.workItems.map((item, candidate) => candidate === index ? next : item),
      });
      return publicEditing(next);
    });
  }

  rename({ workId, displayName, expectedRevision }) {
    return this.#enqueue(async () => {
      requireUuid(workId, 'workId');
      displayName = normalizeDisplayName(displayName);
      const state = await this.#read();
      const index = state.workItems.findIndex(item => item?.workId === workId);
      if (index < 0) throw catalogError('WORK_ITEM_NOT_FOUND', 404, '工作项不存在');
      const current = state.workItems[index];
      if (current.revision !== expectedRevision) {
        throw catalogError('WORK_ITEM_REVISION_CONFLICT', 409, '工作项已更新，请刷新后重试', {
          revision:current.revision,
        });
      }
      const next = {
        ...current,
        revision:current.revision + 1,
        displayName,
        nameSource:'custom',
      };
      const workItems = state.workItems.map((item, candidate) => (
        candidate === index ? next : item
      ));
      await this.#write({
        ...state,
        revision:state.revision + 1,
        workItems,
      });
      return next.kind === 'editing' ? publicEditing(next) : publicCreation(next);
    });
  }

  dismiss({ workId, expectedRevision }) {
    return this.#enqueue(async () => {
      requireUuid(workId, 'workId');
      const state = await this.#read();
      const index = state.workItems.findIndex(item => item?.workId === workId);
      if (index < 0) throw catalogError('WORK_ITEM_NOT_FOUND', 404, '工作项不存在');
      const current = state.workItems[index];
      if (current.revision !== expectedRevision) {
        throw catalogError('WORK_ITEM_REVISION_CONFLICT', 409, '工作项已更新，请刷新后重试', {
          revision:current.revision,
        });
      }
      const next = {
        ...current,
        revision:current.revision + 1,
        hiddenAt:this.now().toISOString(),
      };
      await this.#write({
        ...state,
        revision:state.revision + 1,
        workItems:state.workItems.map((item, candidate) => candidate === index ? next : item),
      });
      return next.kind === 'editing' ? publicEditing(next) : publicCreation(next);
    });
  }

  updateEditingBinding({ workId, deckId, binding }) {
    return this.#enqueue(async () => {
      requireUuid(workId, 'workId');
      requireUuid(deckId, 'deckId');
      if (!binding || typeof binding !== 'object'
        || binding.deckId !== deckId
        || typeof binding.currentPath !== 'string'
        || typeof binding.trustedRoot !== 'string'
        || !binding.witness
        || typeof binding.sourceFingerprint !== 'string') {
        throw catalogError('INVALID_DECK_BINDING', 400, 'Deck 文件绑定格式无效');
      }
      const state = await this.#read();
      const index = state.workItems.findIndex(item => (
        item?.kind === 'editing' && item.workId === workId && item.deckId === deckId
      ));
      if (index < 0) throw catalogError('WORK_ITEM_NOT_FOUND', 404, '编辑工作项不存在');
      const current = state.workItems[index];
      const { canPublish, deckId:ignoredDeckId, ...storedBinding } = structuredClone(binding);
      void canPublish;
      void ignoredDeckId;
      if (JSON.stringify(current.binding) === JSON.stringify(storedBinding)) {
        return publicEditing(current);
      }
      const next = {
        ...current,
        revision:current.revision + 1,
        binding:storedBinding,
      };
      await this.#write({
        ...state,
        revision:state.revision + 1,
        workItems:state.workItems.map((item, candidate) => candidate === index ? next : item),
      });
      return publicEditing(next);
    });
  }

  rebindEditing({
    workId, candidatePath, confirmation, expectedBindingRevision,
  }) {
    return this.#enqueue(async () => {
      requireUuid(workId, 'workId');
      const state = await this.#read();
      const index = state.workItems.findIndex(item => (
        item?.kind === 'editing' && item.workId === workId && item.hiddenAt === null
      ));
      if (index < 0) throw catalogError('WORK_ITEM_NOT_FOUND', 404, '编辑工作项不存在');
      const current = state.workItems[index];
      const coordinator = await openDeckBinding({
        deckId:current.deckId,
        initialBinding:current.binding,
        storageRoot:dirname(this.filePath ?? current.binding.trustedRoot),
        watch:false,
      });
      let snapshot;
      try {
        const canonicalCandidate = await canonicalDeckPath(candidatePath);
        snapshot = await coordinator.rebind({
          candidatePath:canonicalCandidate,
          expectedBindingRevision,
          confirmation,
        });
      } finally {
        await coordinator.close();
      }
      const { canPublish, deckId, ...storedBinding } = snapshot;
      void canPublish;
      void deckId;
      const next = {
        ...current,
        revision:current.revision + 1,
        displayName:current.nameSource === 'auto'
          ? basename(storedBinding.currentPath) : current.displayName,
        binding:storedBinding,
      };
      await this.#write({
        ...state,
        revision:state.revision + 1,
        workItems:state.workItems.map((item, candidate) => candidate === index ? next : item),
      });
      return publicEditing(next);
    });
  }

  async resolve(workId) {
    requireUuid(workId, 'workId');
    const history = await this.list();
    const item = [...history.creation, ...history.editing].find(entry => entry.workId === workId);
    if (!item) throw catalogError('WORK_ITEM_NOT_FOUND', 404, '工作项不存在或已隐藏');
    return item;
  }
}

export function createWorkCatalog(options) {
  return new WorkCatalog(options);
}
