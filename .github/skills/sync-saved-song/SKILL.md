---
name: sync-saved-song
description: Save the intended Ableton Live Set and refresh its tracked native song JSON after MCP song edits, kept experiments, or undo/redo. Also use when asked to capture or refresh saved song state.
---

# Sync saved song

The Node CLI does all parsing, schema validation, checksum generation, and
JSON writing. Use it rather than reconstructing state with AI or MCP queries.
`songs/<set name>/<set name>.json` is the song specification, using the
saved `.als` basename without its extension, preserving case and spaces.
The old MCP snapshot has been removed. Each song directory also holds future
binary assets (audio blobs and other required files); preserve sibling files.

1. Identify the intended open set and its actual `.als` path. Use MCP session
   information or tool discovery if available. Do not guess from the song name,
   choose an arbitrary recent file, or persist a machine-specific path in
   repository configuration. If the path cannot be determined, ask the user.
2. Complete the requested MCP edits and wait for pending operations to finish.
   Capture once per completed batch, not after each parameter change. For
   experiments, capture the final kept state, not temporary branches.
3. Save that set in Live. Discover a save tool and use it only if it exists and
   confirms success. If MCP cannot save, ask the user to save in Live and confirm
   completion. An unsaved/untitled set needs a user-chosen save location.
   Do not use restore, open a different set, or infer that capture saves Live.
4. From the repository root, run:

   ```sh
   npm run song:refresh -- "/actual/path/to/blooby.als"
   ```

   This creates or atomically refreshes `songs/blooby/blooby.json`, preserves its
   musical `decisions`, and writes the native archive as a separate
   `<sha256>.als` sibling. A deliberate
   alternate native document can be selected with `--out path/to/native.json`.
   The equivalent AI-free command is:

   ```sh
   node bin/ableton-document.js refresh "/actual/path/to/blooby.als"
   ```

   Requires Node.js 20+. If dependencies are missing, use `npm ci` and retry.
5. Check the exit status and inspect the JSON diff, including the source basename
   and readable state relevant to the edits. On first capture, inspect the new
   document directly; untracked files do not appear in a normal Git diff.
   A timestamp change alone does not verify the intended edits were saved.
   Avoid concurrent edits/saves during capture; save and recapture if necessary.

Record musical intent, implementation and audition results in `decisions` using
`npm run ableton -- decision <song.json> --id <id> --scope <scope> --intent <why>
--implementation <how>`. Do not infer intent from saved settings. Refresh
preserves these annotations. `rebuild-plan` uses JSON alone and reports manual
steps and missing capture data; generating it is not proof of a successful rebuild.

If saving, reading, parsing, validation, or replacement fails, report the
specific failure and that the song JSON is not synchronized. Do not delete an
existing document to bypass validation, substitute an MCP snapshot, hand-edit
the payload/summary, or claim an old saved file reflects unsaved changes.

Song JSON contains captured state, decisions and explicit capture gaps, never
the original `.als` bytes. Those live in the separate archive. Neither file
embeds external samples/plugins. Review file references before sharing. Do not stage or commit unless
asked. Capture/refresh never changes the open set or starts playback.
