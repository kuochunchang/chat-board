import { Store } from '../lib/storage.mjs';
import { configureSync, syncOnce, syncStatus, resolveSyncConflict, startSyncPolling } from '../lib/sync.mjs';

try {
  const [command = 'help', ...args] = process.argv.slice(2);
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    if (!args[index].startsWith('--') || !args[index + 1]) throw new Error('每個同步參數都需要值。');
    options[args[index].slice(2)] = args[index + 1];
  }
  const store = new Store(options.registry);
  let result;
  if (command === 'init') result = configureSync(store, { ...options, projects: options.projects?.split(',') });
  else if (command === 'once') result = syncOnce(store);
  else if (command === 'status') result = syncStatus(store);
  else if (command === 'resolve') result = resolveSyncConflict(store, { file: options.file, revision: options.revision, remoteCommit: options['remote-commit'], reason: options.reason });
  else if (command === 'watch') {
    const stop = startSyncPolling(store, { keepAlive: true });
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
    result = { state: 'watching', message: '定期同步討論。Ctrl+C 停止；本機 HTML 保留。' };
  }
  else if (command === 'help') result = { instructions: [
    'node bin/sync.mjs init --repo /path/to/empty-data-repo --remote https://github.com/owner/chat-board-discussions.git [--projects /absolute/project/path] [--interval 5000] [--storage project|repo]',
    'node bin/sync.mjs once', 'node bin/sync.mjs status',
    'node bin/sync.mjs watch（不需重啟既有白板服務，即可開始背景同步）',
    'node bin/sync.mjs resolve --file /path/to/reviewed.html --revision N --remote-commit SHA --reason "chat 中明確採用的整合內容與理由"',
    '設定後，每次 CLI 落檔都立即同步。npm start 運行時定期同步遠端版本並重試。',
    '未指定 --projects 時，同步所有已登記白板。設定與狀態只在本機保存。'
  ] };
  else throw new Error(`未知的同步指令：${command}`);
  console.log(JSON.stringify(result, null, 2));
} catch (error) { console.error(JSON.stringify({ error: error.message })); process.exitCode = 1; }
