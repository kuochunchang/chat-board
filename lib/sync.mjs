import { spawnSync, spawn } from 'node:child_process';
import { existsSync, readFileSync, mkdirSync, unlinkSync, realpathSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { BoardError, parseDocument, renderDocument } from './document.mjs';
import { mergeDiscussion, DiscussionConflict } from './merge.mjs';
import { withLock, atomicWrite } from './storage.mjs';

const commandPath = fileURLToPath(new URL('../bin/sync.mjs', import.meta.url));
export const syncConfigPath = store => join(dirname(store.registry), 'sync.json');
const statusPath = store => join(dirname(store.registry), 'sync-status.json');
export function readSyncConfig(store) {
  const path = syncConfigPath(store);
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
}
export function syncStatus(store) {
  const path = statusPath(store);
  return { configured: Boolean(readSyncConfig(store)), ...(existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {}) };
}

function git(repo, args, { input, env, allowFailure = false } = {}) {
  const result = spawnSync('git', ['-C', repo, ...args], {
    input, encoding: 'utf8', timeout: 30000, maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...env }
  });
  if (result.status !== 0 && !allowFailure) {
    throw new Error(`Git ${args[0]} 失敗：${result.error?.message || result.stderr?.trim() || '無法執行'}`);
  }
  return { ...result, output: result.stdout?.trim() || '' };
}

export function configureSync(store, { repo, remote, branch = 'main', projects = null, interval = 5000 }) {
  if (!repo || !remote) throw new BoardError('同步設定需要 --repo 與 --remote。');
  const checked = spawnSync('git', ['check-ref-format', `refs/heads/${branch}`]);
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch) || checked.status !== 0) throw new BoardError('同步分支名稱無效。');
  if (remote.startsWith('-') || /[\r\n\0]/.test(remote)) throw new BoardError('遠端位置無效。');
  const path = resolve(repo);
  mkdirSync(path, { recursive: true });
  if (!existsSync(join(path, '.git'))) {
    if (readdirSync(path).length) throw new BoardError('資料 repo 目錄必須為空。');
    git(path, ['init', '-b', branch]);
    git(path, ['remote', 'add', 'origin', remote]);
    git(path, ['config', 'chatboard.managed', 'true']);
  } else if (git(path, ['config', '--get', 'chatboard.managed'], { allowFailure: true }).output !== 'true') {
    throw new BoardError('請使用空目錄建立工具管理的資料 repo，避免改動其他工作目錄。');
  }
  if (git(path, ['remote', 'get-url', 'origin']).output !== remote) throw new BoardError('資料 repo 的 origin 與設定不同。');
  git(path, ['symbolic-ref', 'HEAD', `refs/heads/${branch}`]);
  const config = { repo: realpathSync(path), remote, branch, interval: Math.max(1000, Number(interval) || 5000), projects: projects?.map(p => realpathSync(resolve(p))) || null, machine: randomUUID() };
  mkdirSync(dirname(syncConfigPath(store)), { recursive: true });
  atomicWrite(syncConfigPath(store), JSON.stringify(config, null, 2));
  return config;
}

function boardFiles(repo, ref) {
  if (!ref) return [];
  return git(repo, ['ls-tree', '-r', '--name-only', '-z', ref, '--', 'boards/']).stdout.split('\0').filter(Boolean).map(path => {
    if (!/^boards\/[a-zA-Z0-9-]{1,80}\.html$/.test(path)) throw new BoardError('遠端 boards 目錄含有不支援的路徑。');
    return path;
  });
}
function documentAt(repo, ref, path, files) {
  if (!ref || !files.has(path)) return null;
  const doc = parseDocument(git(repo, ['show', `${ref}:${path}`]).stdout);
  if (path !== `boards/${doc.id}.html`) throw new BoardError('遠端檔名與白板 ID 不同。');
  return doc;
}
function makeCommit(repo, parent, documents, message) {
  const index = join(repo, '.git', `chat-board-${randomUUID()}.index`);
  const env = { GIT_INDEX_FILE: index };
  try {
    git(repo, ['read-tree', parent || '--empty'], { env });
    for (const [path, doc] of documents) {
      const blob = git(repo, ['hash-object', '-w', '--stdin'], { input: renderDocument(doc) }).output;
      git(repo, ['update-index', '--add', '--cacheinfo', '100644', blob, path], { env });
    }
    const tree = git(repo, ['write-tree'], { env }).output;
    if (parent && tree === git(repo, ['rev-parse', `${parent}^{tree}`]).output) return parent;
    const commit = git(repo, ['commit-tree', tree, ...(parent ? ['-p', parent] : [])], { input: `${message}\n` }).output;
    // Retain a local Git reference even if the subsequent network operation fails.
    git(repo, ['update-ref', 'refs/chat-board/pending', commit]);
    return commit;
  } finally { if (existsSync(index)) unlinkSync(index); }
}
function remoteTip(config) {
  const { repo, remote, branch } = config;
  const listed = git(repo, ['ls-remote', '--heads', remote, `refs/heads/${branch}`]).output;
  if (!listed) return null;
  git(repo, ['fetch', '--no-tags', 'origin', `refs/heads/${branch}:refs/remotes/origin/${branch}`]);
  return git(repo, ['rev-parse', `refs/remotes/origin/${branch}`]).output;
}

