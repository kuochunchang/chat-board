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
function renderViewer(doc, extra = {}) {
  const html = renderDocument(doc);
  const app = { innerHTML: '' }, handlers = new Map();
  runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/)[1], {
    ...extra,
    document: { getElementById: id => id === 'app' ? app : { textContent: JSON.stringify(parseDocument(html)) }, addEventListener: (name, handler) => handlers.set(name, handler) },
    location: { protocol: 'file:', pathname: '/discussion.html' },
    window: { scrollY: 0, scrollTo() {}, scrollBy() {} }
  });
  const click = targets => handlers.get('click')({ target: { closest: selector => targets[selector] ?? null } });
  const part = (start, end) => { const html = app.innerHTML, from = html.indexOf(start); return from < 0 ? '' : html.slice(from, end ? html.indexOf(end, from) : undefined); };
  return { app, click, part };
}

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
  const click = targets => handlers.get('click')({ target:{ closest: selector => targets[selector] ?? null } });
  assert.ok(app.innerHTML.includes('這塊白板沒有待確認事項'));
  assert.ok(app.innerHTML.includes('細節（1 張）') && !app.innerHTML.includes('第一塊的筆記'));
  click({ '[data-toggle]': { dataset:{ toggle:'details:main' } } });
  assert.ok(app.innerHTML.includes('第一塊的筆記') && !app.innerHTML.includes('第二塊的筆記'));
  assert.ok(!app.innerHTML.includes('data-page="old"'));
  click({ '[data-page]': { dataset:{ page:'notes' } } });
  click({ '[data-toggle]': { dataset:{ toggle:'details:notes' } } });
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

test('the library page can archive and unarchive through same-origin JSON requests only', async () => {
  const { store, id, path } = fixture();
  const server = createBoardServer({ store, pollInterval: 30 });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (action, body, headers = { 'Content-Type': 'application/json', Origin: base }) => fetch(`${base}/api/boards/${id}/${action}`, { method: 'POST', headers, body: JSON.stringify(body) });
  try {
    assert.equal((await post('archive', { revision: 1 }, { 'Content-Type': 'application/json' })).status, 403);
    assert.equal((await post('archive', { revision: 1 }, { 'Content-Type': 'application/json', Origin: 'https://example.com' })).status, 403);
    assert.equal((await post('archive', { revision: 1 }, { 'Content-Type': 'text/plain', Origin: base })).status, 415);
    assert.equal((await fetch(`${base}/api/boards/${id}/archive`, { method: 'OPTIONS', headers: { Origin: 'https://example.com', 'Access-Control-Request-Method': 'POST' } })).headers.get('access-control-allow-origin'), null);
    assert.equal((await post('archive', { revision: 0 })).status, 409);
    assert.equal((await post('finish', { revision: 1 })).status, 405);
    assert.equal(readBoard(path).archived, undefined);

    const archived = await post('archive', { revision: 1 });
    assert.equal(archived.status, 200);
    assert.deepEqual(await archived.json(), { id, revision: 2, archived: true });
    const doc = readBoard(path);
    assert.equal(doc.archived, true);
    assert.equal(doc.history.at(-1).actor, 'user');
    assert.equal(doc.history.at(-1).summary, '封存討論');
    assert.match(doc.history.at(-1).reason, /網頁/);
    assert.equal(store.list()[0].archived, true);

    assert.equal((await post('archive', { revision: 2 })).status, 409);
    const restored = await post('unarchive', { revision: 2 });
    assert.equal(restored.status, 200);
    assert.equal((await restored.json()).archived, false);
    assert.equal(readBoard(path).archived, false);
    assert.equal(readBoard(path).history.at(-1).actor, 'user');
  } finally { await server.stop(); }
});

test('the library lists open actions so the page can warn before archiving', () => {
  const { store, id, path } = fixture();
  store.updateFile(path, update(readBoard(path), [
    { op: 'upsert', item: { id: 'open', kind: 'action', title: '還要做', text: '' } },
    { op: 'upsert', item: { id: 'done', kind: 'action', title: '已做完', text: '', done: true } }
  ]));
  assert.equal(store.list().find(board => board.id === id).openActions, 1);
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
  const { part } = renderViewer(doc);
  const time = (value, label) => `${new Intl.DateTimeFormat('zh-TW', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value))} ${label}`;
  const rows = (html, name) => [...html.matchAll(new RegExp(`<li class="${name}[^"]*">([\\s\\S]*?)</li>`, 'g'))].map(([, row]) => [row.match(/<span class="item-title">(.*?)<\/span>/)[1], row.match(/<time[^>]*>(.*?)<\/time>/)?.[1]]);
  assert.deepEqual(rows(part('<aside class="sidebar">'), 'decision'), [
    ['最先提出、最後確認', time('2026-10-03T01:00:00.000Z', '確認')],
    ['沒有確認紀錄的決策', time('2026-10-02T03:00:00.000Z', '確認')],
    ['先確認的共識', time('2026-10-02T01:00:00.000Z', '確認')]
  ]);
  assert.deepEqual(rows(part('<section class="attention"', '</section>'), 'attention-item'), [['仍待確認', time('2026-10-01T01:00:00.000Z', '提出')]]);
  assert.equal(part('<section class="details"'), '');
  assert.ok(part('<div class="canvas-empty">', '</div>').includes('2 項已確認的共識與決策'));
});

