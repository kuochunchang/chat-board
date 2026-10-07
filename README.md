# 共板 · Chat Board

在本機顯示與 AI 討論時使用的多塊白板。討論、確認與決策都留在 chat session，AI 主動整理 SVG、筆記、共識和決策脈絡；**顯示的內容已經存進 HTML，不需要另做存檔**。

需要 Node.js 22 或以上。無外部依賴，無需安裝套件、帳號或 API key。AI 使用檔案與 CLI 整理白板；這個工具不包含另一個聊天模型。

## 開始使用

```sh
cd /Users/guojun/workspace/chat-board
npm start
```

開啟 <http://127.0.0.1:4317> 閱讀討論白板。網頁只供顯示，頁籤用來切換不同白板；建立、更新與確認都透過 chat session 中的 AI 進行。伺服器只綁定本機 `127.0.0.1`，不提供網頁寫入 API。

在其他專案建立白板：

```sh
node /Users/guojun/workspace/chat-board/bin/board.mjs new \
  --project /absolute/path/to/another-project \
  --title "登入流程設計" \
  --topic "釐清現況，比較方案，確認實作方向"
```

輸出包含 `path`、`id`、`url`、版本與內容數量。HTML 預設放在該專案的 `docs/discussions/`；可使用 `--file docs/discussions/login.html` 指定檔名。既有檔案不會被覆寫。

工具的 `.chat-board/index.json` 只登記白板路徑。討論內容只存在 HTML。即使索引遺失，也可以重新開啟 HTML 恢復使用。

## 與 AI 一起討論

在其他專案的對話開頭，提供這段約定；也可加入該專案的 `AGENTS.md`：

> 請使用 `/Users/guojun/workspace/chat-board` 的共板工具。每次討論建立一份 HTML，或繼續我指定的 HTML。依照討論需要新增多塊白板，例如架構圖、方案比較、筆記與決策。討論有進展時，主動使用 CLI 整理 SVG、筆記、待釐清事項與決策理由；只將我明確確認過的內容標記為已確認。所有討論與操作都留在 chat session，網頁只顯示進展。HTML 存進目前專案的 `docs/discussions/`，提供預覽 URL。
>
> 請先閱讀 `/Users/guojun/workspace/chat-board/docs/writing-standard.md`。依照其中借用 ASD-STE100 的寫作原則整理內容：使用短句，說清楚執行者、條件與動作，保持術語一致；保留原意與不確定性，不把提案寫成已確認決策。

一般工作方式：

1. 讀取被討論專案的相關資料，記下來源檔案與必要版本資訊。
2. 建立白板，或使用 `open --file` 登記現有 HTML。
3. 讀取當前文件，保留白板與項目 ID，以增量操作更新；需要時新增白板，分別放圖與筆記。
4. 有進展就更新；確認過的內容附上明確確認理由。
5. 方案改變時說明原因。修改前的內容與 SVG 會保留在討論脈絡。
6. 使用者在 chat session 說討論結束時，可使用 `finish` 標記；這只是狀態，所有內容早已寫入 HTML。需要繼續時使用 `resume`。

伺服器有開啟時，瀏覽器會自動同步，並保留正在觀看的白板頁籤。若多個 AI 同時更新，舊版本的寫入會被拒絕，請重新讀取並整合。

### 內容寫作規範

本專案採用 [STE 原則的清楚技術寫作準則](docs/writing-standard.md)。AI 整理白板、撰寫文件或提供技術說明時，應遵循這份準則：

- 使用短句，一句說清楚一件事。
- 說明誰在什麼條件下，執行什麼動作。
- 同一個概念使用同一個名稱；必要術語第一次出現時先解釋。
- 簡化文字時，保留條件、例外、限制、來源與原意。
- 分清楚事實、假設、提案、已確認決策和已完成工作。

這是借用 ASD-STE100 原則的專案做法，不是英文標準的合規認證。中文保留中文；英文也不能只因句子簡短就宣稱符合 STE。寫作檢查由 AI／作者執行，不會新增網頁操作、內容資料庫或自動改寫功能。

### 一場討論，多塊白板

每份 HTML 包含 `pages`、`items`、`diagrams` 和 `history`。`pages` 是白板清單，每塊有穩定的 ID、標題和說明；筆記與圖透過 `pageId` 指定放在哪塊白板。預設第一塊的 ID 是 `main`。舊的單塊白板 HTML 仍可讀取。