export function syncOnce(store) {
  const config = readSyncConfig(store);
  if (!config) return { state: 'disabled', configured: false };
  const { repo, branch } = config;
  let result;
  try {
    result = withLock(join(repo, '.git', 'chat-board-sync'), () => {
      if (git(repo, ['config', '--get', 'chatboard.managed']).output !== 'true') throw new BoardError('資料 repo 未由工具管理。');
      const base = git(repo, ['rev-parse', '--verify', `refs/heads/${branch}`], { allowFailure: true }).output || null;
      const baseFiles = new Set(boardFiles(repo, base));
      let remote = remoteTip(config);
      if (base && !remote) throw new BoardError('遠端同步分支已消失。保留本機版本，請在 chat 檢查。', 409);
      const entries = store.entries().filter(entry => {
        if (!existsSync(entry.path)) return false;
        const doc = parseDocument(readFileSync(entry.path, 'utf8'));
        return !config.projects || config.projects.includes(doc.project.path) || entry.path.startsWith(`${repo}/boards/`);
      });
      const sources = new Map(entries.map(entry => [`boards/${entry.id}.html`, entry.path]));
      const paths = new Set([...sources.keys(), ...baseFiles, ...boardFiles(repo, remote)]);
      // Lock source files and their mirrors before reading. CLI writes use the same locks.
      const locks = [...new Set([...paths].flatMap(path => [sources.get(path) || join(repo, path), join(repo, path)]))].sort();
      function locked(index, callback) { return index === locks.length ? callback() : withLock(locks[index], () => locked(index + 1, callback)); }
      return locked(0, () => {
        const local = new Map();
        for (const path of paths) {
          const source = sources.get(path) || join(repo, path);
          local.set(path, existsSync(source) ? parseDocument(readFileSync(source, 'utf8')) : documentAt(repo, base, path, baseFiles));
        }
        for (let attempt = 0; attempt < 3; attempt++) {
          const remoteFiles = new Set(boardFiles(repo, remote));
          if ([...remoteFiles].some(path => !paths.has(path))) {
            throw new BoardError('遠端剛新增白板。下次同步會鎖定新檔案後再整合。', 409);
          }
          const merged = new Map();
          const conflicts = [];
          for (const path of new Set([...paths, ...remoteFiles])) {
            const resolution = config.resolutions?.[path];
            const before = resolution ? documentAt(repo, resolution, path, new Set(boardFiles(repo, resolution))) : documentAt(repo, base, path, baseFiles);
            const ours = local.get(path) ?? before;
            const theirs = documentAt(repo, remote, path, remoteFiles);
            try {
              // Sync never removes a local discussion because of a remote deletion.
              if (before && !theirs && ours) throw new DiscussionConflict(['遠端已刪除本機仍保留的討論']);
              const doc = mergeDiscussion(before, ours, theirs);
              if (doc) merged.set(path, doc);
            } catch (error) {
              if (!(error instanceof DiscussionConflict)) throw error;
              conflicts.push({ path, fields: error.fields });
            }
          }
          if (conflicts.length) {
            const fingerprint = createHash('sha256').update(JSON.stringify({ remote, local: [...local] })).digest('hex');
            const conflictPath = join(repo, '.git', 'chat-board-conflict.json');
            const previous = existsSync(conflictPath) ? JSON.parse(readFileSync(conflictPath, 'utf8')) : null;
            if (previous?.fingerprint === fingerprint && previous.result.backupBranch) return previous.result;
            const snapshot = makeCommit(repo, base, [...local].filter(([, doc]) => doc), '保留同步衝突的本機 HTML');
            const backupBranch = `conflicts/${config.machine}/${randomUUID()}`;
            const pushed = git(repo, ['push', 'origin', `${snapshot}:refs/heads/${backupBranch}`], { allowFailure: true });
            const conflictResult = { state: 'conflict', remoteCommit: remote, conflicts, backupBranch: pushed.status === 0 ? backupBranch : null, localCommit: snapshot,
              message: '本機 HTML 與遠端版本均保留。請在 chat 整合內容後重試。' };
            atomicWrite(conflictPath, JSON.stringify({ fingerprint, result: conflictResult }));
            return conflictResult;
          }
          const commit = makeCommit(repo, remote, merged, '同步討論 HTML 與完整歷史');
          if (commit && commit !== remote) {
            const pushed = git(repo, ['push', 'origin', `${commit}:refs/heads/${branch}`], { allowFailure: true });
            if (pushed.status !== 0) {
              const latest = remoteTip(config);
              if (latest === remote) throw new Error(`Git push 失敗：${pushed.stderr?.trim() || pushed.error?.message}`);
              remote = latest;
              continue;
            }
          }
          for (const [path, doc] of merged) {
            const html = renderDocument(doc);
            const mirror = join(repo, path);
            if (!existsSync(mirror) || readFileSync(mirror, 'utf8') !== html) atomicWrite(mirror, html);
            const source = sources.get(path);
            if (source && source !== mirror && readFileSync(source, 'utf8') !== html) atomicWrite(source, html);
          }
          if (commit) {
            git(repo, ['update-ref', `refs/heads/${branch}`, commit]);
            git(repo, ['read-tree', commit]);
          }
          for (const [path] of merged) if (!sources.has(path)) store.register(join(repo, path));
          if (config.resolutions) {
            delete config.resolutions;
            atomicWrite(syncConfigPath(store), JSON.stringify(config, null, 2));
          }
          return { state: 'synced', commit, boards: merged.size, remote: config.remote };
        }
        throw new BoardError('遠端持續有新版本。本機內容已保留，下次同步再試。', 409);
      });
    });
  } catch (error) {
    result = { state: error.status === 409 ? 'busy' : 'pending', message: error.message };
  }
  const status = { ...result, at: new Date().toISOString() };
  atomicWrite(statusPath(store), JSON.stringify(status, null, 2));
  return status;
}

