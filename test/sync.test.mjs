import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Store, readBoard } from '../lib/storage.mjs';
import { configureSync, syncOnce, syncStatus, resolveSyncConflict } from '../lib/sync.mjs';
import { createDocument, applyUpdate } from '../lib/document.mjs';
import { mergeDiscussion, DiscussionConflict } from '../lib/merge.mjs';

function git(repo, ...args) {
  const result = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
}
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'chat-board-sync-test-')));
  const remote = join(root, 'remote.git'); mkdirSync(remote); git(remote, 'init', '--bare');
  const machine = name => {
    const project = join(root, name, 'project'); mkdirSync(project, { recursive: true });
    const store = new Store(join(root, name, 'registry', 'index.json'));
    const repo = join(root, name, 'data');
    configureSync(store, { repo, remote });
    git(repo, 'config', 'user.name', 'Sync Test'); git(repo, 'config', 'user.email', 'sync-test@example.invalid');
    return { project, store, repo };
  };
  return { root, remote, a: machine('a'), b: machine('b') };
}
const change = (doc, id, text, extra = {}) => ({ expectedRevision: doc.revision, actor: 'ai', summary: '測試更新',
  operations: [{ op: 'upsert', item: { id, kind: 'note', title: id, text } }], ...extra });

test('every Store save pushes complete HTML; another machine discovers and reads it', () => {
  const { a, b, remote } = fixture();
  const result = a.store.create({ project: a.project, title: '跨電腦討論' });
  assert.equal(result.sync.state, 'synced');
  const remoteHtml = git(remote, 'show', `refs/heads/main:boards/${result.id}.html`);
  assert.ok(remoteHtml.includes('board-data'));
  assert.equal(syncOnce(b.store).state, 'synced');
  const received = b.store.get(result.id);
  assert.deepEqual(received.doc, readBoard(result.path));
  assert.ok(received.path.startsWith(b.repo));
  const changed = b.store.update(result.id, change(received.doc, 'b-note', '另一台電腦寫入'));
  assert.equal(changed.sync.state, 'synced');
  assert.equal(syncOnce(a.store).state, 'synced');
  assert.equal(readBoard(result.path).items[0].text, '另一台電腦寫入');
  assert.equal(git(a.repo, 'status', '--porcelain'), '');
});

test('offline saves survive and independent changes merge with both histories', () => {
  const { a, b, root, remote } = fixture();
  const created = a.store.create({ project: a.project, title: '保留雙方更新' });
  syncOnce(b.store);
  const bPath = b.store.get(created.id).path;
  git(b.repo, 'remote', 'set-url', 'origin', join(root, 'unavailable.git'));
  const offline = b.store.update(created.id, change(readBoard(bPath), 'b', '離線的 B'));
  assert.equal(offline.sync.state, 'pending');
  assert.equal(readBoard(bPath).items[0].text, '離線的 B');
  const aChanged = a.store.update(created.id, change(readBoard(created.path), 'a', '線上的 A'));
  assert.equal(aChanged.sync.state, 'synced');
  git(b.repo, 'remote', 'set-url', 'origin', remote);
  const synced = syncOnce(b.store);
  assert.equal(synced.state, 'synced');
  const merged = readBoard(bPath);
  assert.deepEqual(new Set(merged.items.map(item => item.id)), new Set(['a', 'b']));
  for (const entry of [...offline.doc.history, ...aChanged.doc.history]) assert.ok(merged.history.some(value => value.id === entry.id));
  assert.ok(merged.history.at(-1).reason.includes('未新增使用者確認'));
  syncOnce(a.store);
  assert.deepEqual(readBoard(created.path), merged);
});

