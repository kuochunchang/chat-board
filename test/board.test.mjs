import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, utimesSync, readdirSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { runInNewContext } from 'node:vm';
import { createDocument, renderDocument, parseDocument, applyUpdate } from '../lib/document.mjs';
import { Store, readBoard, withLock } from '../lib/storage.mjs';
import { createBoardServer } from '../server.mjs';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'chat-board-test-'));
  const projectAlias = join(root, 'other project'); mkdirSync(projectAlias);
  const project = realpathSync(projectAlias);
  const store = new Store(join(root, 'tool', 'index.json'));
  const result = store.create({ project, title: '跨專案討論', topic: 'HTML 就是紀錄' });
  return { root, project, store, ...result };
}
const update = (doc, operations, extra = {}) => ({ expectedRevision: doc.revision, actor: 'ai', summary: '整理進展', operations, ...extra });

test('the HTML alone round-trips text, SVG, history and script-like content', () => {
  let doc = createDocument({ title: 'A < B & C', project: '/tmp/project' });
  doc = applyUpdate(doc, update(doc, [
    { op: 'upsert', item: { id: 'note-one', kind: 'note', title: '</script><script>alert(1)</script>', text: '中文\n<&>' } },
    { op: 'diagram', diagram: { id: 'flow', title: 'SVG', svg: '<svg xmlns="http://www.w3.org/2000/svg"><text>中文 &amp; text</text></svg>' } }
  ]));
  const html = renderDocument(doc);
  assert.deepEqual(parseDocument(html), doc);
  assert.ok(html.includes('<style>') && html.includes('const online'));
  const embedded = html.match(/<script id="board-data" type="application\/json">([\s\S]*?)<\/script>/)[1];
  assert.ok(!embedded.includes('<') && !embedded.includes('</script>'));
  assert.ok(!html.includes('<script>alert(1)</script>'));
});

test('updates preserve prior content and decisions require an explicit confirmation reason', () => {
  let doc = createDocument({ title: '登入設計', project: '/tmp/project' });
  doc = applyUpdate(doc, update(doc, [{ op: 'upsert', item: { id: 'choice', kind: 'decision', title: '方案 A', text: '原理由' } }]));
  assert.equal(doc.items[0].confirmed, false);
  assert.throws(() => applyUpdate(doc, update(doc, [{ op: 'upsert', item: { ...doc.items[0], confirmed: true } }])), /明確確認/);
  doc = applyUpdate(doc, update(doc, [{ op: 'upsert', item: { ...doc.items[0], title: '方案 B', text: '新理由', confirmed: true } }], { reason: '使用者明確說：選 B，因為維護比較簡單。' }));
  assert.equal(doc.history.at(-1).changes[0].before.title, '方案 A');
  assert.equal(doc.history.at(-1).changes[0].before.text, '原理由');
  assert.equal(doc.items[0].confirmed, true);
  assert.throws(() => applyUpdate(doc, update(doc, [{ op: 'remove', id: 'choice' }])), /reason/);
  const removed = applyUpdate(doc, update(doc, [{ op: 'remove', id: 'choice' }], { reason: '方案已被新的決策取代' }));
  assert.equal(removed.items.length, 0);
  assert.equal(removed.history.at(-1).changes[0].before.title, '方案 B');
});

test('stale revisions and finished discussions cannot overwrite the record', () => {
  const doc = createDocument({ title: '完成', project: '/tmp/project' });
  assert.throws(() => applyUpdate(doc, { ...update(doc, [{ op:'checkpoint' }]), expectedRevision: 0 }), /重新讀取/);
  const finished = applyUpdate(doc, update(doc, [{ op:'finish' }]));
  assert.throws(() => applyUpdate(finished, update(finished, [{ op:'meta', title:'oops' }])), /先重新開啟/);
  const resumed = applyUpdate(finished, update(finished, [{ op:'resume' }]));
  assert.equal(resumed.status, 'active'); assert.equal(resumed.history.length, 3);
});