test('pending items come first, other cards fold into details, and the sidebar lists only confirmed decisions', () => {
  let doc = createDocument({ title: '閱讀動線', project: '/tmp/project' });
  doc = applyUpdate(doc, update(doc, [
    { op: 'page', page: { id: 'other', title: 'Slack 接入' } },
    { op: 'diagram', diagram: { id: 'flow', pageId: 'main', title: '流程圖', svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 900 300"><text>流程</text></svg>' } },
    { op: 'upsert', item: { id: 'gateway', kind: 'question', pageId: 'other', title: 'Gateway 要不要獨立部署？', text: '影響部署方式' } },
    { op: 'upsert', item: { id: 'proposal', kind: 'decision', title: '提案：採用方案 A', text: '等使用者確認' } },
    { op: 'upsert', item: { id: 'idea', kind: 'idea', title: '想法一', text: '想法內容' } },
    { op: 'upsert', item: { id: 'note', kind: 'note', title: '筆記一', text: '筆記內容', sources: ['docs/a.md'] } },
    { op: 'upsert', item: { id: 'todo', kind: 'action', title: '還沒做的事' } },
    { op: 'upsert', item: { id: 'shipped', kind: 'action', title: '已完成的事', done: true } },
    { op: 'upsert', item: { id: 'answered', kind: 'question', title: '已回答的問題', confirmed: true } },
    { op: 'upsert', item: { id: 'agreed', kind: 'consensus', title: '已確認的共識', text: '共識內容', confirmed: true } }
  ], { reason: '使用者確認了共識，也回答了問題。' }));
  const { app, click, part } = renderViewer(doc);
  const attention = () => part('<section class="attention"', '</section>');
  const details = () => part('<section class="details"', '</section>');
  const sidebar = () => part('<aside class="sidebar">');
  const at = text => app.innerHTML.indexOf(text);
  assert.ok(at('<section class="attention"') < at('class="diagram-card') && at('class="diagram-card') < at('<section class="details"'));
  assert.ok(attention().includes('待確認事項') && attention().includes('<span class="side-count">1</span>'));
  assert.ok(attention().includes('提案：採用方案 A') && attention().includes('待確認 · 決策') && !attention().includes('Gateway 要不要獨立部署？') && !attention().includes('data-page='));
  const tab = id => app.innerHTML.match(new RegExp(`<button class="sheet-tab[^"]*" data-page="${id}"[\\s\\S]*?</button>`))[0];
  assert.ok(tab('main').includes('<span class="tab-pending" title="1 項待確認">1</span>') && tab('other').includes('<span class="tab-pending" title="1 項待確認">1</span>'));
  assert.ok(attention().includes('等使用者確認') && !attention().includes('aria-expanded="false"'));
  click({ '[data-fold]': { dataset: { fold: 'attention:proposal' } } });
  assert.ok(!attention().includes('等使用者確認') && attention().includes('data-fold="attention:proposal" aria-expanded="false"'));
  click({ '[data-fold]': { dataset: { fold: 'attention:proposal' } } });
  assert.ok(attention().includes('等使用者確認'));
  const openActions = () => part('<section class="open-actions"', '</section>');
  assert.ok(at('<section class="attention"') < at('<section class="open-actions"') && at('<section class="open-actions"') < at('class="diagram-card'));
  assert.ok(openActions().includes('待進行') && openActions().includes('<span class="side-count">1</span>') && openActions().includes('還沒做的事') && !openActions().includes('已完成的事'));
  const tabOf = id => app.innerHTML.match(new RegExp(`<button class="sheet-tab[^"]*" data-page="${id}"[\\s\\S]*?</button>`))[0];
  assert.ok(tabOf('main').includes('<span class="tab-open-actions" title="1 項待進行">1</span>') && !tabOf('other').includes('tab-open-actions'));
  assert.ok(!attention().includes('還沒做的事'));
  assert.ok(details().includes('細節（4 張）') && details().includes('想法 1 · 筆記 1 · 已完成的下一步 1 · 已釐清的問題 1</span>'));
  assert.ok(!app.innerHTML.includes('筆記一') && !app.innerHTML.includes('已回答的問題'));
  click({ '[data-toggle]': { dataset: { toggle: 'details:main' } } });
  assert.deepEqual([...details().matchAll(/<h3>([\s\S]*?)<\/h3>/g)].map(match => match[1].replace(/<[^>]+>/g, '')), ['想法（1）', '筆記（1）', '已完成的下一步（1）', '已釐清的問題（1）']);
  assert.deepEqual([...details().matchAll(/data-fold="([^"]+)" aria-expanded="(true|false)"/g)].map(match => `${match[1]} ${match[2]}`), ['group:main:想法 true', 'group:main:筆記 true', 'group:main:已完成的下一步 true']);
  assert.ok(!details().includes('還沒做的事') && details().includes('已完成的事') && details().includes('已完成'));
  assert.deepEqual([...details().matchAll(/<article class="detail-card ([a-z]+)[^"]*">/g)].map(match => match[1]), ['idea', 'note', 'action', 'question']);
  assert.ok(details().includes('筆記內容') && details().includes('docs/a.md') && !details().includes('已確認的共識'));
  assert.ok(!details().includes('data-toggle="card:'));
  click({ '[data-fold]': { dataset: { fold: 'group:main:想法' } } });
  assert.ok(details().includes('想法（1）') && !details().includes('想法內容') && details().includes('筆記內容'));
  assert.ok(details().includes('data-fold="group:main:想法" aria-expanded="false"'));
  click({ '[data-fold]': { dataset: { fold: 'group:main:想法' } } });
  assert.ok(details().includes('想法內容'));
  assert.ok(sidebar().includes('已確認的共識') && sidebar().includes('1 已確認'));
  assert.ok(!sidebar().includes('待釐清') && !sidebar().includes('提案：採用方案 A') && !sidebar().includes('共識內容'));
  click({ '[data-toggle]': { dataset: { toggle: 'side:agreed' } } });
  assert.ok(sidebar().includes('共識內容'));
  click({ '[data-fold]': { dataset: { fold: 'group:main:已完成的下一步' } } });
  click({ '[data-fold]': { dataset: { fold: 'open-action:todo' } } });
  assert.ok(openActions().includes('data-fold="open-action:todo" aria-expanded="false"'));
  click({ '[data-page]': { dataset: { page: 'other' } } });
  assert.ok(app.innerHTML.includes('aria-label="Slack 接入"') && !app.innerHTML.includes('<section class="details"') && !app.innerHTML.includes('<section class="open-actions"'));
  assert.ok(attention().includes('Gateway 要不要獨立部署？') && attention().includes('待釐清') && attention().includes('影響部署方式') && !attention().includes('提案：採用方案 A'));
  click({ '[data-page]': { dataset: { page: 'main' } } });
  assert.ok(details().includes('筆記一') && details().includes('筆記內容'));
  assert.ok(details().includes('已完成的下一步（1）') && !details().includes('已完成的事'));
});

test('each option copies the question with that option only', async () => {
  let doc = createDocument({ title: '複製回覆', project: '/tmp/project' });
  doc = applyUpdate(doc, update(doc, [
    { op: 'upsert', item: { id: 'when', kind: 'question', title: '何時繼續設計？', text: '背景說明。\n選項：\nA. 先停\nB. 繼續\n補充說明。' } },
    { op: 'upsert', item: { id: 'plan', kind: 'decision', title: '提案：採用方案 A' } },
    { op: 'page', page: { id: 'other', title: '另一塊白板' } },
    { op: 'upsert', item: { id: 'elsewhere', pageId: 'other', kind: 'question', title: '別塊白板的問題', text: 'A. 甲' } },
    { op: 'upsert', item: { id: 'agreed', kind: 'consensus', title: '已確認的共識', confirmed: true } }
  ], { reason: '使用者確認了共識。' }));
  const writes = [], timers = [];
  const { click, part } = renderViewer(doc, { navigator: { clipboard: { writeText: async text => { writes.push(text); } } }, setTimeout: fn => timers.push(fn) });
  const attention = () => part('<section class="attention"', '</section>');
  const settle = () => new Promise(resolve => setImmediate(resolve));
  assert.ok(!attention().includes('data-copy="when"') && attention().includes('data-copy="when::0"') && attention().includes('data-copy="when::1"'));
  assert.ok(attention().includes('<p>背景說明。\n選項：</p>') && attention().includes('<span class="option-text">B. 繼續</span>') && attention().includes('<p>補充說明。</p>'));
  assert.ok(attention().includes('data-copy="plan"') && attention().includes('複製題目') && attention().includes('data-copy="*"'));
  click({ '[data-copy]': { dataset: { copy: 'when::1' } } });
  await settle();
  assert.equal(writes.at(-1), '［when］何時繼續設計？\nB. 繼續');
  assert.ok(attention().includes('copy-button copied" data-copy="when::1"') && !attention().includes('copied" data-copy="when::0"'));
  timers.shift()();
  assert.ok(!attention().includes('已複製'));
  click({ '[data-copy]': { dataset: { copy: 'plan' } } });
  await settle();
  assert.equal(writes.at(-1), '［plan］提案：採用方案 A');
  click({ '[data-copy]': { dataset: { copy: '*' } } });
  await settle();
  assert.equal(writes.at(-1), '［plan］提案：採用方案 A\n\n［when］何時繼續設計？\nA. 先停\nB. 繼續');
  click({ '[data-copy]': { dataset: { copy: '*' } } });
  await settle();
  assert.equal(writes.at(-1), '［plan］提案：採用方案 A\n\n［when］何時繼續設計？\nA. 先停\nB. 繼續');
});

test('detail cards show their times and list the newest first in each group', t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-01T00:00:00.000Z') });
  let doc = createDocument({ title: '卡片時間', project: '/tmp/project' });
  const at = (time, operations) => { t.mock.timers.setTime(Date.parse(time)); doc = applyUpdate(doc, update(doc, operations)); };
  at('2026-10-01T01:00:00.000Z', [{ op: 'upsert', item: { id: 'old', kind: 'note', title: '舊筆記' } }]);
  at('2026-10-02T01:00:00.000Z', [{ op: 'upsert', item: { id: 'new', kind: 'note', title: '新筆記' } }]);
  at('2026-10-03T01:00:00.000Z', [{ op: 'upsert', item: { id: 'old', kind: 'note', title: '舊筆記', text: '補充' } }]);
  const { click, part } = renderViewer(doc);
  click({ '[data-toggle]': { dataset: { toggle: 'details:main' } } });
  const cards = [...part('<section class="details"', '</section>').matchAll(/<h4>(.*?)<\/h4>[\s\S]*?<div class="card-time">([\s\S]*?)<\/div>/g)].map(([, title, time]) => [title, time.replace(/<[^>]+>/g, '')]);
  const format = value => new Intl.DateTimeFormat('zh-TW', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value));
  assert.deepEqual(cards, [
    ['新筆記', `${format('2026-10-02T01:00:00.000Z')} 建立`],
    ['舊筆記', `${format('2026-10-01T01:00:00.000Z')} 建立·${format('2026-10-03T01:00:00.000Z')} 更新`]
  ]);
});

test('items changed since the last visit in this browser are marked new', t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-01T00:00:00.000Z') });
  let doc = createDocument({ title: '新內容', project: '/tmp/project' });
  const at = (time, operations) => { t.mock.timers.setTime(Date.parse(time)); doc = applyUpdate(doc, update(doc, operations)); };
  at('2026-10-01T01:00:00.000Z', [{ op: 'page', page: { id: 'other', title: '另一塊白板' } }, { op: 'upsert', item: { id: 'seen', kind: 'note', title: '看過的筆記' } }]);
  const seenAt = doc.updatedAt;
  at('2026-10-02T01:00:00.000Z', [{ op: 'upsert', item: { id: 'fresh', kind: 'question', pageId: 'other', title: '新的問題' } }]);
  const store = new Map([[`chat-board:seen:${doc.id}`, seenAt]]);
  const localStorage = { getItem: key => store.get(key) ?? null, setItem: (key, value) => store.set(key, value) };
  const { app, click, part } = renderViewer(doc, { localStorage });
  assert.equal(store.get(`chat-board:seen:${doc.id}`), doc.updatedAt);
  const tab = id => app.innerHTML.match(new RegExp(`<button class="sheet-tab[^"]*" data-page="${id}"[\\s\\S]*?</button>`))[0];
  assert.ok(tab('other').includes('tab-new') && !tab('main').includes('tab-new'));
  click({ '[data-page]': { dataset: { page: 'other' } } });
  assert.ok(part('<section class="attention"', '</section>').includes('新的問題<span class="new-badge"'));
  click({ '[data-page]': { dataset: { page: 'main' } } });
  click({ '[data-toggle]': { dataset: { toggle: 'details:main' } } });
  assert.ok(part('<section class="details"', '</section>').includes('<h4>看過的筆記</h4>'));
  const first = renderViewer(doc, { localStorage: { getItem: () => null, setItem() {} } });
  assert.ok(!first.app.innerHTML.includes('new-badge') && !first.app.innerHTML.includes('tab-new'));
});

test('the library summary counts the items that wait for the user', () => {
  const { store, doc, path } = fixture();
  writeFileSync(path, renderDocument(applyUpdate(doc, update(doc, [
    { op: 'upsert', item: { id: 'ask', kind: 'question', title: '問題' } },
    { op: 'upsert', item: { id: 'plan', kind: 'decision', title: '提案' } },
    { op: 'upsert', item: { id: 'done', kind: 'consensus', title: '已確認', confirmed: true } }
  ], { reason: '使用者確認。' }))));
  const summary = store.list().find(board => board.id === doc.id);
  assert.equal(summary.pending, 2);
  assert.equal(summary.confirmed, 1);
});

test('linked items show whether an idea became a consensus or was implemented', () => {
  let doc = createDocument({ title: '卡片狀態', project: '/tmp/project' });
  assert.throws(() => applyUpdate(doc, update(doc, [{ op: 'upsert', item: { id: 'self', kind: 'idea', title: '自己', links: ['self'] } }])), /links/);
  assert.throws(() => applyUpdate(doc, update(doc, [{ op: 'upsert', item: { id: 'bad', kind: 'idea', title: '格式錯', links: 'x' } }])), /links/);
  doc = applyUpdate(doc, update(doc, [
    { op: 'page', page: { id: 'other', title: '另一塊白板' } },
    { op: 'upsert', item: { id: 'built', kind: 'idea', title: '已做的想法', links: ['agreed', 'shipped'] } },
    { op: 'upsert', item: { id: 'agreed-idea', kind: 'idea', title: '成為共識的想法' } },
    { op: 'upsert', item: { id: 'waiting', kind: 'idea', title: '等確認的想法', links: ['proposal'] } },
    { op: 'upsert', item: { id: 'planned', kind: 'note', title: '待實作的筆記', links: ['todo'] } },
    { op: 'upsert', item: { id: 'plain', kind: 'idea', title: '沒有連結的想法' } },
    { op: 'upsert', item: { id: 'agreed', kind: 'consensus', title: '共識甲', confirmed: true, links: ['agreed-idea'] } },
    { op: 'upsert', item: { id: 'proposal', kind: 'decision', title: '提案乙' } },
    { op: 'upsert', item: { id: 'shipped', kind: 'action', pageId: 'other', title: '已做的事', done: true } },
    { op: 'upsert', item: { id: 'todo', kind: 'action', title: '還沒做的事' } }
  ], { reason: '使用者確認共識甲。' }));
  assert.deepEqual(doc.items.find(item => item.id === 'built').links, ['agreed', 'shipped']);
  assert.deepEqual(doc.items.find(item => item.id === 'plain').links, []);
  const { click, part } = renderViewer(doc);
  click({ '[data-toggle]': { dataset: { toggle: 'details:main' } } });
  const card = title => part('<section class="details"', '</section>').match(new RegExp(`<article class="detail-card[^"]*"><div class="detail-card-heading"><h4>${title}</h4>[\\s\\S]*?</article>`))[0];
  const status = title => card(title).match(/<span class="item-status[^"]*">(.*?)<\/span>/)?.[1];
  assert.equal(status('已做的想法'), '已實作');
  assert.equal(status('成為共識的想法'), '已確認為共識');
  assert.equal(status('等確認的想法'), '待確認');
  assert.equal(status('待實作的筆記'), '待實作');
  assert.equal(status('沒有連結的想法'), undefined);
  assert.ok(card('已做的想法').includes('共識 · 已確認</span><span class="link-title">共識甲') && card('已做的想法').includes('data-page="other"'));
  assert.ok(card('成為共識的想法').includes('<span class="card-link"><span class="link-kind">共識 · 已確認'));
  assert.ok(!card('沒有連結的想法').includes('card-links'));
  click({ '[data-toggle]': { dataset: { toggle: 'side:agreed' } } });
  assert.ok(part('<aside class="sidebar">').includes('<span class="link-title">已做的想法</span>') && part('<aside class="sidebar">').includes('<span class="link-title">成為共識的想法</span>'));
});