```sh
node /Users/guojun/workspace/chat-board/bin/board.mjs page \
  --file /path/to/discussion.html --id architecture --title "架構圖"
node /Users/guojun/workspace/chat-board/bin/board.mjs page \
  --file /path/to/discussion.html --id ideas --title "方案與筆記"
```

之後使用 `add --page ideas` 或 `diagram --page architecture` 指定位置。JSON 更新也可使用 `{"op":"page","page":{"id":"ideas","title":"方案與筆記"}}` 建立／重新命名白板，再用 `item.pageId` 或 `diagram.pageId` 放置內容。所有白板完整保存在同一份 HTML，頁籤只改變觀看方式。

討論濃縮時，也要合併重複分頁。在同一份 `update` 中：

1. 選定要保留的分頁，沿用其 ID。
2. 使用 `upsert` 和 `diagram`，把來源分頁的所有筆記與圖改放到保留分頁。保留原項目 ID、內容、來源及確認狀態。
3. 在 `operations` 最後加入空頁移除操作，例如：

```json
{"op":"remove","target":"page","id":"ideas"}
```

更新須包含 `expectedRevision` 和合併的 `reason`。工具只允許移除空頁，且至少保留一頁；舊分頁資料及搬移前的內容會留在歷史中。若操作失敗，整份更新不會寫入。網頁不增加合併或刪除操作。

### 讀取與增加筆記

```sh
node /Users/guojun/workspace/chat-board/bin/board.mjs read --file /path/to/discussion.html
node /Users/guojun/workspace/chat-board/bin/board.mjs add \
  --file /path/to/discussion.html --kind question \
  --id authentication-question --title "是否需要多因素驗證？" \
  --text "先釐清登入流程的需求與限制。" --revision 1
```

類型：`question` 待釐清、`idea` 想法、`note` 筆記、`consensus` 共識、`decision` 決策、`action` 下一步。每個項目有穩定 ID，可以更新同一個項目而不產生重複筆記。

### 一次整理多項進展

準備一份更新 JSON：

```json
{
  "expectedRevision": 2,
  "actor": "ai",
  "summary": "確認方案 B，補上下一步",
  "reason": "使用者明確選擇 B，原因是維護成本較低。",
  "operations": [
    {
      "op": "upsert",
      "item": {
        "id": "login-choice",
        "kind": "decision",
        "title": "採用方案 B",
        "text": "共用現有登入服務，集中維護。",
        "confirmed": true,
        "sources": ["src/auth/login.ts:42"]
      }
    },
    {
      "op": "upsert",
      "item": {
        "id": "next-step",
        "kind": "action",
        "title": "驗證登入流程",
        "text": "確認錯誤處理與重新登入行為。"
      }
    }
  ]
}
```

```sh
node /Users/guojun/workspace/chat-board/bin/board.mjs update \
  --file /path/to/discussion.html --input /path/to/update.json
```

`expectedRevision` 是剛讀取到的版本；版本衝突時不會寫入任何內容。`reason` 是本次更新或決策改變的理由。AI 標記新確認內容時必須提供理由，但實際確認仍依賴對話中的明確同意。

支援操作：`meta` 更新主題／目標；`page` 新增／更新一塊白板；`upsert` 新增／更新筆記；`diagram` 新增／更新 SVG；`remove` 移除白板項目但保留歷史，必須附理由；`checkpoint` 記錄里程碑；`finish` 完成討論；`resume` 繼續討論。

### SVG 圖

```sh
node /Users/guojun/workspace/chat-board/bin/board.mjs diagram \
  --file /path/to/discussion.html --svg /path/to/flow.svg \
  --id architecture --title "登入流程" --caption "現況與修改位置"
```

使用有 `viewBox` 的完整 SVG。基本形狀、文字、箭頭 marker、漸層與群組都可顯示。文字樣式使用 SVG 屬性，例如 `font-size`、`fill`。顯示時會清除腳本、外部資源、HTML 與內嵌 CSS；原始 SVG 仍存入資料和版本歷史。

### 結束與繼續

```sh
node /Users/guojun/workspace/chat-board/bin/board.mjs finish --file /path/to/discussion.html --reason "方向確認，接著進入實作。"
node /Users/guojun/workspace/chat-board/bin/board.mjs resume --file /path/to/discussion.html --reason "加入新的限制條件。"
```

完整用法：`node bin/board.mjs help`。

## HTML 與離線閱讀

AI 使用 CLI 更新時，直接寫回原本的 HTML，採用檔案鎖、版本檢查與原子寫入。瀏覽器呈現的就是那份已寫入的文件；沒有另存、送出或匯出的步驟。