// Explicit chat review chooses the current local content. Keep both prior histories.
export function resolveSyncConflict(store, { file, revision, remoteCommit, reason }) {
  const config = readSyncConfig(store);
  if (!config || !file || !reason?.trim() || !/^[a-f0-9]{40}$/.test(remoteCommit || '')) {
    throw new BoardError('整合衝突需要 --file、--revision、--remote-commit 與 --reason。請先在 chat 釐清雙方內容。');
  }
  withLock(join(config.repo, '.git', 'chat-board-sync'), () => {
    const latest = remoteTip(config);
    if (latest !== remoteCommit) throw new BoardError('遠端已有新版本，請先讀取後再整合。', 409);
    const path = realpathSync(resolve(file));
    withLock(path, () => {
      const local = parseDocument(readFileSync(path, 'utf8'));
      if (local.revision !== Number(revision)) throw new BoardError('本機已有新版本，請重新讀取後再整合。', 409);
      const boardPath = `boards/${local.id}.html`;
      const remote = documentAt(config.repo, latest, boardPath, new Set(boardFiles(config.repo, latest)));
      if (!remote) throw new BoardError('遠端沒有這份討論，請在 chat 檢查刪除原因。', 409);
      const history = new Map();
      for (const entry of [...remote.history, ...local.history]) {
        if (history.has(entry.id) && JSON.stringify(history.get(entry.id)) !== JSON.stringify(entry)) throw new BoardError('相同歷史 ID 的內容不同，不能自動整合。', 409);
        history.set(entry.id, entry);
      }
      const doc = structuredClone(local);
      doc.revision = Math.max(local.revision, remote.revision) + 1;
      doc.updatedAt = new Date().toISOString();
      doc.history = [...history.values(), { id: randomUUID(), at: doc.updatedAt, actor: 'ai', summary: '依 chat 決定整合同步衝突',
        reason: `${reason}\n保留雙方歷史。採用目前本機圖文；已檢查遠端 commit ${latest} 與本機版本 ${local.revision}。`,
        changes: [{ op: 'checkpoint', label: '明確選擇整合後的本機內容，保留雙方原文於歷史與 Git。' }] }];
      const html = renderDocument(doc);
      config.resolutions ||= {};
      config.resolutions[boardPath] = latest;
      atomicWrite(syncConfigPath(store), JSON.stringify(config, null, 2));
      atomicWrite(path, html);
    });
    store.register(path);
  });
  return syncOnce(store);
}

export function syncAfterSave(store, file) {
  if (!existsSync(syncConfigPath(store))) return undefined;
  if (file) store.register(file);
  const result = spawnSync(process.execPath, [commandPath, 'once', '--registry', store.registry], {
    encoding: 'utf8', maxBuffer: 1024 * 1024, env: process.env
  });
  try { return JSON.parse(result.stdout); }
  catch { return { state: 'pending', message: 'HTML 已保存。同步未完成，請用 sync status 檢查，或用 sync once 重試。' }; }
}

export function startSyncPolling(store, { keepAlive = false } = {}) {
  let child;
  const tick = () => {
    if (child || !existsSync(syncConfigPath(store))) return;
    child = spawn(process.execPath, [commandPath, 'once', '--registry', store.registry], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', data => { output += data; });
    child.stderr.on('data', () => {});
    child.on('error', error => { console.error(`GitHub 同步無法啟動：${error.message}`); });
    child.on('close', () => {
      child = null;
      try { const state = JSON.parse(output); if (!['synced', 'disabled', 'busy'].includes(state.state)) console.error(`GitHub 同步：${state.state}；${state.message}`); }
      catch { console.error('GitHub 同步未完成，請用 sync status 檢查。'); }
    });
  };
  const interval = readSyncConfig(store)?.interval || 5000;
  const timer = setInterval(tick, interval); if (!keepAlive) timer.unref(); tick();
  // Let a running worker release its file locks before it exits.
  return () => { clearInterval(timer); };
}