test('multiple whiteboards share one HTML, preserve assignments and retain changes', () => {
  let doc = createDocument({ title:'多塊白板', project:'/tmp/project' });
  doc = applyUpdate(doc, update(doc, [
    { op:'page', page:{ id:'main', title:'架構圖' } },
    { op:'page', page:{ id:'notes', title:'討論筆記', description:'記下問題與限制' } },
    { op:'upsert', item:{ id:'q', pageId:'notes', kind:'question', title:'待釐清', text:'一個問題' } },
    { op:'diagram', diagram:{ id:'flow', pageId:'main', title:'架構', svg:'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100"/></svg>' } }
  ]));
  assert.equal(doc.pages.length, 2);
  assert.equal(doc.items[0].pageId, 'notes'); assert.equal(doc.diagrams[0].pageId, 'main');
  const html = renderDocument(doc); assert.deepEqual(parseDocument(html), doc);
  assert.ok(!html.includes('type="checkbox"') && !html.includes('儲存 HTML'));
  assert.ok(!html.includes('<form') && !html.includes("method: 'PATCH'"));
  const revised = applyUpdate(doc, update(doc, [{ op:'upsert', item:{ id:'q',kind:'question',text:'新的問題' } }]));
  assert.equal(revised.items[0].pageId, 'notes');
  assert.equal(revised.history.at(-1).changes[0].before.text, '一個問題');
  assert.throws(() => applyUpdate(doc, update(doc, [{ op:'upsert',item:{ id:'oops',kind:'note',pageId:'unknown' } }])), /找不到白板/);
});

test('merging pages preserves notes, diagrams, confirmation and page history', () => {
  let doc = createDocument({ title:'合併白板', project:'/tmp/project' });
  doc = applyUpdate(doc, update(doc, [
    { op:'page', page:{ id:'extra', title:'待合併', description:'原分頁說明' } },
    { op:'upsert', item:{ id:'choice', kind:'decision', pageId:'extra', title:'既有決策', text:'原文', sources:['design.md:5'], confirmed:true } },
    { op:'diagram', diagram:{ id:'flow', pageId:'extra', title:'原圖', caption:'原圖說', svg:'<svg xmlns="http://www.w3.org/2000/svg"><text>原圖</text></svg>' } }
  ], { reason:'使用者明確確認既有決策。' }));
  const original = structuredClone(doc);
  const merged = applyUpdate(doc, update(doc, [
    { op:'upsert', item:{ ...doc.items[0], pageId:'main' } },
    { op:'diagram', diagram:{ ...doc.diagrams[0], pageId:'main' } },
    { op:'remove', target:'page', id:'extra' }
  ], { reason:'使用者要求合併重複分頁。' }));
  assert.deepEqual(doc, original);
  assert.deepEqual(merged.pages.map(page=>page.id), ['main']);
  for (const key of ['items','diagrams']) {
    const { updatedAt:beforeTime, ...before } = doc[key][0];
    const { updatedAt:afterTime, ...after } = merged[key][0];
    assert.deepEqual(after, { ...before, pageId:'main' });
  }
  assert.equal(merged.items[0].confirmed, true);
  assert.deepEqual(merged.history.slice(0,-1), doc.history);
  assert.deepEqual(merged.history.at(-1).changes.at(-1), { op:'remove', target:'page', before:doc.pages[1], after:null });
  assert.deepEqual(parseDocument(renderDocument(merged)), merged);
});

test('page removal rejects occupied, implicit, missing and last pages without mutation', () => {
  let doc = createDocument({ title:'分頁保護', project:'/tmp/project' });
  doc = applyUpdate(doc, update(doc, [
    { op:'page', page:{ id:'extra', title:'另一頁' } },
    { op:'upsert', item:{ id:'extra', kind:'note', pageId:'extra', text:'同 ID 的筆記' } },
    { op:'diagram', diagram:{ id:'flow', pageId:'main', svg:'<svg></svg>' } }
  ]));
  const original = structuredClone(doc);
  const remove = id => update(doc, [{ op:'remove',target:'page',id }], { reason:'合併分頁' });
  assert.throws(()=>applyUpdate(doc,remove('extra')), /先搬移/);
  assert.throws(()=>applyUpdate(doc,remove('main')), /先搬移/);
  assert.throws(()=>applyUpdate(doc,remove('missing')), /找不到/);
  assert.throws(()=>applyUpdate(doc,update(doc,[{ op:'remove',target:'page',id:'extra' }])), /reason/);
  assert.throws(()=>applyUpdate(doc,update(doc,[{ op:'remove',target:'unknown',id:'extra' }],{ reason:'合併' })), /target/);
  assert.deepEqual(doc, original);
  const single = createDocument({ title:'只有一頁', project:'/tmp/project' });
  assert.throws(()=>applyUpdate(single,update(single,[{ op:'remove',target:'page',id:'main' }],{ reason:'合併' })), /至少一/);
  const legacy = structuredClone(doc);
  delete legacy.items[0].pageId;
  legacy.diagrams = [];
  assert.throws(()=>applyUpdate(legacy,update(legacy,[{ op:'remove',target:'page',id:'main' }],{ reason:'合併' })), /先搬移/);
});

