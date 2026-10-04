import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Store, readBoard } from '../lib/storage.mjs';
import { configureSync, syncOnce, syncStatus, resolveSyncConflict, setupSync } from '../lib/sync.mjs';
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

test('repo storage creates the record directly in the data repo and honors an explicit file', () => {
  const { a, remote } = fixture();
  configureSync(a.store, { repo: a.repo, remote, storage: 'repo' });
  const created = a.store.create({ project: a.project, title: '直接保存資料 repo' });
  assert.equal(created.path, join(a.repo, 'boards', `${created.id}.html`));
  assert.equal(created.doc.project.path, a.project);
  assert.equal(created.sync.state, 'synced');
  assert.ok(!existsSync(join(a.project, 'docs', 'discussions')));
  const explicit = a.store.create({ project: a.project, title: '指定位置', file: 'custom.html' });
  assert.equal(explicit.path, join(a.project, 'custom.html'));
  assert.equal(explicit.sync.state, 'synced');
  assert.throws(() => configureSync(a.store, { repo: a.repo, remote, storage: 'unknown' }), /storage/);
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

test('a fresh computer uses the shared reference to download all discussions and keep original metadata', () => {
  const { a, root, remote } = fixture();
  const first = a.store.create({ project: a.project, title: '已結束的討論' });
  a.store.update(first.id, { expectedRevision: first.doc.revision, actor: 'ai', summary: '結束', operations: [{ op: 'finish' }] });
  const second = a.store.create({ project: a.project, title: '另一份討論' });
  const folder = join(root, 'fresh', 'tool'); mkdirSync(folder, { recursive: true });
  const manifest = join(folder, 'discussion-repo.json');
  writeFileSync(manifest, JSON.stringify({ remote, directory: '../discussions', storage: 'repo' }));
  const store = new Store(join(folder, '.chat-board', 'index.json'));
  assert.equal(store.list().length, 0);
  const setup = setupSync(store, { manifest });
  assert.equal(setup.configured, true);
  assert.equal(syncOnce(store).state, 'synced');
  assert.equal(store.list().length, 2);
  assert.equal(store.get(first.id).doc.status, 'finished');
  assert.deepEqual(store.get(second.id).doc, a.store.get(second.id).doc);
  assert.ok(store.get(first.id).path.startsWith(join(root, 'fresh', 'discussions')));
  assert.equal(store.get(first.id).doc.project.path, a.project);
  assert.equal(setupSync(store, { manifest }).registered, 0);
});

test('an existing data clone is registered without network access or editing its HTML', () => {
  const { a, root, remote } = fixture();
  const created = a.store.create({ project: a.project, title: '已 clone 的討論' });
  const clone = join(root, 'cloned-data');
  git(root, 'clone', '--branch', 'main', remote, clone);
  const file = join(clone, 'boards', `${created.id}.html`);
  const original = readFileSync(file, 'utf8');
  writeFileSync(`${file}.chat-board.lock`, '');
  const store = new Store(join(root, 'new-registry', 'index.json'));
  configureSync(store, { repo: clone, remote, storage: 'repo' });
  assert.equal(store.list().length, 1);
  assert.equal(readFileSync(file, 'utf8'), original);
  assert.equal(store.get(created.id).doc.project.path, a.project);
  assert.equal(git(clone, 'config', '--get', 'chatboard.managed'), 'true');
  git(clone, 'remote', 'set-url', 'origin', 'git@github.com:example/discussions.git');
  const ssh = configureSync(store, { repo: clone, remote: 'https://github.com/example/discussions.git', storage: 'repo' });
  assert.equal(ssh.remote, 'git@github.com:example/discussions.git');
  // Reconstruct references while offline. A downloaded HTML needs no GitHub connection.
  git(clone, 'remote', 'set-url', 'origin', join(root, 'offline.git'));
  const config = join(root, 'new-registry', 'sync.json');
  const nextStore = new Store(join(root, 'next-registry', 'index.json'));
  mkdirSync(join(root, 'next-registry')); writeFileSync(join(root, 'next-registry', 'sync.json'), readFileSync(config));
  assert.equal(setupSync(nextStore).registered, 1);
  assert.deepEqual(nextStore.get(created.id).doc, store.get(created.id).doc);
});

test('connecting a cloned repository rejects mismatched origins and source-code repositories', () => {
  const { a, root, remote } = fixture();
  const created = a.store.create({ project: a.project, title: '資料' });
  const clone = join(root, 'wrong-clone');git(root, 'clone', '--branch', 'main', remote, clone);
  const store = new Store(join(root, 'rejected', 'index.json'));
  assert.throws(() => configureSync(store, { repo: clone, remote: join(root, 'another.git') }), /origin/);
  assert.equal(git(clone, 'config', '--get', 'remote.origin.url'), remote);
  writeFileSync(join(clone, 'source.mjs'), 'export default 1;');
  git(clone, 'add', 'source.mjs');
  assert.throws(() => configureSync(store, { repo: clone, remote }), /資料 repo 以外/);
  assert.ok(!existsSync(join(root, 'rejected', 'sync.json')));
  assert.equal(readBoard(join(clone, 'boards', `${created.id}.html`)).id, created.id);
});