test('same-item conflicts preserve local HTML and remote main, and upload a backup only once', () => {
  const { a, b, root, remote } = fixture();
  const created = a.store.create({ project: a.project, title: '衝突保護' });
  a.store.update(created.id, change(readBoard(created.path), 'shared', '原文'));
  syncOnce(b.store);
  const bPath = b.store.get(created.id).path;
  git(b.repo, 'remote', 'set-url', 'origin', join(root, 'offline.git'));
  b.store.update(created.id, change(readBoard(bPath), 'shared', 'B 的修改'));
  const localHtml = readFileSync(bPath, 'utf8');
  a.store.update(created.id, change(readBoard(created.path), 'shared', 'A 的修改'));
  const remoteBefore = git(remote, 'rev-parse', 'refs/heads/main');
  git(b.repo, 'remote', 'set-url', 'origin', remote);
  const result = syncOnce(b.store);
  assert.equal(result.state, 'conflict'); assert.ok(result.backupBranch);
  assert.equal(readFileSync(bPath, 'utf8'), localHtml);
  assert.equal(git(remote, 'rev-parse', 'refs/heads/main'), remoteBefore);
  assert.ok(git(remote, 'show', `${result.backupBranch}:boards/${created.id}.html`).includes('B 的修改'));
  assert.equal(syncOnce(b.store).backupBranch, result.backupBranch);
  assert.equal(syncStatus(b.store).state, 'conflict');
  assert.ok(!existsSync(`${bPath}.chat-board.lock`));
  assert.throws(() => resolveSyncConflict(b.store, { file: bPath, revision: 1, remoteCommit: result.remoteCommit, reason: '使用者選擇 B' }), /本機已有新版本/);
  const before = readBoard(bPath);
  const resolved = resolveSyncConflict(b.store, { file: bPath, revision: before.revision, remoteCommit: result.remoteCommit, reason: '使用者明確選擇 B 的修改' });
  assert.equal(resolved.state, 'synced');
  const resolvedDoc = readBoard(bPath);
  assert.ok(resolvedDoc.history.some(entry => entry.changes.some(change => change.after?.text === 'A 的修改')));
  assert.ok(resolvedDoc.history.at(-1).reason.includes('使用者明確選擇 B'));
  assert.ok(git(remote, 'show', `main:boards/${created.id}.html`).includes('B 的修改'));
});

test('project selection publishes only the selected records and synchronizes unregistered saved files', () => {
  const { a, remote, root } = fixture();
  const other = join(root, 'private-project'); mkdirSync(other);
  configureSync(a.store, { repo: a.repo, remote, projects: [a.project] });
  const excluded = a.store.create({ project: other, title: '未選取的討論' });
  const included = a.store.create({ project: a.project, title: '已選取的討論' });
  const paths = git(remote, 'ls-tree', '-r', '--name-only', 'main');
  assert.ok(paths.includes(included.id)); assert.ok(!paths.includes(excluded.id));
  assert.equal(included.sync.state, 'synced');
  const separate = new Store(join(root, 'separate-registry', 'index.json'));
  const unregistered = separate.create({ project: a.project, title: '尚未登記的原檔' });
  assert.ok(!a.store.entries().some(entry => entry.id === unregistered.id));
  const saved = a.store.updateFile(unregistered.path, change(unregistered.doc, 'new', '落檔就同步'));
  assert.equal(saved.sync.state, 'synced');
  assert.ok(git(remote, 'ls-tree', '-r', '--name-only', 'main').includes(unregistered.id));
});

test('merge rejects same-record edits and incompatible page relationships', () => {
  const base = createDocument({ project: '/tmp/project', title: '測試' });
  const ours = applyUpdate(base, change(base, 'shared', 'A'));
  const theirs = applyUpdate(base, change(base, 'shared', 'B'));
  assert.throws(() => mergeDiscussion(base, ours, theirs), DiscussionConflict);
  assert.deepEqual(mergeDiscussion(base, base, ours), ours);
  assert.deepEqual(mergeDiscussion(base, ours, base), ours);
});

test('a failed network push reports pending and keeps the local file and Git snapshot', () => {
  const { a, remote, root } = fixture();
  const created = a.store.create({ project: a.project, title: '推送失敗' });
  git(a.repo, 'remote', 'set-url', '--push', 'origin', join(root, 'missing.git'));
  const result = a.store.update(created.id, change(readBoard(created.path), 'pending', '尚未上傳'));
  assert.equal(result.sync.state, 'pending');
  assert.equal(readBoard(created.path).items[0].text, '尚未上傳');
  assert.ok(git(a.repo, 'show', `refs/chat-board/pending:boards/${created.id}.html`).includes('尚未上傳'));
  git(a.repo, 'remote', 'set-url', '--push', 'origin', remote);
  assert.equal(syncOnce(a.store).state, 'synced');
});
