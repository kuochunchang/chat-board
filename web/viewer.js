(() => {
  'use strict';
  let doc = JSON.parse(document.getElementById('board-data').textContent);
  let view = 'board';
  const pages = () => doc.pages || [{ id: 'main', title: '討論白板', description: '' }];
  let pageId = pages()[0].id;
  let connected = false;
  let filePath = '';
  const online = location.protocol !== 'file:' && /^\/boards\/[a-zA-Z0-9-]+$/.test(location.pathname);
  const kinds = { question: ['待釐清', 'help'], idea: ['想法', 'spark'], note: ['筆記', 'note'], consensus: ['共識', 'check'], decision: ['決策', 'branch'], action: ['下一步', 'arrow'] };
  const paths = {
    board: '<rect x="3" y="4" width="18" height="14" rx="2"/><path d="M8 22l4-4 4 4M8 8h8M8 12h5"/>',
    folder: '<path d="M3 7V5a1 1 0 0 1 1-1h5l2 3h9a1 1 0 0 1 1 1v11H3z"/>',
    arrow: '<path d="M5 12h14m-6-6l6 6-6 6"/>',
    check: '<path d="m5 12 4 4L19 6"/>',
    branch: '<circle cx="6" cy="5" r="2"/><circle cx="18" cy="5" r="2"/><circle cx="12" cy="19" r="2"/><path d="M6 7v4l6 5 6-5V7m-6 4v6"/>',
    help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 1 1 4 2c-1.5 1-1.5 1-1.5 3m0 3h.01"/>',
    note: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8h8M8 12h8M8 16h4"/>',
    spark: '<path d="m12 3 2.3 6.7L21 12l-6.7 2.3L12 21l-2.3-6.7L3 12l6.7-2.3z"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    leaf: '<path d="M20 4C6 2 2 10 7 16s13 2 13-12zM5 21l10-12"/>',
    chat: '<path d="M4 4h16v12H9l-5 4zM8 8h8M8 12h5"/>'
  };
  const icon = name => `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${paths[name] || paths.note}</svg>`;
  const esc = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
  const date = value => new Intl.DateTimeFormat('zh-TW', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value));
  const confirmed = () => doc.items.filter(item => ['consensus', 'decision'].includes(item.kind) && item.confirmed);

  // Render SVG as a self-contained image, with no scripts or external resources.
  function svgUrl(source) {
    const parsed = new DOMParser().parseFromString(source, 'image/svg+xml');
    if (parsed.querySelector('parsererror') || parsed.documentElement.localName !== 'svg') throw new Error('SVG 格式無效。');
    const tags = new Set(['svg','g','defs','path','rect','circle','ellipse','line','polyline','polygon','text','tspan','textPath','marker','linearGradient','radialGradient','stop','clipPath','mask','title','desc','use','symbol']);
    const attrs = new Set(['xmlns','viewbox','width','height','x','y','x1','x2','y1','y2','cx','cy','r','rx','ry','d','points','fill','fill-opacity','fill-rule','stroke','stroke-width','stroke-opacity','stroke-linecap','stroke-linejoin','stroke-dasharray','stroke-dashoffset','opacity','transform','font-family','font-size','font-weight','text-anchor','dominant-baseline','alignment-baseline','dx','dy','id','marker-start','marker-mid','marker-end','markerwidth','markerheight','markerunits','refx','refy','orient','gradientunits','gradienttransform','offset','stop-color','stop-opacity','clip-path','clippathunits','mask','maskunits','preserveaspectratio','href','xlink:href','startoffset','lengthadjust','textlength']);
    for (const element of [parsed.documentElement, ...parsed.documentElement.querySelectorAll('*')]) {
      if (!tags.has(element.localName)) { element.remove(); continue; }
      for (const attr of [...element.attributes]) {
        const name = attr.name.toLowerCase(), value = attr.value.trim();
        const external = /url\s*\(/i.test(value) && !/^url\(#[a-zA-Z0-9_.:-]+\)$/.test(value);
        if (!attrs.has(name) || external || ((name === 'href' || name === 'xlink:href') && !/^#[a-zA-Z0-9_.:-]+$/.test(value))) element.removeAttribute(attr.name);
      }
    }
    const root = parsed.documentElement;
    const viewBox = root.getAttribute('viewbox') || root.getAttribute('viewBox');
    if (viewBox) {
      const parts = viewBox.trim().split(/[\s,]+/).map(Number);
      if (parts.length === 4 && parts[2] > 0 && parts[3] > 0) {
        if (!root.hasAttribute('width') || root.getAttribute('width') === '100%') root.setAttribute('width', String(parts[2]));
        if (!root.hasAttribute('height') || root.getAttribute('height') === '100%') root.setAttribute('height', String(parts[3]));
      }
    }
    for (const el of [root, ...root.querySelectorAll('*')]) {
      if (el.hasAttribute('font-size')) {
        const val = parseFloat(el.getAttribute('font-size'));
        if (!isNaN(val) && val > 16) {
          el.setAttribute('font-size', String(Math.round((16 + (val - 16) * 0.35) * 10) / 10));
        }
      }
    }
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(parsed.documentElement))}`;
  }
  function diagramHtml(diagram) {
    let image;
    try { image = `<img src="${esc(svgUrl(diagram.svg))}" alt="${esc(diagram.title)}">`; }
    catch (error) { image = `<p class="form-error">${esc(error.message)}</p>`; }
    return `<article class="diagram-card"><div class="card-heading"><h3>${esc(diagram.title)}</h3></div><div class="diagram-frame">${image}</div>${diagram.caption ? `<p class="caption">${esc(diagram.caption)}</p>` : ''}</article>`;
  }
  function noteHtml(item) {
    return `<article class="sticky ${esc(item.kind)} ${item.done ? 'done' : ''}"><div class="card-heading"><span class="note-type">${icon(kinds[item.kind][1])}${esc(kinds[item.kind][0])}</span></div><h3>${esc(item.title)}</h3><p class="note-text">${esc(item.text)}</p>${item.sources.map(source => `<span class="source">${esc(source)}</span>`).join('')}<div class="note-footer"><span>${item.kind === 'action' ? item.done ? '已完成' : '待進行' : item.confirmed ? '已釐清' : item.kind === 'question' ? '等待釐清' : '討論中'}</span><span>${date(item.updatedAt)}</span></div></article>`;
  }
  function decisionHtml(item, full = false) {
    return `<article class="${full ? 'decision-full' : 'decision'}"><span class="badge ${item.confirmed ? '' : 'pending'}">${item.confirmed ? icon('check') : ''}${item.confirmed ? '已確認' : '待確認'} · ${esc(kinds[item.kind][0])}</span><h3>${esc(item.title)}</h3><p>${esc(item.text)}</p>${item.sources.map(source => `<span class="source">${esc(source)}</span>`).join('')}</article>`;
  }
  function boardView() {
    const belongs = item => (item.pageId || pages()[0].id) === pageId;
    const page = pages().find(page => page.id === pageId) || pages()[0];
    const diagrams = doc.diagrams.filter(belongs);
    const notes = doc.items.filter(item => belongs(item) && !['consensus', 'decision'].includes(item.kind));
    const localDecisions = doc.items.filter(item => belongs(item) && ['consensus', 'decision'].includes(item.kind));
    const decisions = doc.items.filter(item => ['consensus', 'decision'].includes(item.kind));
    const questions = doc.items.filter(item => item.kind === 'question' && !item.confirmed);
    return `<div class="workspace-grid"><section class="canvas" aria-label="${esc(page.title)}"><div class="canvas-header"><span class="section-title">${icon('board')}${esc(page.title)}</span><span class="canvas-hint">第 ${pages().findIndex(value => value.id === pageId) + 1} 塊白板 / 共 ${pages().length} 塊</span></div>${page.description ? `<p class="page-description">${esc(page.description)}</p>` : ''}${diagrams.map(diagramHtml).join('')}${notes.length ? `<div class="notes-grid">${notes.map(noteHtml).join('')}</div>` : ''}${localDecisions.length ? `<div class="decisions-grid">${localDecisions.map(item => decisionHtml(item,true)).join('')}</div>` : ''}${!diagrams.length && !notes.length && !localDecisions.length ? `<div class="canvas-empty">${icon('board')}<h3>這塊白板，留給接下來的想法</h3><p>我們在 chat session 繼續討論，<br>AI 會把相關圖與筆記整理到這裡。</p></div>` : ''}</section><aside class="sidebar"><section class="side-panel"><div class="side-heading"><h2>${icon('check')}共識與決策</h2><span class="side-count">${confirmed().length} 已確認</span></div>${decisions.length ? decisions.map(item => decisionHtml(item)).join('') : '<div class="empty">在對話中確認過的方向會留在這裡。</div>'}</section><section class="side-panel"><div class="side-heading"><h2>${icon('help')}待釐清</h2><span class="side-count">${questions.length}</span></div>${questions.length ? `<div class="pending-list">${questions.map(item => `<div class="pending-item"><span class="pending-bullet"></span><span>${esc(item.title)}</span></div>`).join('')}</div>` : '<div class="empty">目前沒有待釐清的問題。</div>'}</section><div class="aside-note">${icon('chat')}<span>討論留在 chat session。多塊白板與決策脈絡，都已保存在同一份 HTML 裡。</span></div></aside></div>`;
  }
  function changeText(change) {
    const describe = value => typeof value === 'object' && value ? `${value.title || ''}\n${value.text || value.caption || value.topic || ''}${value.svg ? '\n［SVG 圖，完整內容保存在 HTML 資料中］' : ''}${value.confirmed !== undefined ? `\n${value.confirmed ? '已確認' : '待確認'}` : ''}` : String(value ?? '');
    if (change.op === 'checkpoint') return `里程碑：${change.label}`;
    return `${change.before ? `原內容\n${describe(change.before)}\n\n` : ''}${change.after !== null && change.after !== undefined ? `更新後\n${describe(change.after)}` : '已從白板移除，原內容仍保留在這裡。'}`;
  }
  function historyView() {
    return `<section class="history-view"><p class="view-intro">從對話整理出思考的轉折與選擇的理由。完整討論留在 chat session，這裡保留白板的演進紀錄。</p>${[...doc.history].reverse().map(entry => `<article class="timeline-item"><div class="timeline-meta"><span class="actor">${entry.actor === 'ai' ? 'AI 整理' : '開始討論'}</span><time>${date(entry.at)}</time></div><h3>${esc(entry.summary)}</h3>${entry.reason ? `<p>${esc(entry.reason)}</p>` : ''}${entry.changes.length ? `<details><summary>查看這次更新 · ${entry.changes.length} 項</summary>${entry.changes.map(change => `<div class="change-box">${esc(changeText(change))}</div>`).join('')}</details>` : ''}</article>`).join('')}</section>`;
  }
  function render() {
    const scroll = window.scrollY;
    if (!pages().some(page => page.id === pageId)) pageId = pages()[0].id;
    document.title = `${doc.title} · 共板`;
    document.getElementById('app').innerHTML = `<header class="topbar"><div class="topbar-left"><a class="brand" ${online ? 'href="/"' : ''}><span class="brand-mark">${icon('board')}</span><span><span class="brand-name">共板</span><span class="brand-sub" style="display:block">THINK TOGETHER</span></span></a><span class="divider"></span><div class="breadcrumb" title="${esc(doc.project.path)}">${icon('folder')}<span>${esc(doc.project.name)}</span>${icon('arrow')}<span>討論紀錄</span></div></div><div class="topbar-right"><span class="save-status"><span class="status-dot ${connected ? '' : 'offline'}"></span>${online ? connected ? 'HTML 已保存 · 即時同步' : '本地連線中斷 · 顯示最後內容' : '獨立 HTML · 離線紀錄'}</span></div></header><main class="page">${online && !connected ? '<div class="connection-banner">重新連線後，白板會自動同步最新內容。</div>' : ''}<section class="hero"><div><div class="eyebrow">DISCUSSION BOARD <span>／</span><span class="badge">${doc.status === 'active' ? '討論進行中' : '已完成討論'}</span></div><div class="hero-title"><h1>${esc(doc.title)}</h1></div><p class="topic">${esc(doc.topic)}</p></div><div class="hero-meta"><div class="stat"><strong>${pages().length}</strong><span>白板</span></div><div class="stat-divider"></div><div class="stat"><strong>${doc.items.length}</strong><span>思考筆記</span></div><div class="stat-divider"></div><div class="stat"><strong>${confirmed().length}</strong><span>已確認</span></div></div></section><nav class="sheet-nav" aria-label="討論白板頁籤"><div class="sheet-tabs">${pages().map((page,index) => `<button class="sheet-tab ${view === 'board' && pageId === page.id ? 'active' : ''}" data-page="${esc(page.id)}" aria-current="${view === 'board' && pageId === page.id ? 'page' : 'false'}"><span class="sheet-number">${String(index + 1).padStart(2,'0')}</span>${esc(page.title)}</button>`).join('')}</div><button class="history-tab ${view === 'history' ? 'active' : ''}" data-view="history">${icon('clock')}討論脈絡<span class="tab-count">${doc.history.length}</span></button></nav>${view === 'history' ? historyView() : boardView()}<footer class="footer"><span class="footer-path" title="${esc(filePath || doc.project.path)}">${filePath ? '紀錄：' + esc(filePath) : '專案：' + esc(doc.project.path)}</span><span>更新於 ${date(doc.updatedAt)} <span>·</span> 第 ${doc.revision} 版 <span>·</span> 共板</span></footer></main>`;
    window.scrollTo(0, scroll);
  }
  async function refresh() {
    try {
      const response = await fetch(`/api/boards/${doc.id}`, { cache: 'no-store' });
      if (!response.ok) { connected = false; render(); return; }
      const result = await response.json();
      connected = true; filePath = result.path;
      if (result.doc.revision >= doc.revision) doc = result.doc;
      render();
    } catch { /* Preserve the last rendered board during temporary disconnects. */ }
  }
  document.addEventListener('click', event => {
    const page = event.target.closest('[data-page]');
    if (page) { pageId = page.dataset.page; view = 'board'; window.scrollTo(0, 0); render(); return; }
    const tab = event.target.closest('[data-view]');
    if (tab) { view = tab.dataset.view; window.scrollTo(0, 0); render(); }
  });
  render();
  if (online) {
    const events = new EventSource('/api/events');
    events.onopen = () => { connected = true; render(); refresh(); };
    events.onerror = () => { connected = false; render(); };
    events.addEventListener('board', event => { if (JSON.parse(event.data).id === doc.id) refresh(); });
    events.addEventListener('unavailable', event => { if (JSON.parse(event.data).id === doc.id) { connected = false; render(); } });
  }
})();
