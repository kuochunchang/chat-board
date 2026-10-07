# Chat Board working agreement

This project is a local discussion-whiteboard tool. The self-contained HTML is the record; do not move discussion content into a separate database or require cloud services.

All discussion, clarification, confirmation, and instructions stay in the chat session. The web page is display-only. Do not add editing, drawing, confirmation, creation, or save controls to it. Content is already persisted when it appears; no explicit save step is needed.

## Discussing this project

- When the discussion makes progress, proactively update its HTML whiteboard through `node bin/board.mjs`.
- Reuse the current discussion record rather than creating a new board for every turn. Find it with `node bin/board.mjs list` and read it before updating. `read` omits history by default and reports the omitted count in `omitted`; add `--history` only when you need previous content, and `--no-svg` when you do not need diagram source.
- A discussion can use multiple whiteboards inside one HTML. Add or rename them with the `page` operation, and assign notes and diagrams with `pageId`. Keep IDs stable; use tabs only to change the viewing page.
- Keep proposals, open questions, notes, explicit consensus, decisions, and actions distinct.
- Do not treat silence, a new topic, or a suggestion as approval. Mark an item confirmed only when the user explicitly confirms it. Record the evidence in `reason`.
- When you wait in chat for the user's decision or answer, also add an open `question` item, so it appears in 待確認事項 at the top of the whiteboard. Set its `pageId` to the whiteboard that the question concerns: each whiteboard lists only its own pending items, and the tabs show the pending count of each whiteboard. After the user answers, record the answer in the related item, then remove the question.
- Write each pending `question` (and each unconfirmed decision proposal) so the user can decide from it alone:
  - `title`: one question that names the decision, for example 「第 2 階段實機驗收何時進行？」. Do not prefix it with 待確認 or 待釐清; the page already shows that status.
  - `text`: first, one or two sentences of context that the decision depends on. Then one line per option, starting with `A.`, `B.`, `C.` (or `1.`, `2.` for ordered steps). Each option line states the choice and its result or cost. Mark the AI recommendation in its line, for example 「（AI 建議）」. Keep the reasons for an option on its own line.
  - Put long background, evidence and source details in a related note, not in the question.
  - The page shows a copy button beside each option line. It copies the item ID, the title and that one option. Lines that do not start with an option label are not copied. If a question is open-ended and has no options, say so in the title.
- When an idea, note or question leads to a consensus, decision or action, record the relation in `links` (an array of item IDs; `add --links id-1,id-2`). Record it on either item, in the same update that creates the result. The page derives each card's state from the linked items: 已實作 (a done action), 已確認為共識／決策 (a confirmed item), 待確認 (an unconfirmed consensus or decision) or 待實作 (an open action). Do not use links to claim a state; confirmation and completion still follow the rules above.
- Archive a discussion with `archive` to hide it from `list` and the library grid; `list --all` shows archived discussions. Delete only when the user explicitly asks. `delete` accepts only archived discussions and requires `--reason`; with sync configured, the deletion is committed to the data repo and the content stays in Git history.
- Preserve item IDs. Supply the revision you just read and use incremental operations. On a conflict, read the current document and reconcile; never force an old revision over new content.
- Preserve decision reasons and previous content in history. Include source paths when discussing another project's files.
- Discussion HTML belongs in the discussed project's `docs/discussions/` by default. The tool can operate across directories using `--project` and `--file`.
- When the user selects centralized data storage (`sync init --storage repo`), new discussion HTML belongs in the configured data repo's `boards/`. Preserve the discussed project's metadata and source paths. An explicit `--file` takes precedence.
- Updating a discussion record does not authorize changing the discussed project's source code.
- Prefer illustrated explanations: use a diagram to show the outline and overall structure, then place detailed text below it. Keep diagram labels and text consistent. Maintain proportional typography in SVGs (titles 16-18px, node headers 14-15px, body text 12-13px on an 800-1000 wide viewBox); avoid oversized headings (>20px) inside SVGs to keep visual balance with whiteboard notes.
- When GitHub sync is configured, inspect `sync.state` after a CLI write. A saved HTML does not imply a successful push. Report pending uploads or conflicts in chat; preserve both versions and confirmation reasons.