test('a failed page merge leaves persisted HTML unchanged', () => {
  const { store, id, path } = fixture();
  const doc = store.update(id, update(readBoard(path), [
    { op:'page', page:{ id:'extra', title:'原頁' } },
    { op:'upsert', item:{ id:'note', kind:'note', pageId:'extra', text:'原文' } },
    { op:'diagram', diagram:{ id:'flow', pageId:'extra', svg:'<svg></svg>' } }
  ])).doc;
  const original = readFileSync(path,'utf8');
  assert.throws(()=>store.update(id,update(doc,[
    { op:'upsert', item:{ ...doc.items[0], pageId:'main' } },
    { op:'remove', target:'page', id:'extra' }
  ],{ reason:'合併分頁' })), /先搬移/);
  assert.equal(readFileSync(path,'utf8'), original);
  assert.ok(!existsSync(`${path}.chat-board.lock`));
});

test('standalone HTML can render and switch whiteboards without the server or network', () => {
  let doc = createDocument({ title:'離線討論', project:'/tmp/project' });
  doc = applyUpdate(doc, update(doc, [
    { op:'page', page:{ id:'notes', title:'另一塊白板' } },
    { op:'page', page:{ id:'old', title:'待合併分頁' } },
    { op:'upsert',item:{ id:'first',kind:'note',pageId:'main',title:'第一塊的筆記',text:'內容 A' } },
    { op:'upsert',item:{ id:'second',kind:'note',pageId:'old',title:'第二塊的筆記',text:'內容 B' } }
  ]));
  doc = applyUpdate(doc, update(doc, [
    { op:'upsert',item:{ ...doc.items[1],pageId:'notes' } },
    { op:'remove',target:'page',id:'old' }
  ], { reason:'合併重複分頁，保留離線切換。' }));
  const html = renderDocument(doc);
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const app = { innerHTML:'' }, handlers = new Map();
  let networkCalls = 0;
  runInNewContext(script, {
    document: { getElementById: id => id === 'app' ? app : { textContent:JSON.stringify(parseDocument(html)) }, addEventListener:(name,handler)=>handlers.set(name,handler) },
    location:{ protocol:'file:',pathname:'/discussion.html' },
    window:{ scrollY:0,scrollTo(){} },
    fetch(){ networkCalls++; throw new Error('No network in standalone HTML'); },
    EventSource:class { constructor(){ networkCalls++; throw new Error('No server in standalone HTML'); } }
  });
  assert.ok(app.innerHTML.includes('第一塊的筆記') && !app.innerHTML.includes('第二塊的筆記'));
  assert.ok(!app.innerHTML.includes('data-page="old"'));
  handlers.get('click')({ target:{ closest: selector => selector === '[data-page]' ? { dataset:{ page:'notes' } } : null } });
  assert.ok(app.innerHTML.includes('第二塊的筆記') && !app.innerHTML.includes('第一塊的筆記'));
  assert.equal(networkCalls, 0);
});

test('records live in another project, survive registry reconstruction and do not overwrite files', () => {
  const { store, project, path, id } = fixture();
  assert.ok(path.startsWith(join(project, 'docs', 'discussions')));
  const original = readFileSync(path, 'utf8');
  assert.throws(() => store.create({ project, title:'overwrite', file:path }), /已存在/);
  assert.equal(readFileSync(path, 'utf8'), original);
  const next = store.update(id, update(readBoard(path), [{ op:'upsert', item:{ id:'q', kind:'question', title:'還缺什麼？', text:'一個比較' } }]));
  assert.equal(readBoard(path).items[0].title, '還缺什麼？');
  const restored = new Store(store.registry); assert.equal(restored.get(id).doc.revision, next.doc.revision);
  const another = new Store(join(project, 'another-registry.json'));
  another.register(path); assert.deepEqual(another.get(id).doc, next.doc);
  assert.ok(!existsSync(`${path}.chat-board.lock`));
});