伺服器停止後，直接用瀏覽器打開 HTML，仍可切換白板、閱讀圖、筆記、共識與歷史。HTML 內含樣式、顯示程式和完整資料，不需要網路或其他檔案。可直接複製 HTML 分享或備份。使用 `open --file` 重新登記原檔，就能恢復即時預覽；副本若與原檔有相同 ID，不會同時登記為不同討論。

白板可以引用其他目錄的專案與檔案，但不會自動讀取或修改專案程式碼；由討論中的 AI 根據可讀取的專案內容整理。專案引用只是文字來源，離線閱讀不需要存取原專案。

## GitHub 與跨電腦同步

工具 repo 保存程式、Agent 約定、寫作準則與測試。另可使用一個私人資料 repo 保存完整討論 HTML。HTML 仍是討論紀錄；GitHub 提供版本同步，離線閱讀不需要 GitHub。

### 在另一台電腦取得討論

這個工具 repo 的 `discussion-repo.json` 記錄共用資料 repo 的位置。它只包含遠端網址、分支與相對目錄，不包含憑證或討論內容。第一次執行 `npm start` 時，工具依此設定接收端，並在背景取得討論。已有本機同步設定時，工具沿用原設定。

另一台電腦先登入有私人 repo 存取權的 GitHub 帳號。在工具 repo 目錄執行：

```sh
git pull --ff-only
node bin/sync.mjs setup
node bin/board.mjs list
npm start
```

`setup` 會立即嘗試取得遠端討論。看到 `state: "synced"` 與白板清單後，開啟 <http://127.0.0.1:4317>。如果輸出為 `pending`，先依錯誤訊息檢查 Git 登入、repo 權限或網路。只下載工具 repo 不會包含討論 HTML；這一步會取得獨立資料 repo 的內容。

已用 Git 下載資料 repo 時，指定該目錄：

```sh
node bin/sync.mjs setup --repo /path/to/chat-board-discussions
```

工具會檢查 repo 根目錄、origin、分支與 HTML，再建立本機索引。已下載的 HTML 不需要網路就能登記與閱讀。原始專案路徑保留在討論內容中；本機索引指向這台電腦的 HTML 位置。

### 設定其他資料 repo

先在 GitHub 建立資料 repo，再指定空目錄或已下載的資料 repo：

```sh
node bin/sync.mjs init \
  --repo "$PWD/../chat-board-discussions" \
  --remote https://github.com/OWNER/chat-board-discussions.git \
  --storage repo
node bin/sync.mjs once
npm start
```

每台電腦需要 Git、資料 repo 的存取權，以及可用的 Git 登入。設定只存在本機 `.chat-board/sync.json`，不包含憑證。資料 repo 只保存 `boards/<討論 ID>.html` 與 Git 歷史；不推送本機索引、同步設定或絕對路徑綁定表。HTML 原有的專案路徑與來源文字會保留。

`--storage repo` 讓新討論直接存入資料 repo 的 `boards`。工具與資料 repo 可放在同一個父目錄。預設的 `--storage project` 仍把新討論存入被討論專案的 `docs/discussions`，再同步副本。明確指定 `new --file` 時，工具使用指定位置。設定儲存方式不會自行搬移既有討論。

預設同步所有已登記白板。只要同步特定專案，就在 `init` 加上 `--projects /absolute/project/path`。多個專案路徑以逗號分隔。此篩選控制本機上傳來源；有資料 repo 存取權的人仍能讀取 repo 內所有討論。需要不同存取權時，使用不同資料 repo。

啟用設定後，CLI 每次建立或更新討論，都先寫入 HTML，再立即嘗試同步。輸出中的 `sync.state` 表示結果：

| 狀態 | 意思與後續動作 |
| --- | --- |
| `synced` | 本次討論版本已與遠端同步。 |
| `pending` | 本機 HTML 已保存，但網路、登入或推送失敗。恢復連線後重試。 |
| `busy` | 另一個更新正在寫入，或遠端在同步期間新增版本。稍後重試。 |
| `conflict` | 雙方修改了相同項目，或無法安全整合。回到 chat 釐清。 |

日常使用只需執行 `npm start`。同一個長駐白板服務提供網頁與背景同步，不需另外啟動 `sync watch`。同步時，服務會啟動短暫的工作程序與 Git 程序；這些程序由服務管理。