## Consolidating a discussion

Long discussions accumulate duplicate, superseded and answered items. Consolidation keeps the current state easy to read. It changes the presentation only; it does not change what was decided.

- Consolidate only when the user asks or agrees. You may propose consolidation in chat when a whiteboard has more than about 20 items, or when a new decision supersedes earlier proposals.
- Read the record with the default `read`. Add `--history` only when you need removed content.
- Merge duplicate or overlapping items into one item, and keep the representative item's ID.
- Remove proposals that a confirmed decision superseded.
- Record the answer to a question in the related consensus, decision or note, then remove the question.
- Merge completed actions on the same topic into one completed action.
- Do not withdraw confirmed content or change its meaning. Do not merge unconfirmed content into a confirmed item.
- Do not add new conclusions.
- Remove duplicate or outdated diagrams. Retained diagrams must not refer to removed content.
- Consolidate the items of one whiteboard per update, so the user can review each change. In `reason`, record the merge map (`representative-id ← merged-id, …`) and why each item was removed. Finish with a `checkpoint`.
- Consolidate pages in a separate update. Move notes and diagrams to retained page IDs, then remove empty pages with `{"op":"remove","target":"page","id":"source-page"}` in the same update. Provide a reason; keep at least one page. Previous content and page metadata remain in history.
- In chat, report the item and whiteboard counts before and after, and the sync state.

## Clear technical writing

- Read `docs/writing-standard.md` before creating or revising technical explanations, project documentation, whiteboard notes, SVG labels or captions, and user-facing instructions.
- Use the project's ASD-STE100-inspired writing principles: short, direct sentences; one main point per sentence; explicit actors and actions; necessary conditions before actions; consistent terminology.
- Keep the discussion's language. Chinese content borrows these principles; it is not ASD-STE100-compliant English. Do not claim verified STE compliance for English content without checking the applicable writing rules, dictionary and technical terminology.
- Preserve technical meaning, conditions, negation, exceptions, sequence, numerical limits, units and authority boundaries. Do not invent missing requirements to make a sentence more specific. Mark unknowns or ask in chat.
- Keep facts, hypotheses, proposals, confirmed decisions and completed work distinct. Clearer wording does not make a proposal approved or a claim verified.
- Explain necessary technical terms on first use. Do not rename code identifiers, CLI options, schema values, stable board IDs or quoted source text merely to simplify wording.
- Before updating the whiteboard, use the writing checklist in `docs/writing-standard.md`. Preserve confirmation evidence, sources and history as required above.

## Implementation

- Use Node.js built-ins; no dependency installation is needed.
- `npm start` serves the library and live boards at `http://127.0.0.1:4317`.
- `npm test` verifies document persistence, escaping, approval reasons, history, conflicts, cross-project storage and live file updates.
- Generated HTML contains inline CSS, JavaScript, SVG data, and all discussion data. Preserve offline reading and switching between all its whiteboards.
- Keep the registry limited to references, not discussion content. Never overwrite an existing HTML record during creation.
- The HTTP server is read-only; update files through CLI operations. For UI changes, inspect the actual page and test page switching, live updates and standalone HTML reading.
- GitHub synchronization is optional. Run `node bin/sync.mjs help` for setup. The server polls for remote discussion versions; CLI saves attempt an immediate push. Do not force-push discussion history or automatically choose a winner for conflicting edits.
- On another computer, use `node bin/sync.mjs setup` to obtain the data repo from `discussion-repo.json` and build local references. `npm start` also initializes this connection when no local sync configuration exists. Keep local absolute paths and credentials out of the shared reference file.