test('the server is read-only and streams external CLI file updates', async () => {
  const { store, id, path } = fixture();
  const server = createBoardServer({ store, pollInterval: 30 });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const controller = new AbortController();
  try {
    const response = await fetch(`${base}/boards/${id}`);
    assert.equal(response.status, 200); assert.equal(parseDocument(await response.text()).id, id);
    assert.equal((await fetch(`${base}/api/boards`)).status, 200);
    const denied = await fetch(`${base}/api/boards/${id}`, { method:'PATCH', headers:{'Content-Type':'application/json'},body:'{}' });
    assert.equal(denied.status, 405);
    const maliciousOrigin = await fetch(`${base}/api/boards/${id}`, { method:'PATCH',headers:{'Content-Type':'application/json','X-Chat-Board':'1','Origin':'https://example.com'},body:'{}' });
    assert.equal(maliciousOrigin.status, 405);
    const payload = update(readBoard(path), [{ op:'upsert', item:{ id:'ai-note', kind:'note', title:'由 AI 新增', text:'同步測試' } }]);
    const saved = await fetch(`${base}/api/boards/${id}`, { method:'PATCH',headers:{'Content-Type':'application/json','X-Chat-Board':'1'},body:JSON.stringify(payload) });
    assert.equal(saved.status, 405);
    const stale = await fetch(`${base}/api/boards/${id}`, { method:'PATCH',headers:{'Content-Type':'application/json','X-Chat-Board':'1'},body:JSON.stringify(payload) });
    assert.equal(stale.status, 405);
    assert.equal(readBoard(path).revision, 1);
    const createDenied = await fetch(`${base}/api/boards`, { method:'POST',headers:{'Content-Type':'application/json'},body:'{}' });
    assert.equal(createDenied.status, 405);
    // Establish a baseline before subscribing so an initial discovery event
    // cannot be mistaken for the later external-file update.
    await new Promise(resolve => setTimeout(resolve, 80));
    const events = await fetch(`${base}/api/events`, { signal: controller.signal });
    const reader = events.body.getReader();
    let messages = new TextDecoder().decode((await reader.read()).value);
    store.updateFile(path, update(readBoard(path), [{ op:'checkpoint', label:'外部 AI 更新' }]));
    await Promise.race([
      (async () => { while (!messages.includes('event: board')) messages += new TextDecoder().decode((await reader.read()).value); })(),
      new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('SSE did not receive the file update')), 2500); timer.unref(); })
    ]);
    assert.ok(messages.includes(id));
    const updated = await (await fetch(`${base}/api/boards/${id}`)).json();
    assert.equal(updated.doc.history.at(-1).summary, '整理進展');
    assert.equal(updated.doc.revision, 2);
    controller.abort();
  } finally { controller.abort(); await server.stop(); }
});

test('archiving is recorded in history, blocks edits until unarchived and works on finished discussions', () => {
  const doc = createDocument({ title: '封存', project: '/tmp/project' });
  const finished = applyUpdate(doc, update(doc, [{ op: 'finish' }]));
  const archived = applyUpdate(finished, update(finished, [{ op: 'archive' }], { reason: '討論已結束，收起來' }));
  assert.equal(archived.archived, true);
  assert.deepEqual(archived.history.at(-1).changes[0], { op: 'archive', before: false, after: true });
  assert.deepEqual(parseDocument(renderDocument(archived)), archived);
  assert.throws(() => applyUpdate(archived, update(archived, [{ op: 'resume' }])), /取消封存/);
  assert.throws(() => applyUpdate(archived, update(archived, [{ op: 'archive' }])), /已封存/);
  const restored = applyUpdate(archived, update(archived, [{ op: 'unarchive' }]));
  assert.equal(restored.archived, false);
  assert.throws(() => applyUpdate(restored, update(restored, [{ op: 'unarchive' }])), /尚未封存/);
  assert.throws(() => renderDocument({ ...doc, archived: 'yes' }), /封存狀態/);
});

