export const MAX_ATTACHMENTS = 8;
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
export const ATTACHMENT_SOURCES = new Set(['selected', 'pasted']);

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ATTACHMENT_PATH = /^attachments\/([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})(\.[a-z0-9]{1,16})$/;
const ATTACHMENT_METADATA_KEYS = [
  'createdAt', 'id', 'mime', 'name', 'relativePath', 'size', 'source',
];

function isPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function isCanonicalUuidV4(value) {
  return typeof value === 'string' && UUID_V4.test(value);
}

function hasExactKeys(value, keys) {
  const actual = Object.keys(value).sort();
  return actual.length === keys.length && actual.every((key, index) => key === keys[index]);
}

function validateAttachmentName(name) {
  if (typeof name !== 'string' || Array.from(name).length === 0 || Array.from(name).length > 240
    || /\p{Cc}/u.test(name)) {
    throw new TypeError('附件名称必须是不含控制字符的 1–240 个字符');
  }
  return name;
}

function validateAttachmentMime(mime) {
  if (typeof mime !== 'string' || mime.length > 255 || /\p{Cc}/u.test(mime)) {
    throw new TypeError('附件 MIME 类型无效');
  }
  return mime;
}

function validateAttachmentSize(size) {
  if (!Number.isSafeInteger(size)) throw new TypeError('附件大小必须是安全整数');
  if (size <= 0) throw new RangeError('附件不能是空文件');
  if (size > MAX_ATTACHMENT_BYTES) throw new RangeError('单个附件不得超过 25 MiB');
  return size;
}

function validateCreatedAt(createdAt) {
  if (typeof createdAt !== 'string') throw new TypeError('附件创建时间必须是 ISO-8601 时间');
  const time = new Date(createdAt);
  if (!Number.isFinite(time.getTime()) || time.toISOString() !== createdAt) {
    throw new TypeError('附件创建时间必须是 ISO-8601 时间');
  }
  return createdAt;
}

export function parseAttachmentRelativePath(relativePath) {
  if (typeof relativePath !== 'string') throw new TypeError('附件相对路径无效');
  const match = relativePath.match(ATTACHMENT_PATH);
  if (!match) throw new TypeError('附件相对路径无效');
  return { taskId:match[1], attachmentId:match[2], suffix:match[3] };
}

export function validateFileLike(file) {
  if (!file || typeof file.name !== 'string' || !Number.isSafeInteger(file.size)) {
    throw new TypeError('附件不是有效文件');
  }
  validateAttachmentSize(file.size);
  return file;
}

export function validateAttachmentMetadata(value, taskId) {
  if (!isPlainObject(value) || !hasExactKeys(value, ATTACHMENT_METADATA_KEYS)) {
    throw new TypeError('附件元数据字段无效');
  }
  if (!isCanonicalUuidV4(taskId) || !isCanonicalUuidV4(value.id)) {
    throw new TypeError('附件和任务 ID 必须是规范 UUID v4');
  }
  validateAttachmentName(value.name);
  validateAttachmentMime(value.mime);
  validateAttachmentSize(value.size);
  if (!ATTACHMENT_SOURCES.has(value.source)) throw new TypeError('附件来源无效');
  const parsedPath = parseAttachmentRelativePath(value.relativePath);
  if (parsedPath.taskId !== taskId || parsedPath.attachmentId !== value.id) {
    throw new TypeError('附件相对路径与任务或附件 ID 不匹配');
  }
  validateCreatedAt(value.createdAt);
  return value;
}
