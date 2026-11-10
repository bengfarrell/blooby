# Song editing

Ableton Live is the source of truth. When using MCP to change song state,
load and follow `.github/skills/sync-saved-song/SKILL.md` before editing.
After each completed batch of edits (including kept experiments or undo/redo),
save the intended Live Set and refresh `songs/<set name>/<set name>.json` with
the Node CLI. Use the `.als` basename without its extension, preserving case
and spaces. The song directory also holds future binary assets; preserve them
when refreshing the JSON.
Do not finish a song-editing task without refreshing it or explicitly reporting
why saving/capture is blocked. Read-only MCP calls do not require a refresh.

The old MCP snapshot has been removed. Never manually edit captured state
to represent song changes. Record explicit musical intent in the JSON's
`decisions` annotations; refresh preserves them. Native ALS bytes belong in a
separate archive, never embedded in the JSON. Reconstruction plans must report
manual work and missing capture data explicitly, not claim exact recreation.
Do not commit or stage changes unless requested.
