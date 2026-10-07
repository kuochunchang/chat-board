import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Store, readBoard } from '../lib/storage.mjs';
import { BoardError, KINDS } from '../lib/document.mjs';

const help = `共板：HTML 就是討論紀錄。所有指令輸出 JSON，供 AI 與人共同使用。

node bin/board.mjs new --project /path/to/project --title "討論主題" [--topic "目標"] [--file docs/discussions/name.html]
node bin/board.mjs list [--all]
node bin/board.mjs read --file /path/to/record.html [--history] [--no-svg]
node bin/board.mjs open --file /path/to/record.html
node bin/board.mjs update --file /path/to/record.html --input /path/to/update.json
node bin/board.mjs update --file /path/to/record.html --input - < update.json
node bin/board.mjs page --file /path/to/record.html --id architecture --title "架構圖" [--description "說明"]
node bin/board.mjs add --file /path/to/record.html --kind note --title "標題" --text "內容" [--page architecture] [--id stable-id] [--links id-1,id-2] [--confirmed --reason "使用者明確確認了什麼"]
node bin/board.mjs diagram --file /path/to/record.html --svg /path/to/diagram.svg --title "流程" [--page architecture] [--id stable-id] [--caption "圖說"]
node bin/board.mjs confirm --file /path/to/record.html --id item-id --reason "使用者明確確認了什麼"
node bin/board.mjs checkpoint --file /path/to/record.html --label "轉折" [--reason "原因"]
node bin/board.mjs finish --file /path/to/record.html [--reason "結論"]
node bin/board.mjs resume --file /path/to/record.html [--reason "原因"]
node bin/board.mjs archive --file /path/to/record.html [--reason "原因"]
node bin/board.mjs unarchive --file /path/to/record.html [--reason "原因"]
node bin/board.mjs delete --file /path/to/record.html --reason "使用者明確要求刪除的原因" [--revision N]

可用 kind：${KINDS.join(', ')}
在 chat 等使用者決定或回答時，同時新增 kind 為 question 的項目，讓它出現在白板最上方的「待確認事項」。用 --page 指定問題所屬的白板：每塊白板只列出自己的待確認事項，頁籤顯示各白板的待確認數。使用者回覆後，把答案記入相關項目，再移除這個問題。
想法或筆記後來成為共識、決策或下一步時，用 links（或 add --links）記下相關項目的 ID，可以記在任一邊。白板依相關項目的實際狀態，在卡片標示「已實作」「已確認」或「待確認」。
read 預設不輸出討論脈絡（history），並在 omitted 標示省略的筆數；需要時加 --history。--no-svg 省略圖的 SVG 原始碼；只改圖的標題或圖說時，update 沿用原本的 SVG。
可加 --revision N 避免覆蓋別人的新更新；update 的 JSON 必須包含 expectedRevision。
合併分頁：先在同一份 update 搬移筆記與圖，再以 {"op":"remove","target":"page","id":"來源頁 ID"} 移除空頁，並提供 reason。至少保留一頁。
濃縮整理（完整規則見本工具 AGENTS.md 的 Consolidating a discussion）：
- 只在使用者要求或同意時整理。某塊白板超過約 20 個項目，或新的決策取代既有提案時，可以在 chat 提議。
- 合併重複的項目，沿用代表項目的 ID。移除被已確認決策取代的提案。問題的答案併入相關項目後，移除問題。同一主題已完成的下一步合併為一項。
- 不撤回或改變已確認的內容，不新增結論。
- 一次 update 只整理一塊白板。在 reason 記下合併對照與移除原因，最後加 checkpoint。
封存：list 預設不列出已封存的討論，加 --all 才列出。已封存的討論要先 unarchive 才能更新。
刪除：只能刪除已封存的討論，並需要 --reason。有設定同步時，刪除會提交到資料 repo，內容保留在 Git 歷史。
伺服器：npm start（預設 http://127.0.0.1:4317）
跨專案使用時，將指令裡 bin/board.mjs 換成這個工具的絕對路徑。
`;

