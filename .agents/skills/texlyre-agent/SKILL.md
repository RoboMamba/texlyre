---
name: texlyre-agent
description: Use when working with a connected TeXlyre project through the texlyre_* MCP tools, especially when proposing LaTeX, Typst, Markdown, or BibTeX edits that must appear as TeXlyre native tracked changes for human review. Do not use this workflow for direct filesystem edits to the connected TeXlyre document.
---

# TeXlyre Agent Review Workflow

Use the TeXlyre MCP server as the document boundary.

## Required workflow

1. Call `texlyre_get_project_context` and verify that the project reports
   `reviewSupport: native-tracked-changes`.
2. Call `texlyre_list_files` and identify the smallest set of target files.
3. Call `texlyre_read_file` for every target file immediately before proposing
   edits. Keep the returned `hash` as that file's `baseHash`.
4. Build exact, localized changes using unique `oldText` values. Prefer one
   hunk per coherent change and include context when the target may repeat.
5. Call `texlyre_propose_changes` with an agent actor:

   ```json
   {
     "kind": "agent",
     "provider": "codex",
     "displayName": "Codex",
     "sessionId": "<current-session>"
   }
   ```

   Use `provider: "dsh"` when running from DSH.
6. Report the returned ChangeSet id and wait for the human to inspect the
   native TeXlyre ReviewPanel.
7. If the human requests changes, call `texlyre_get_review_feedback` and read
   the current ChangeSet before proposing a revision.

## Safety boundary

- Never call shell tools, filesystem APIs, or editor APIs to directly rewrite a
  connected `.tex`, `.typ`, `.md`, or `.bib` file as a substitute for a
  ChangeSet.
- Never claim that a proposal was applied. The MCP surface intentionally does
  not expose accept, reject, or apply operations.
- Treat `BASE_HASH_MISMATCH`, `EDIT_TARGET_AMBIGUOUS`, `EDIT_TARGET_OVERLAP`,
  and `CHANGESET_STALE` as a reason to reread the live file and create a new
  proposal.
- A file listed by `texlyre_list_files` may not currently have a live editor.
  If `texlyre_read_file` reports that the file is not open, ask for it to be
  opened in TeXlyre rather than reading a stale disk copy.
- Keep the agent proposal separate from human review. A proposal creates native
  review tags; it does not change clean document content until a human accepts
  or rejects it in TeXlyre.

## Response style

Summarize:

- target files and intent;
- ChangeSet id;
- number of files and hunks;
- any base-hash or stale conflict;
- the next human review action.
