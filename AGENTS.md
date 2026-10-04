# Chat Board working agreement

This project is a local discussion-whiteboard tool. The self-contained HTML is the record; do not move discussion content into a separate database or require cloud services.

All discussion, clarification, confirmation, and instructions stay in the chat session. The web page is display-only. Do not add editing, drawing, confirmation, creation, or save controls to it. Content is already persisted when it appears; no explicit save step is needed.

## Discussing this project

- When the discussion makes progress, proactively update its HTML whiteboard through `node bin/board.mjs`.
- Reuse the current discussion record rather than creating a new board for every turn. Find it with `node bin/board.mjs list` and read it before updating.
- A discussion can use multiple whiteboards inside one HTML. Add or rename them with the `page` operation, and assign notes and diagrams with `pageId`. Keep IDs stable; use tabs only to change the viewing page.
- When consolidating a discussion, consolidate its pages too. Move notes and diagrams to retained page IDs, then remove empty pages with `{"op":"remove","target":"page","id":"source-page"}` in the same update. Provide a reason; keep at least one page. Previous content and page metadata remain in history.
- Keep proposals, open questions, notes, explicit consensus, decisions, and actions distinct.
- Do not treat silence, a new topic, or a suggestion as approval. Mark an item confirmed only when the user explicitly confirms it. Record the evidence in `reason`.
- Preserve item IDs. Supply the revision you just read and use incremental operations. On a conflict, read the current document and reconcile; never force an old revision over new content.
- Preserve decision reasons and previous content in history. Include source paths when discussing another project's files.
- Discussion HTML belongs in the discussed project's `docs/discussions/` by default. The tool can operate across directories using `--project` and `--file`.
- Updating a discussion record does not authorize changing the discussed project's source code.
- Prefer illustrated explanations: use a diagram to show the outline and overall structure, then place detailed text below it. Keep diagram labels and text consistent.
- When GitHub sync is configured, inspect `sync.state` after a CLI write. A saved HTML does not imply a successful push. Report pending uploads or conflicts in chat; preserve both versions and confirmation reasons.

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
