import { createServer } from 'node:http';
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from './lib/storage.mjs';
import { BoardError, renderDocument } from './lib/document.mjs';
import { startSyncPolling } from './lib/sync.mjs';

const assets = {
  '/': [new URL('./web/index.html', import.meta.url), 'text/html; charset=utf-8'],
  '/library-viewer.js': [new URL('./web/library-viewer.js', import.meta.url), 'text/javascript; charset=utf-8'],
  '/board.css': [new URL('./web/board.css', import.meta.url), 'text/css; charset=utf-8']
};

export function createBoardServer({ store = new Store(), pollInterval = 700 } = {}) {
  const clients = new Set();
  const versions = new Map();
  const sendEvent = (name, data) => {
    const message = `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const response of clients) response.write(message);
  };
  const poll = setInterval(() => {
    try {
      for (const entry of store.entries()) {
        let version;
        try { const stat = statSync(entry.path); version = `${stat.mtimeMs}:${stat.size}:${stat.ino}`; }
        catch { version = 'unavailable'; }
        if (versions.has(entry.id) && versions.get(entry.id) !== version) sendEvent(version === 'unavailable' ? 'unavailable' : 'board', { id: entry.id });
        else if (!versions.has(entry.id)) sendEvent('board', { id: entry.id });
        versions.set(entry.id, version);
      }
    } catch { /* Keep existing connections alive when the registry is unavailable. */ }
  }, pollInterval);
  poll.unref();
  const heartbeat = setInterval(() => { for (const response of clients) response.write(': keepalive\n\n'); }, 20000);
  heartbeat.unref();

  function json(response, status, data) {
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify(data));
  }
  const server = createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
    try {
      const address = server.address();
      const allowedHosts = new Set([`127.0.0.1:${address.port}`, `localhost:${address.port}`]);
      if (!allowedHosts.has(request.headers.host)) throw new BoardError('只接受本機連線。', 403);
      const url = new URL(request.url, `http://${request.headers.host}`);
      if (!['GET', 'HEAD'].includes(request.method)) {
        response.setHeader('Allow', 'GET, HEAD');
        throw new BoardError('白板只供顯示。請在 chat session 中討論，由 AI 使用 CLI 更新 HTML。', 405);
      }
      if (request.method === 'GET' && url.pathname === '/api/events') {
        response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
        response.write(': connected\n\n'); clients.add(response);
        request.on('close', () => clients.delete(response)); return;
      }
      if (request.method === 'GET' && url.pathname === '/api/boards') return json(response, 200, { boards: store.list() });
      const apiMatch = url.pathname.match(/^\/api\/boards\/([a-zA-Z0-9-]+)$/);
      if (apiMatch && request.method === 'GET') return json(response, 200, store.get(apiMatch[1]));
      const boardMatch = url.pathname.match(/^\/boards\/([a-zA-Z0-9-]+)$/);
      if (boardMatch && request.method === 'GET') {
        const { doc } = store.get(boardMatch[1]);
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        response.end(renderDocument(doc)); return;
      }
      if (request.method === 'GET' && assets[url.pathname]) {
        const [file, type] = assets[url.pathname];
        response.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' }); response.end(readFileSync(file)); return;
      }
      if (url.pathname === '/favicon.ico') { response.writeHead(204); response.end(); return; }
      throw new BoardError('找不到這個頁面。', 404);
    } catch (error) {
      const status = error.status || (error.code === 'EACCES' || error.code === 'EPERM' ? 403 : error.code === 'ENOENT' ? 404 : 500);
      const message = error.code === 'EACCES' || error.code === 'EPERM' ? '沒有權限存取指定路徑，請選擇可讀寫的專案目錄。' : error.message;
      if (!response.headersSent) json(response, status, { error: message }); else response.end();
    }
  });
  server.on('close', () => { clearInterval(poll); clearInterval(heartbeat); for (const response of clients) response.end(); clients.clear(); });
  server.stop = () => { for (const response of clients) response.end(); return new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); };
  return server;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const port = Number(process.env.CHAT_BOARD_PORT || 4317);
  const server = createBoardServer();
  const stopSync = startSyncPolling(new Store());
  server.on('close', stopSync);
  server.on('error', error => {
    console.error(error.code === 'EADDRINUSE' ? `連接埠 ${port} 已被使用。可用 CHAT_BOARD_PORT=4318 npm start 指定其他連接埠。` : error.message);
    process.exitCode = 1;
  });
  server.listen(port, '127.0.0.1', () => console.log(`共板已開啟 → http://127.0.0.1:${port}\nHTML 是討論紀錄；Ctrl+C 可停止伺服器。`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.stop().then(() => process.exit(0)));
}
