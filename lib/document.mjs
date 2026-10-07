import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

export const KINDS = ['question', 'idea', 'note', 'consensus', 'decision', 'action'];
const label = { question: '問題', idea: '想法', note: '筆記', consensus: '共識', decision: '決策', action: '下一步' };
const loadAssets = () => ({
  css: readFileSync(new URL('../web/board.css', import.meta.url), 'utf8'),
  script: readFileSync(new URL('../web/viewer.js', import.meta.url), 'utf8')
});

export class BoardError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

function string(value, field, max = 20000) {
  if (typeof value !== 'string' || value.length > max) throw new BoardError(`${field} 必須是文字，且不超過 ${max} 字。`);
  return value;
}

export function validateDocument(doc) {
  if (doc?.schema !== 'chat-board/v1') throw new BoardError('這不是支援的白板文件。');
  if (typeof doc.id !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(doc.id)) throw new BoardError('白板 ID 無效。');
  string(doc.title, '標題', 300);
  string(doc.project?.path, '專案路徑', 4096);
  string(doc.project?.name, '專案名稱', 300);
  string(doc.topic, '討論目標');
  if (!Number.isSafeInteger(doc.revision) || doc.revision < 1) throw new BoardError('版本無效。');
  if (!['active', 'finished'].includes(doc.status)) throw new BoardError('討論狀態無效。');
  if (doc.archived !== undefined && typeof doc.archived !== 'boolean') throw new BoardError('封存狀態無效。');
  if (!Array.isArray(doc.items) || !Array.isArray(doc.diagrams) || !Array.isArray(doc.history)) throw new BoardError('白板內容無效。');
  const pages = doc.pages || [{ id: 'main', title: '討論白板', description: '' }];
  if (!Array.isArray(pages) || pages.length < 1 || pages.length > 40) throw new BoardError('每份討論需要 1 到 40 塊白板。');
  const pageIds = new Set();
  for (const page of pages) {
    string(page.id, '白板 ID', 100);
    string(page.title, '白板名稱', 100);
    string(page.description, '白板說明');
    if (!page.id || pageIds.has(page.id)) throw new BoardError('白板 ID 必須唯一。');
    pageIds.add(page.id);
  }
  if (doc.items.length > 1000 || doc.diagrams.length > 100) throw new BoardError('白板內容超過上限。');
  const ids = new Set();
  for (const item of [...doc.items, ...doc.diagrams]) {
    string(item.id, '項目 ID', 100);
    if (!item.id || ids.has(item.id)) throw new BoardError('項目 ID 必須唯一。');
    ids.add(item.id);
    if (item.pageId !== undefined && !pageIds.has(item.pageId)) throw new BoardError(`找不到白板 ${item.pageId}，請先新增那塊白板。`);
    string(item.title, '項目標題', 300);
    if ('svg' in item) {
      string(item.svg, 'SVG', 500000);
      if (!/^\s*<svg[\s>]/i.test(item.svg) || !/<\/svg>\s*$/i.test(item.svg)) throw new BoardError('圖必須是完整的 SVG。');
      string(item.caption, '圖說');
    } else {
      if (!KINDS.includes(item.kind)) throw new BoardError('項目類型無效。');
      string(item.text, '項目內容');
      if (typeof item.confirmed !== 'boolean' || typeof item.done !== 'boolean') throw new BoardError('確認狀態無效。');
      if (!Array.isArray(item.sources) || item.sources.some(source => typeof source !== 'string' || source.length > 4096)) throw new BoardError('來源必須是檔案路徑或說明的文字陣列。');
    }
  }
  return doc;
}

export function createDocument({ title, topic = '', project, name }) {
  const now = new Date().toISOString();
  return validateDocument({
    schema: 'chat-board/v1', id: randomUUID(), revision: 1,
    title: title || '新的討論', topic,
    project: { name: name || project.split(/[\\/]/).filter(Boolean).at(-1) || '專案', path: project },
    status: 'active', createdAt: now, updatedAt: now,
    pages: [{ id: 'main', title: '討論白板', description: '' }], items: [], diagrams: [],
    history: [{ id: randomUUID(), at: now, actor: 'user', summary: '開始討論', changes: [] }]
  });
}

