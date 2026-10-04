import { existsSync, mkdirSync, openSync, closeSync, readFileSync, writeFileSync, renameSync, unlinkSync, realpathSync, statSync } from 'node:fs';
import { resolve, dirname, basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { BoardError, createDocument, parseDocument, renderDocument, applyUpdate } from './document.mjs';
import { syncAfterSave } from './sync.mjs';

export const TOOL_ROOT = fileURLToPath(new URL('..', import.meta.url));
export const DEFAULT_REGISTRY = join(TOOL_ROOT, '.chat-board', 'index.json');

export function withLock(file, callback) {
  mkdirSync(dirname(file), { recursive: true });
  let handle;
  try { handle = openSync(`${file}.chat-board.lock`, 'wx', 0o600); }
  catch (error) {
    if (error.code === 'EEXIST') throw new BoardError('另一個更新正在寫入，請稍後重試。', 409);
    throw error;
  }
  try { return callback(); }
  finally { closeSync(handle); unlinkSync(`${file}.chat-board.lock`); }
}

export function atomicWrite(file, content) {
  const temporary = `${file}.${randomUUID()}.chat-board.tmp`;
  try {
    writeFileSync(temporary, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    renameSync(temporary, file);
  } finally { if (existsSync(temporary)) unlinkSync(temporary); }
}

export function readBoard(file) {
  try { return parseDocument(readFileSync(file, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') throw new BoardError('找不到白板 HTML 檔案。', 404);
    throw error;
  }
}

export class Store {
  constructor(registry = DEFAULT_REGISTRY) { this.registry = resolve(registry); }
  entries() {
    if (!existsSync(this.registry)) return [];
    const entries = JSON.parse(readFileSync(this.registry, 'utf8'));
    if (!Array.isArray(entries)) throw new BoardError('白板索引格式無效。', 500);
    return entries;
  }
  register(file) {
    const path = realpathSync(resolve(file));
    const doc = readBoard(path);
    return withLock(this.registry, () => {
      const entries = this.entries();
      const existing = entries.find(entry => entry.id === doc.id);
      if (existing && existing.path !== path && existsSync(existing.path)) throw new BoardError('這份 HTML 是已登記白板的副本。請使用原檔，或建立新的討論。', 409);
      const next = entries.filter(entry => entry.id !== doc.id && entry.path !== path);
      next.push({ id: doc.id, path, registeredAt: new Date().toISOString() });
      atomicWrite(this.registry, JSON.stringify(next, null, 2));
      return { id: doc.id, path, doc };
    });
  }
  get(id) {
    const entry = this.entries().find(item => item.id === id);
    if (!entry) throw new BoardError('白板尚未登記。', 404);
    const doc = readBoard(entry.path);
    if (doc.id !== entry.id) throw new BoardError('白板 ID 已改變，請重新登記檔案。', 409);
    return { ...entry, doc };
  }
  list() {
    return this.entries().map(entry => {
      try {
        const doc = readBoard(entry.path);
        return { ...entry, title: doc.title, topic: doc.topic, project: doc.project, status: doc.status, revision: doc.revision, updatedAt: doc.updatedAt, pages: doc.pages?.length || 1, items: doc.items.length, confirmed: doc.items.filter(item => ['consensus', 'decision'].includes(item.kind) && item.confirmed).length };
      } catch (error) { return { ...entry, title: basename(entry.path), unavailable: true, error: error.message }; }
    }).sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  }
  create({ project, title, topic, file, name }) {
    const projectPath = realpathSync(resolve(project || TOOL_ROOT));
    if (!statSync(projectPath).isDirectory()) throw new BoardError('專案路徑必須是目錄。');
    const slug = (title || '新的討論').normalize('NFKC').replace(/[^\p{L}\p{N}_-]+/gu, '-').slice(0, 70) || 'discussion';
    const stamp = new Date().toISOString().slice(0, 19).replace(/:/g, '').replace('T', '-');
    const path = file ? resolve(projectPath, file) : join(projectPath, 'docs', 'discussions', `${stamp}-${slug}.html`);
    if (!path.toLowerCase().endsWith('.html')) throw new BoardError('白板檔案必須以 .html 結尾。');
    const doc = createDocument({ title, topic, project: projectPath, name });
    withLock(path, () => {
      // Never overwrite an existing record, including one created concurrently.
      if (existsSync(path)) throw new BoardError('檔案已存在，請使用不同檔名。', 409);
      atomicWrite(path, renderDocument(doc));
    });
    this.register(path);
    const sync = syncAfterSave(this, path);
    return { id: doc.id, path, doc: readBoard(path), ...(sync ? { sync } : {}) };
  }
  updateFile(file, update) {
    const path = realpathSync(resolve(file));
    const result = withLock(path, () => {
      const original = readBoard(path);
      const doc = applyUpdate(original, update);
      atomicWrite(path, renderDocument(doc));
      return { id: doc.id, path, doc };
    });
    const sync = syncAfterSave(this, path);
    return { ...result, doc: readBoard(path), ...(sync ? { sync } : {}) };
  }
  update(id, update) { return this.updateFile(this.get(id).path, update); }
}