test('deleting requires an archived board, a reason and the current revision', () => {
  const { store, id, path } = fixture();
  assert.throws(() => store.delete(path, { reason: '不需要了' }), /先封存/);
  const archived = store.updateFile(path, update(readBoard(path), [{ op: 'archive' }]));
  assert.equal(store.list()[0].archived, true);
  assert.throws(() => store.delete(path, { reason: ' ' }), /reason/);
  assert.throws(() => store.delete(path, { reason: '不需要了', revision: 1 }), /重新讀取/);
  const result = store.delete(path, { reason: '不需要了', revision: archived.doc.revision });
  assert.equal(result.deleted, true); assert.equal(result.id, id);
  assert.ok(!existsSync(path));
  assert.equal(store.list().length, 0);
  assert.throws(() => store.get(id), /尚未登記/);
});

test('a lock left by an exited process or an old empty lock is taken over; a live lock is kept', () => {
  const root = mkdtempSync(join(tmpdir(), 'chat-board-lock-test-'));
  const file = join(root, 'record.html');
  const lock = `${file}.chat-board.lock`;
  const exitedPid = Number(spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout);
  writeFileSync(lock, JSON.stringify({ pid: exitedPid, host: hostname(), at: new Date().toISOString() }));
  assert.equal(withLock(file, () => JSON.parse(readFileSync(lock, 'utf8')).pid), process.pid);
  assert.ok(!existsSync(lock));
  writeFileSync(lock, JSON.stringify({ pid: process.pid, host: hostname() }));
  assert.throws(() => withLock(file, () => {}), /另一個更新/);
  const old = new Date(Date.now() - 11 * 60 * 1000);
  for (const unverified of [JSON.stringify({ pid: exitedPid, host: 'renamed-or-another-computer' }), '']) {
    writeFileSync(lock, unverified);
    assert.throws(() => withLock(file, () => {}), /另一個更新/);
    utimesSync(lock, old, old);
    assert.equal(withLock(file, () => 'taken over'), 'taken over');
  }
  assert.deepEqual(readdirSync(root), []);
});

test('read omits history unless asked, can omit SVG source, and diagram edits keep the SVG', () => {
  const { store, path } = fixture();
  const cli = new URL('../bin/board.mjs', import.meta.url).pathname;
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"><text>流程</text></svg>';
  store.updateFile(path, update(readBoard(path), [{ op: 'diagram', diagram: { id: 'flow', title: '流程', svg } }]));
  const read = (...args) => JSON.parse(spawnSync(process.execPath, [cli, 'read', '--file', path, '--registry', store.registry, ...args], { encoding: 'utf8' }).stdout);
  const compact = read();
  assert.equal(compact.doc.history, undefined);
  assert.equal(compact.omitted.history, 2);
  assert.equal(compact.doc.diagrams[0].svg, svg);
  const full = read('--history');
  assert.equal(full.doc.history.length, 2);
  assert.equal(full.omitted, undefined);
  const lean = read('--no-svg');
  assert.equal(lean.doc.diagrams[0].svg, undefined);
  assert.equal(lean.omitted.svg, 1);
  const { svg: omitted, ...diagram } = lean.doc.diagrams[0];
  store.updateFile(path, update(lean.doc, [{ op: 'diagram', diagram: { ...diagram, caption: '只改圖說' } }]));
  assert.equal(readBoard(path).diagrams[0].svg, svg);
});