export function applyUpdate(original, update) {
  if (!update || typeof update !== 'object' || Array.isArray(update)) throw new BoardError('更新必須是 JSON 物件。');
  if (update.expectedRevision !== original.revision) throw new BoardError('白板已有新內容，請重新讀取後再更新。', 409);
  if (!Array.isArray(update.operations) || update.operations.length < 1 || update.operations.length > 100) throw new BoardError('需要 1 到 100 個更新操作。');
  const only = op => update.operations.length === 1 && update.operations[0]?.op === op;
  if (original.archived && !only('unarchive')) throw new BoardError(only('archive') ? '討論已封存。' : '討論已封存，請先取消封存。', 409);
  if (original.status === 'finished' && !['resume', 'archive', 'unarchive'].some(only)) throw new BoardError('討論已完成，請先重新開啟討論。', 409);
  const doc = structuredClone(original);
  doc.pages ||= [{ id: 'main', title: '討論白板', description: '' }];
  const now = new Date().toISOString();
  const actor = update.actor === 'user' ? 'user' : 'ai';
  const changes = [];
  for (const operation of update.operations) {
    if (!operation || typeof operation !== 'object') throw new BoardError('操作格式無效。');
    if (operation.op === 'meta') {
      const before = { title: doc.title, topic: doc.topic };
      if (operation.title !== undefined) doc.title = string(operation.title, '標題', 300);
      if (operation.topic !== undefined) doc.topic = string(operation.topic, '討論目標');
      changes.push({ op: 'meta', before, after: { title: doc.title, topic: doc.topic } });
    } else if (operation.op === 'page') {
      const value = operation.page;
      if (!value || typeof value !== 'object') throw new BoardError('需要 page，包含 id、title 與選填 description。');
      const id = value.id || randomUUID();
      const index = doc.pages.findIndex(page => page.id === id);
      const before = index < 0 ? null : doc.pages[index];
      const page = { id, title: value.title ?? before?.title ?? '討論白板', description: value.description ?? before?.description ?? '' };
      if (index < 0) doc.pages.push(page); else doc.pages[index] = page;
      changes.push({ op: 'page', before, after: structuredClone(page) });
    } else if (operation.op === 'upsert') {
      const value = operation.item;
      if (!value || typeof value !== 'object' || !KINDS.includes(value.kind)) throw new BoardError('需要有效的 item 與 kind。');
      const id = value.id || randomUUID();
      const index = doc.items.findIndex(item => item.id === id);
      const before = index < 0 ? null : doc.items[index];
      const item = {
        id, pageId: value.pageId ?? before?.pageId ?? doc.pages[0].id,
        kind: value.kind, title: value.title ?? before?.title ?? '', text: value.text ?? before?.text ?? '',
        sources: value.sources ?? before?.sources ?? [],
        links: value.links ?? before?.links ?? [],
        confirmed: value.confirmed ?? before?.confirmed ?? false,
        done: value.done ?? before?.done ?? false,
        createdAt: before?.createdAt ?? now, updatedAt: now
      };
      if (!Array.isArray(item.links) || item.links.some(link => typeof link !== 'string' || !link || link === id)) throw new BoardError('links 必須是其他項目 ID 的陣列。');
      // An AI may record explicit approval, but must say what the user approved.
      if (actor === 'ai' && item.confirmed && !before?.confirmed && !update.reason?.trim()) throw new BoardError('AI 記錄已確認內容時，需以 reason 記下使用者的明確確認。');
      if (index < 0) doc.items.push(item); else doc.items[index] = item;
      changes.push({ op: 'upsert', before, after: structuredClone(item) });
    } else if (operation.op === 'diagram') {
      const value = operation.diagram;
      if (!value || typeof value !== 'object') throw new BoardError('需要 diagram。');
      const id = value.id || randomUUID();
      const index = doc.diagrams.findIndex(item => item.id === id);
      const before = index < 0 ? null : doc.diagrams[index];
      const diagram = { id, pageId: value.pageId ?? before?.pageId ?? doc.pages[0].id, title: value.title ?? before?.title ?? '關係圖', svg: value.svg ?? before?.svg, caption: value.caption ?? before?.caption ?? '', createdAt: before?.createdAt ?? now, updatedAt: now };
      if (index < 0) doc.diagrams.push(diagram); else doc.diagrams[index] = diagram;
      changes.push({ op: 'diagram', before, after: structuredClone(diagram) });
    } else if (operation.op === 'remove') {
      if (!update.reason?.trim()) throw new BoardError('移除內容需要記下 reason；原文仍會保留在討論脈絡。');
      if (operation.target !== undefined && operation.target !== 'page') throw new BoardError('remove 的 target 只能是 page；移除筆記或圖時省略 target。');
      const isPage = operation.target === 'page';
      const list = (isPage ? [doc.pages] : [doc.items, doc.diagrams]).find(items => items.some(item => item.id === operation.id));
      if (!list) throw new BoardError('找不到要移除的項目。', 404);
      if (isPage) {
        if (doc.pages.length === 1) throw new BoardError('每份討論須保留至少一塊白板。');
        if ([...doc.items, ...doc.diagrams].some(item => (item.pageId ?? doc.pages[0].id) === operation.id)) {
          throw new BoardError('請先搬移這塊白板的筆記與圖，再移除空白分頁。');
        }
      }
      const index = list.findIndex(item => item.id === operation.id);
      const [before] = list.splice(index, 1);
      changes.push({ op: 'remove', ...(isPage ? { target: 'page' } : {}), before, after: null });
    } else if (operation.op === 'finish' || operation.op === 'resume') {
      const before = doc.status;
      doc.status = operation.op === 'finish' ? 'finished' : 'active';
      changes.push({ op: operation.op, before, after: doc.status });
    } else if (operation.op === 'archive' || operation.op === 'unarchive') {
      const before = Boolean(doc.archived);
      if (operation.op === 'unarchive' && !before) throw new BoardError('討論尚未封存。', 409);
      doc.archived = operation.op === 'archive';
      changes.push({ op: operation.op, before, after: doc.archived });
    } else if (operation.op === 'checkpoint') {
      changes.push({ op: 'checkpoint', label: string(operation.label || '討論里程碑', '里程碑', 300) });
    } else throw new BoardError(`未知的操作：${operation.op}`);
  }
  doc.revision += 1;
  doc.updatedAt = now;
  doc.history.push({ id: randomUUID(), at: now, actor, summary: string(update.summary || '更新白板', '摘要', 300), reason: string(update.reason || '', '理由'), changes });
  return validateDocument(doc);
}