function argumentsOf(args) {
  const options = {};
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (!arg.startsWith('--')) throw new BoardError(`未知的參數：${arg}`);
    const name = arg.slice(2);
    if (['confirmed','help','all','history','no-svg'].includes(name)) { options[name] = true; continue; }
    if (args[index + 1] === undefined || args[index + 1].startsWith('--')) throw new BoardError(`--${name} 需要值。`);
    options[name] = args[++index];
  }
  return options;
}

try {
  const [command = 'help', ...args] = process.argv.slice(2);
  const options = argumentsOf(args);
  if (command === 'help' || options.help) { console.log(help); }
  else {
    const store = new Store(options.registry);
    let result;
    if (command === 'list') result = { boards: store.list().filter(board => options.all || !board.archived) };
    else if (command === 'new') result = store.create(options);
    else {
      if (!options.file) throw new BoardError('需要 --file 指定 HTML 紀錄。');
      const file = resolve(options.file);
      const doc = readBoard(file);
      if (command === 'read') {
        const view = { ...doc };
        const omitted = {};
        if (!options.history) { delete view.history; omitted.history = doc.history.length; }
        if (options['no-svg']) { view.diagrams = doc.diagrams.map(({ svg, ...diagram }) => diagram); omitted.svg = doc.diagrams.length; }
        result = { path: file, doc: view, ...(Object.keys(omitted).length ? { omitted } : {}) };
      }
      else if (command === 'delete') result = store.delete(file, { reason: options.reason, revision: options.revision });
      else if (command === 'open') result = store.register(file);
      else {
        let update;
        if (command === 'update') {
          if (!options.input) throw new BoardError('需要 --input 指定更新 JSON 檔案，或 - 讀取標準輸入。');
          update = JSON.parse(readFileSync(options.input === '-' ? 0 : resolve(options.input), 'utf8'));
        } else {
          const operation = { op: command };
          if (command === 'add') {
            operation.op = 'upsert';
            operation.item = { id: options.id, pageId: options.page, kind: options.kind || 'note', title: options.title || '', text: options.text || '', ...(options.links ? { links: options.links.split(',').map(link => link.trim()).filter(Boolean) } : {}), ...(options.confirmed ? { confirmed: true } : {}) };
          } else if (command === 'page') {
            operation.page = { id: options.id, title: options.title || '討論白板', description: options.description || '' };
          } else if (command === 'diagram') {
            if (!options.svg) throw new BoardError('需要 --svg 指定 SVG 檔案。');
            operation.diagram = { id: options.id, pageId: options.page, title: options.title || '關係圖', svg: readFileSync(resolve(options.svg), 'utf8'), caption: options.caption || '' };
          } else if (command === 'confirm') {
            const item = doc.items.find(item => item.id === options.id);
            if (!item) throw new BoardError('找不到要確認的筆記。');
            operation.op = 'upsert'; operation.item = { ...item, confirmed: true };
          } else if (command === 'checkpoint') operation.label = options.label || '討論里程碑';
          else if (!['finish','resume','archive','unarchive'].includes(command)) throw new BoardError(`未知的指令：${command}`);
          update = { expectedRevision: options.revision ? Number(options.revision) : doc.revision, actor: 'ai', summary: options.summary || (command === 'add' ? `整理筆記：${options.title || ''}` : command === 'page' ? `整理白板：${options.title || ''}` : command === 'diagram' ? `更新關係圖：${options.title || ''}` : command === 'confirm' ? '記錄使用者確認' : command === 'checkpoint' ? options.label || '討論里程碑' : command === 'finish' ? '完成討論' : command === 'archive' ? '封存討論' : command === 'unarchive' ? '取消封存' : '重新開啟討論'), reason: options.reason || '', operations: [operation] };
        }
        result = store.updateFile(file, update);
      }
    }
    if (result.id && !result.deleted) result.url = `http://127.0.0.1:${process.env.CHAT_BOARD_PORT || 4317}/boards/${result.id}`;
    if (result.doc && command !== 'read') {
      const { id, path, url, doc, sync } = result;
      result = { id, path, url, title: doc.title, revision: doc.revision, pages: doc.pages?.length || 1, items: doc.items.length, diagrams: doc.diagrams.length, ...(sync ? { sync } : {}) };
    }
    console.log(JSON.stringify(result, null, 2));
  }
} catch (error) {
  console.error(JSON.stringify({ error: error.message, status: error.status || 400 })); process.exitCode = 1;
}
