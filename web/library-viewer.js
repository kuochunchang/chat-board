(() => {
  'use strict';
  const esc = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
  const date = value => new Intl.DateTimeFormat('zh-TW', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value));
  const help = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 1 1 4 2c-1.5 1-1.5 1-1.5 3m0 3h.01"/></svg>';
  const icon = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="14" rx="2"/><path d="m8 22 4-4 4 4M8 8h8M8 12h5"/></svg>';
  document.getElementById('app').innerHTML = `<header class="topbar"><a class="brand" href="/"><span class="brand-mark">${icon}</span><span><span class="brand-name">共板</span><span class="brand-sub" style="display:block">THINK TOGETHER</span></span></a><span class="save-status"><span class="status-dot"></span>本地討論白板</span></header><main class="page"><div class="library-header"><h2 id="board-count">最近的討論</h2><span class="canvas-hint">由 AI 隨討論進展整理</span></div><section class="library-grid" id="board-list" aria-label="討論紀錄"></section><details class="library-archived" id="archived-section" hidden><summary id="archived-count">已封存</summary><section class="library-grid" id="archived-list" aria-label="已封存的討論"></section></details><footer class="footer"><span>共板 · 本機使用 · 無需帳號</span><span>在對話中討論，在白板上看見進展</span></footer></main>`;
  const cardBody = board => `<${board.unavailable ? 'article' : 'a'} class="library-card" ${board.unavailable ? '' : `href="/boards/${esc(board.id)}"`}><span class="badge ${board.unavailable ? 'pending' : ''}">${board.unavailable ? '檔案無法讀取' : board.archived ? '已封存' : board.status === 'finished' ? '已完成' : '討論進行中'}</span><h3>${esc(board.title)}</h3><p>${esc(board.unavailable ? board.error : board.topic)}</p>${!board.unavailable && board.pending ? `<span class="library-pending">${help}${board.pending} 項待確認</span>` : ''}<div class="library-card-meta"><span>${esc(board.project?.name || '')}</span><span>${board.unavailable ? '' : `${board.pages} 塊白板 · ${board.confirmed} 已確認`}</span></div>${board.updatedAt && !board.unavailable ? `<div class="library-updated"><time datetime="${esc(board.updatedAt)}">${date(board.updatedAt)} 更新</time></div>` : ''}</${board.unavailable ? 'article' : 'a'}>`;
  const card = board => board.unavailable ? cardBody(board) : `<div class="library-item">${cardBody(board)}<button type="button" class="library-action" data-id="${esc(board.id)}">${board.archived ? '取消封存' : '封存'}</button></div>`;
  let boards = [];
  function toast(message) {
    document.querySelector('.toast')?.remove();
    const element = document.createElement('div'); element.className = 'toast'; element.setAttribute('role', 'status'); element.textContent = message;
    document.body.append(element); setTimeout(() => element.remove(), 4000);
  }
  async function toggleArchive(button) {
    const board = boards.find(item => item.id === button.dataset.id);
    if (!board) return;
    const action = board.archived ? 'unarchive' : 'archive';
    const open = [board.pending && `${board.pending} 項待確認`, board.openActions && `${board.openActions} 項待進行`].filter(Boolean);
    if (action === 'archive' && open.length && !confirm(`「${board.title}」還有 ${open.join('、')}。仍要封存嗎？`)) return;
    button.disabled = true; button.textContent = action === 'archive' ? '封存中…' : '取消封存中…';
    try {
      const response = await fetch(`/api/boards/${encodeURIComponent(board.id)}/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision: board.revision }) });
      const result = await response.json(); if (!response.ok) throw new Error(result.error);
      const pending = result.sync && !['synced', 'disabled'].includes(result.sync.state);
      toast(`${action === 'archive' ? '已封存' : '已取消封存'}「${board.title}」${pending ? '。GitHub 同步稍後由背景重試。' : ''}`);
    } catch (error) { toast(`${action === 'archive' ? '封存' : '取消封存'}失敗：${error.message}`); }
    await refresh();
  }
  document.addEventListener('click', event => { const button = event.target.closest('.library-action'); if (button && !button.disabled) toggleArchive(button); });
  async function refresh() {
    try {
      const response = await fetch('/api/boards', { cache: 'no-store' });
      const result = await response.json(); if (!response.ok) throw new Error(result.error);
      boards = result.boards;
      const active = result.boards.filter(board => !board.archived);
      const archived = result.boards.filter(board => board.archived);
      document.getElementById('board-count').textContent = `最近的討論 · ${active.length}`;
      document.getElementById('board-list').innerHTML = active.length ? active.map(card).join('') : `<div class="empty library-empty">${icon}<h3>第一個問題，從對話開始</h3><p>在 chat session 告訴 AI 專案位置和討論主題，白板就會出現在這裡。</p></div>`;
      document.getElementById('archived-section').hidden = !archived.length;
      document.getElementById('archived-count').textContent = `已封存 · ${archived.length}`;
      document.getElementById('archived-list').innerHTML = archived.map(card).join('');
    } catch (error) { document.getElementById('board-list').innerHTML = `<div class="empty library-empty">無法讀取白板：${esc(error.message)}</div>`; }
  }
  refresh();
  const events = new EventSource('/api/events');
  events.addEventListener('board', refresh); events.addEventListener('unavailable', refresh); events.onopen = refresh;
})();