export const escapeHtml = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
export const safeJson = value => JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

export function renderDocument(doc) {
  validateDocument(doc);
  const { css, script } = loadAssets();
  const fallback = `<article><h1>${escapeHtml(doc.title)}</h1><p>${escapeHtml(doc.topic)}</p>${doc.items.map(item => `<section><h2>${escapeHtml(label[item.kind])} · ${escapeHtml(item.title)}</h2><p>${escapeHtml(item.text).replace(/\n/g, '<br>')}</p><p>${item.confirmed ? '已確認' : '待確認'}</p></section>`).join('')}</article>`;
  return `<!doctype html>\n<html lang="zh-Hant">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width,initial-scale=1">\n<meta name="chat-board" content="v1">\n<title>${escapeHtml(doc.title)} · 共板</title>\n<style>${css}</style>\n</head>\n<body>\n<div id="app"></div>\n<noscript>${fallback}</noscript>\n<script id="board-data" type="application/json">${safeJson(doc)}</script>\n<script>${script}</script>\n</body>\n</html>\n`;
}

export function parseDocument(html) {
  const match = html.match(/<script id="board-data" type="application\/json">([\s\S]*?)<\/script>/);
  if (!match) throw new BoardError('找不到白板資料，請使用共板產生的 HTML。');
  try { return validateDocument(JSON.parse(match[1])); }
  catch (error) { if (error instanceof BoardError) throw error; throw new BoardError('白板資料不是有效的 JSON。'); }
}
