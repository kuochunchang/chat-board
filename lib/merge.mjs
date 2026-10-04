import { isDeepStrictEqual as equal } from 'node:util';
import { randomUUID } from 'node:crypto';
import { validateDocument } from './document.mjs';

export class DiscussionConflict extends Error {
  constructor(fields) { super(`討論同時修改了相同內容：${fields.join('、')}`); this.fields = fields; }
}

// Merge independent records. A change to the same record needs chat review.
export function mergeDiscussion(base, local, remote) {
  if (equal(local, remote)) return local;
  if (equal(base, local)) return remote;
  if (equal(base, remote)) return local;
  if (!base || !local || !remote || local.id !== remote.id || base.id !== local.id) {
    throw new DiscussionConflict(['整份討論']);
  }
  const conflicts = [];
  function choose(before, ours, theirs, field) {
    if (equal(ours, theirs) || equal(before, theirs)) return ours;
    if (equal(before, ours)) return theirs;
    conflicts.push(field); return ours;
  }
  const doc = structuredClone(local);
  for (const key of ['title', 'topic', 'status', 'project', 'createdAt', 'schema']) {
    doc[key] = choose(base[key], local[key], remote[key], key);
  }
  for (const key of ['pages', 'items', 'diagrams']) {
    const before = new Map((base[key] || []).map(value => [value.id, value]));
    const ours = new Map((local[key] || []).map(value => [value.id, value]));
    const theirs = new Map((remote[key] || []).map(value => [value.id, value]));
    const ids = new Set([...ours.keys(), ...theirs.keys(), ...before.keys()]);
    doc[key] = [...ids].map(id => choose(before.get(id), ours.get(id), theirs.get(id), `${key}/${id}`)).filter(Boolean);
  }
  // An existing history entry must never change under the same ID.
  const history = new Map();
  for (const entry of [...base.history, ...local.history, ...remote.history]) {
    if (history.has(entry.id) && !equal(history.get(entry.id), entry)) conflicts.push(`history/${entry.id}`);
    else history.set(entry.id, entry);
  }
  if (conflicts.length) throw new DiscussionConflict(conflicts);
  doc.revision = Math.max(local.revision, remote.revision) + 1;
  doc.updatedAt = new Date().toISOString();
  doc.history = [...history.values()];
  doc.history.push({ id: randomUUID(), at: doc.updatedAt, actor: 'ai', summary: '整合不同項目的跨電腦更新',
    reason: '雙方修改不同項目。保留原項目 ID、確認理由與雙方歷史；未新增使用者確認。',
    changes: [{ op: 'checkpoint', label: `整合本機版本 ${local.revision} 與遠端版本 ${remote.revision}` }] });
  try { return validateDocument(doc); }
  catch { throw new DiscussionConflict(['整合後的白板關係或內容限制']); }
}