`npm start` 運行時，背景工作預設每 5 秒同步一次。它取得遠端更新，也重試本機未上傳的內容。遠端白板會自動登記到本機；已登記的原始 HTML 會收到新版本。另一台電腦也執行上述設定與 `npm start`，就能持續看到新版本。這是依網路速度與輪詢間隔更新的版本同步。

伺服器停止時，CLI 落檔仍會嘗試同步，但沒有背景重試或定期取得更新。可隨時執行：

```sh
node bin/sync.mjs status
node bin/sync.mjs once
```

若已有另一個 session 正在使用沒有整合同步的舊版伺服器，可暫時執行 `node bin/sync.mjs watch`。此指令啟動定期同步，不需中斷既有白板服務。切換到目前版本的 `npm start` 後，停止獨立的 `watch`。停止此指令不會刪除討論 HTML。

不同項目的修改會整合，並保留雙方歷史、來源與確認理由。相同項目的修改不會自行選擇一方。遇到衝突時，本機 HTML 保持原樣；工具另外嘗試推送 `conflicts/<電腦 ID>/<識別碼>` 分支。輸出的 `backupBranch` 表示遠端備份成功；若為 `null`，本機 HTML 與 `localCommit` 指向的 Git 紀錄仍保留。反覆同步同一衝突不會重複建立備份分支。工具不使用強制推送，也不因遠端刪除而移除本機討論。

Git 下載時，工具會更新本機的 `origin/main` 遠端追蹤參照。這個參照表示最近取得的 GitHub 分支位置；更新它不會直接覆寫討論 HTML。如果 Git 分支有分歧，工具先檢查 HTML 的完整歷史是否連續。雙方各自修改時，工具從共同版本整合。整合成功後，合併 commit 保留雙方 Git 歷史，並使用一般推送。相同項目的衝突仍需在 chat 處理。

多人透過各自的 chat 與 CLI 操作。白板網頁仍只供顯示。資料 repo 的同步不會自動同步工具程式；工具更新使用一般 Git 流程。

遇到衝突時，AI 先讀取本機 HTML 與遠端版本，在 chat 說明差異。使用者明確決定整合內容後，AI 用白板 CLI 更新本機圖文，再執行：

```sh
node bin/sync.mjs resolve --file /path/to/reviewed.html \
  --revision N --remote-commit SHA \
  --reason "使用者在 chat 明確採用的整合內容與理由"
```

`N` 是剛讀取的本機版本；`SHA` 是衝突輸出的 `remoteCommit`。指令會檢查兩者仍未改變，保留雙方歷史，並以目前本機圖文重新同步。若有另一個 session 更新，版本檢查會拒絕舊的整合請求。未獲使用者明確決定前，AI 不得用此指令自行選擇一方。

## 開發與驗證

```sh
npm test
CHAT_BOARD_PORT=4318 npm start
```

唯讀 API：`GET /api/boards`、`GET /api/boards/:id`、`GET /api/events`。POST、PATCH 等寫入請求會被拒絕。CLI 直接更新 HTML，不依賴伺服器運作。

這是 chat session 的顯示白板，不包含聊天輸入、人工編輯、手寫畫筆、拖拉或存檔操作。

回覆待確認事項時，按你選的那個選項旁的「複製」，會複製事項 ID、問題和這個選項，貼到 chat session 即可。選項是以 `A.`、`B.`（或 `1.`、`2.`）開頭的行。沒有選項的事項提供「複製題目」；標題列的「全部複製」會複製這塊白板所有事項的問題和選項。每塊白板只列出自己的待確認事項；其他白板的待確認數顯示在頁籤上。複製不會改變白板內容。

首頁依最後更新時間列出討論，新的在前面；每份討論顯示更新時間與待確認數。白板頁籤會換行顯示，頁籤上標出該白板的待確認數。上次開啟這份討論之後新增或更新的項目與圖，會標上「新」，有新內容的頁籤會出現圓點。上次開啟的時間只存在這個瀏覽器的 localStorage，不寫進 HTML；第一次開啟或瀏覽器不允許儲存時，不標示「新」。細節卡片顯示建立時間，修改過的卡片另外顯示更新時間；各組依建立時間由新到舊排列。未完成的下一步列在待確認事項下方的「待進行」區塊，新的在前面；已完成的下一步留在細節。

項目可用 `links` 記下相關項目的 ID（`add --links id-1,id-2`），記在任一邊都可以。想法、筆記或問題的卡片依相關項目的實際狀態標示「已實作」「已確認為共識／決策」「待確認」或「待實作」，並在卡片下方列出相關項目；相關項目在其他白板時，可點擊切換。
