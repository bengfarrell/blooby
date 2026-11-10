# Blooby

Song documents live under `songs/`. Ableton Live is the source of truth for
sound and playback; the JSON document makes its observed state reviewable in Git.

| File | Purpose |
| --- | --- |
| `songs/<set name>/<set name>.json` | Independent song specification and musical decisions |
| `songs/<set name>/<sha256>.als` | Separate, byte-identical native archive |
| `songs/<set name>/` | Song JSON, archives, and future binary assets |
| `schema/ableton-song.schema.json` | Legacy MCP snapshot schema (Draft 2020-12), retained for input compatibility |
| `schema/ableton-native.schema.json` | Legacy embedded-document schema and shared native state definitions |
| `schema/ableton-song-document.schema.json` | Song specification schema, including explicit capture gaps and decisions |
| `bin/ableton-document.js` | Capture, archive restore, decision recording and MCP rebuild planning |
| `bin/export-mpc.js` | Node.js Standard MIDI export and MPC transfer manifest |

## Node.js utilities

Requires Node.js 20 or newer. Install with `npm ci`; run the tests with `npm test`.
Neither utility connects to MCP, requires Max for Live, starts playback, or
modifies the open Live Set. **Save in Live first**: `.als` input only reflects
what is on disk, not unsaved changes in Live.

### Song specification and separate native archive

```sh
npm run ableton -- capture "/path/to/blooby.als" --out output/song.json
npm run ableton -- restore output/song.json --out output/restored.als
```

For repeatable song-state updates, save the intended set in Live, then run:

```sh
npm run song:refresh -- "/path/to/blooby.als"
# Equivalent direct Node command; no AI or MCP connection required:
node bin/ableton-document.js refresh "/path/to/blooby.als"
```

Refresh creates `songs/blooby/blooby.json` on first use and atomically replaces it on
later runs, after validating the new capture and any existing native document.
Use `--out path/to/native.json` to select another destination. It refuses to
replace an invalid document or the MCP snapshot. Capture and restore retain
their exclusive-output behavior. A failed capture leaves the previous JSON
untouched. Run from the repository root; the default output is relative to the
working directory. Each refresh records a new UTC capture timestamp. The folder
and JSON filename use the `.als` basename without its extension, preserving
case and spaces: `My Song.als` becomes `songs/My Song/My Song.json`.
Renaming a set creates a separate song path; old song folders are not deleted.
The JSON's schema reference is relative to its actual output location.

Capture/refresh write the original `.als` as `<sha256>.als` beside the JSON.
The JSON contains only the archive's filename/checksum, not its bytes. Archives
are immutable: unchanged saved bytes reuse the same file, and previous archives
and other sibling assets are preserved. The archive is written before the JSON
is replaced; an interrupted/failed capture may leave an unreferenced archive,
but does not replace the previous JSON with an incomplete document.
External sample/plugin collection is not implemented. The former
`ableton/` directory and its MCP snapshot have been removed.

`AGENTS.md` and the
[`sync-saved-song` skill](.github/skills/sync-saved-song/SKILL.md) instruct agents
to save and refresh after completed batches of MCP song edits. This is an
agent workflow, not an automatic MCP hook. If no save tool is available, the
agent must ask you to save in Live before capturing. The Node capture step is
already deterministic; it cannot save or observe unsaved changes in Live.

The JSON's `state` is usable without the archive. It describes ordered tracks,
serial device order, parallel rack chains, chain mixers, native manual
parameters, macro values, MIDI notes and clip timing. It is the input for
reconstruction planning and MIDI export, not an opaque backup wrapper.
`source.sha256` identifies the captured source, not a checksum over editable JSON.
Native parameter paths/values still need mappings to MCP names/units or another
DAW's instruments. A parameter named `Volume` does not automatically have the same
units in the saved file, MCP and the GUI.

`coverage.not_captured` explicitly lists missing information. This reader does
**not** yet capture automation, modulation, rack mappings/zones, complete routing,
scene/launch settings, full audio/warp state or opaque plugin state. Consequently
the current JSON alone cannot guarantee an exact sonic rebuild. Manual work can
bridge unsupported MCP operations, but cannot recover information missing from
the specification; that needs additional capture. The separate archive is a
safety copy, not a substitute for completing the specification.

`restore` is deliberately a different operation: it verifies and copies the
separate original archive. It does not interpret JSON as instructions or apply
edits; it rejects musical state that differs from that archive. Open the output
`.als` in Live. Unknown native state is preserved in the archive, not secretly
embedded in the JSON. Legacy embedded documents remain readable/restorable;
refresh migrates them to the new format and a separate archive.

Both JSON file references and the separate archive may include absolute paths.
Review before sharing. Neither embeds external samples, packs or installed
plugins. Use Live's **Collect All and Save** for a portable project, and ensure
required packs/plugins are installed. Other Live versions may require reader updates.

### Musical decisions and guided MCP reconstruction