test('a diagram expands to the full width and back; the sidebar moves below while any diagram on the page is expanded', () => {
  let doc = createDocument({ title: '全寬圖', project: '/tmp/project' });
  doc = applyUpdate(doc, update(doc, [
    { op: 'page', page: { id: 'notes', title: '另一塊白板' } },
    { op: 'diagram', diagram: { id: 'flow', pageId: 'main', title: '複雜流程', svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 900 600"><text>流程</text></svg>' } },
    { op: 'diagram', diagram: { id: 'other', pageId: 'main', title: '另一張圖', svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 900 300"><text>其他</text></svg>' } }
  ]));
  const html = renderDocument(doc);
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const app = { innerHTML: '' }, handlers = new Map();
  runInNewContext(script, {
    document: { getElementById: id => id === 'app' ? app : { textContent: JSON.stringify(parseDocument(html)) }, addEventListener: (name, handler) => handlers.set(name, handler) },
    location: { protocol: 'file:', pathname: '/discussion.html' },
    window: { scrollY: 0, scrollTo() {}, scrollBy() {} }
  });
  const click = targets => handlers.get('click')({ target: { closest: selector => targets[selector] ?? null } });
  const expanded = () => [...app.innerHTML.matchAll(/class="diagram-card( expanded)?"/g)].map(match => Boolean(match[1]));
  assert.ok(app.innerHTML.includes('data-expand="flow"') && app.innerHTML.includes('aria-pressed="false"'));
  assert.deepEqual(expanded(), [false, false]);
  assert.ok(!app.innerHTML.includes('workspace-grid wide'));
  click({ '[data-expand]': { dataset: { expand: 'flow' } } });
  assert.deepEqual(expanded(), [true, false]);
  assert.ok(app.innerHTML.includes('workspace-grid wide') && app.innerHTML.includes('aria-pressed="true"'));
  click({ '[data-page]': { dataset: { page: 'notes' } } });
  assert.ok(!app.innerHTML.includes('workspace-grid wide'));
  click({ '[data-page]': { dataset: { page: 'main' } } });
  assert.deepEqual(expanded(), [true, false]);
  click({ '[data-expand]': { dataset: { expand: 'flow' } } });
  assert.deepEqual(expanded(), [false, false]);
  assert.ok(!app.innerHTML.includes('workspace-grid wide'));
});

test('decisions are listed newest first by confirmation time, or by proposal time while pending', t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-01T00:00:00.000Z') });
  let doc = createDocument({ title: '決策排序', project: '/tmp/project' });
  const at = (time, operations, reason) => { t.mock.timers.setTime(Date.parse(time)); doc = applyUpdate(doc, update(doc, operations, reason ? { reason } : {})); };
  const item = id => doc.items.find(value => value.id === id);
  at('2026-10-01T01:00:00.000Z', [
    { op: 'page', page: { id: 'notes', title: '另一塊白板' } },
    { op: 'upsert', item: { id: 'first', kind: 'decision', title: '最先提出、最後確認' } },
    { op: 'upsert', item: { id: 'second', kind: 'consensus', title: '先確認的共識' } },
    { op: 'upsert', item: { id: 'third', kind: 'decision', title: '仍待確認' } }
  ]);
  at('2026-10-01T05:00:00.000Z', [{ op: 'upsert', item: { ...item('first'), confirmed: true } }], '使用者第一次確認。');
  at('2026-10-02T01:00:00.000Z', [{ op: 'upsert', item: { ...item('second'), confirmed: true } }], '使用者確認共識。');
  at('2026-10-02T03:00:00.000Z', [{ op: 'upsert', item: { id: 'legacy', kind: 'decision', pageId: 'notes', title: '沒有確認紀錄的決策', confirmed: true } }], '使用者確認另一塊白板的決策。');
  at('2026-10-02T06:00:00.000Z', [{ op: 'upsert', item: { ...item('first'), confirmed: false } }]);
  at('2026-10-03T01:00:00.000Z', [{ op: 'upsert', item: { ...item('first'), confirmed: true } }], '使用者重新確認。');
  doc.history.find(entry => entry.changes.some(change => change.after?.id === 'legacy')).changes = [];
  const html = renderDocument(doc);
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const app = { innerHTML: '' };
  runInNewContext(script, {
    document: { getElementById: id => id === 'app' ? app : { textContent: JSON.stringify(parseDocument(html)) }, addEventListener() {} },
    location: { protocol: 'file:', pathname: '/discussion.html' },
    window: { scrollY: 0, scrollTo() {} }
  });
  const time = (value, label) => `${new Intl.DateTimeFormat('zh-TW', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value))} ${label}`;
  const cards = name => [...app.innerHTML.matchAll(new RegExp(`<article class="${name}">([\\s\\S]*?)</article>`, 'g'))].map(([, card]) => [card.match(/<h3>(.*?)<\/h3>/)[1], card.match(/<time[^>]*>(.*?)<\/time>/)?.[1]]);
  assert.deepEqual(cards('decision'), [
    ['最先提出、最後確認', time('2026-10-03T01:00:00.000Z', '確認')],
    ['沒有確認紀錄的決策', time('2026-10-02T03:00:00.000Z', '確認')],
    ['先確認的共識', time('2026-10-02T01:00:00.000Z', '確認')],
    ['仍待確認', time('2026-10-01T01:00:00.000Z', '提出')]
  ]);
  assert.deepEqual(cards('decision-full').map(([title]) => title), ['最先提出、最後確認', '先確認的共識', '仍待確認']);
});
