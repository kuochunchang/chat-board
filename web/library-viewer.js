(() => {
  'use strict';
  const esc = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
  const icon = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="14" rx="2"/><path d="m8 22 4-4 4 4M8 8h8M8 12h5"/></svg>';
  document.getElementById('app').innerHTML = `<header class="topbar"><a class="brand" href="/"><span class="brand-mark">${icon}</span><span><span class="brand-name">共板</span><span class="brand-sub" style="display:block">THINK TOGETHER</span></span></a><span class="save-status"><span class="status-dot"></span>本地討論白板</span></header><main class="page"><section class="library-hero"><div class="eyebrow">A SPACE FOR SHARED THINKING</div><h1>一起把事情想清楚。</h1><p>討論留在 chat session，圖、筆記與決策呈現在這裡。<br>每場討論都是一份 HTML，跟著你的專案，也跟著思考往前走。</p></section><div class="library-header"><h2 id="board-count">最近的討論</h2><span class="canvas-hint">由 AI 隨討論進展整理</span></div><section class="library-grid" id="board-list" aria-label="討論紀錄"></section><details class="library-archived" id="archived-section" hidden><summary id="archived-count">已封存</summary><section class="library-grid" id="archived-list" aria-label="已封存的討論"></section></details><section class="library-how"><div><h3><span class="step-number">01</span>在對話裡提出問題</h3><p>告訴 AI 這次的專案和討論主題，就能建立或繼續那份 HTML 白板。</p></div><div><h3><span class="step-number">02</span>白板跟著討論更新</h3><p>AI 整理 SVG、筆記、共識與待釐清事項。開著的白板會同步顯示進展。</p></div><div><h3><span class="step-number">03</span>HTML 就是紀錄</h3><p>討論結束，圖與決策脈絡已經留在 HTML。直接開啟即可離線閱讀。</p></div></section><footer class="footer"><span>共板 · 本機使用 · 無需帳號</span><span>在對話中討論，在白板上看見進展</span></footer></main>`;
  const card = board => `<${board.unavailable ? 'article' : 'a'} class="library-card" ${board.unavailable ? '' : `href="/boards/${esc(board.id)}"`}><span class="badge ${board.unavailable ? 'pending' : ''}">${board.unavailable ? '檔案無法讀取' : board.archived ? '已封存' : board.status === 'finished' ? '已完成' : '討論進行中'}</span><h3>${esc(board.title)}</h3><p>${esc(board.unavailable ? board.error : board.topic)}</p><div class="library-card-meta"><span>${esc(board.project?.name || '')}</span><span>${board.unavailable ? '' : `${board.pages} 塊白板 · ${board.confirmed} 已確認`}</span></div></${board.unavailable ? 'article' : 'a'}>`;
  async function refresh() {
    try {
      const response = await fetch('/api/boards', { cache: 'no-store' });
      const result = await response.json(); if (!response.ok) throw new Error(result.error);
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