The `decisions` array records **why**, separately from captured **what**. Record
intent, scope, implementation, rejected alternatives and audition results;
refresh preserves these entries while updating saved musical state. Decisions
can be edited as annotations; do not hand-edit captured state to pretend Live
has changed.

```sh
npm run ableton -- decision songs/blooby/blooby.json \
  --id brass-voices --scope "Retro Brass" \
  --intent "Keep fuzzy sustain and clean brass character on one MIDI track" \
  --implementation "Two synth voices in parallel Instrument Rack chains"

npm run ableton -- rebuild-plan songs/blooby/blooby.json --out output/rebuild-plan.json
```

Rebuild planning reads **only the JSON**, never the archive. It emits ordered
MCP calls for verified native-device names, first-level rack construction,
tempo/signature and Session MIDI, interleaved with explicit manual steps.
Every step depends on the preceding one: an operator/MCP-capable agent must
stop at manual steps rather than run all tool calls out of context. Device
settings require verified parameter mappings; deeper rack editing, track setup,
mixers and Arrangement clips currently have manual instructions pointing to
their exact JSON locations. Unmapped devices are never silently substituted.

**This command generates a plan, not an MCP executor.** It does not rebuild or
modify Live. Execute only in a new, separate set after checking current tool
availability, and verify state and sound before claiming equivalence. Capture
gaps are marked `missing_data`, not misrepresented as completed/manual edits.
Rebuilding the song from this specification remains an acceptance test to
perform; generating a plan does not demonstrate a successful round trip.

### MPC One+ MIDI transfer

```sh
npm run mpc -- "/path/to/blooby.als" --out output/mpc
# The song JSON also works, without its ALS archive:
npm run mpc -- songs/blooby/blooby.json --out output/mpc-from-json
```

Copy the generated directory to an SD card or USB drive. On the MPC, use the
Browser to load the `.mid` files and assign each imported MIDI track to an
MPC program/instrument. `manifest.json` is a human/tool-readable handoff;
the MPC does not load it as a native project. It includes source device names,
MIDI channels, and used pitches to help with instrument and drum-pad assignment.

By default, export includes individual Session clip files under `session/`
and a multitrack `arrangement.mid` when there are Arrangement MIDI clips.
Use `--view session` or `--view arrangement` to select one. Session clips
export one loop-region pass (or the non-looping playback window), not a
recording of indefinitely looping Session playback. Arrangement loops are
expanded across their timeline spans, retaining gaps and empty MIDI tracks.
The source file is never changed; output files/directories must not already
exist. `output/` is ignored by Git.

Files use Standard MIDI format 1 at 960 ticks per quarter note, a constant
master tempo/time signature, and one MIDI channel per exported track
(reported as 1-based in the manifest). Names are reduced to safe ASCII.
Timing and velocities are rounded; note tails at window ends are trimmed
and each file is padded to a whole bar. Notes beginning before the selected
window are not chased. Muted/probability-zero/zero-velocity notes are omitted.
Probability and velocity variation otherwise require `--flatten-expression`,
which includes the notes once at their base velocity and reports the loss.

This first exporter rejects overlapping Arrangement clips, non-zero
Arrangement loop/playback offsets, files with more than 16 MIDI tracks,
unrepresentable MIDI timing/signatures, and excessive loop/event counts.
The MCP snapshot lacks some Arrangement offset fields; zero is assumed and
explicitly warned about. Prefer native `.als` input for saved timing.
No sounds, audio clips, effects, automation, groove, MPE, tempo maps,
per-clip/scene signatures, track mute/solo, or launch/follow actions are
translated. Limitations are printed and included in every manifest.
Check tempo, sequence length, track assignment, and drum note-to-pad mappings
on the hardware. Hardware import is not automated.

Akai's [MPC One FAQ](https://support.akaipro.com/en/support/solutions/articles/69000816149-akai-pro-mpc-one-frequently-asked-questions)
describes USB/SD transfer and MIDI tracks using Drum, Keygroup, or Plugin
programs. Menu behavior can vary with MPC firmware.

## Document conventions

- `schema_version` identifies the document contract, independently of Live's
  version. Start with `0.1.0` and evolve the schema alongside real song work.
- Timing is in **quarter-note beats**, not seconds or bars. Arrangement clip
  positions are absolute; MIDI note times and loop/marker positions are local
  to the clip. Session and Arrangement content are captured independently.
- Mixer and device values retain native saved parameter paths and values,
  not converted dB values or MCP parameter units.
- Track indices use regular tracks `0..N-1`, returns `-1` for A,
  `-2` for B, and master `-1000`. Send index `0` targets return `-1`.
  Scene and Session slot indices are zero-based. Arrangement clip indices belong
  to a separate list. Names and indices are not durable IDs after reordering.
- An empty slot is `{ "index": 1, "has_clip": false }`; an occupied slot has a
  `clip` object. `null` preserves unavailable native IDs where applicable.
- `source.file_name` stores only the set's basename. The original payload still
  lives in a separate archive, which may contain absolute file references.
  `source.archive_file` is a checksum-named sibling, never a machine-specific path.
  Capture timestamps are UTC.
