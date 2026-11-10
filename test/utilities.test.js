import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync, gunzipSync } from 'node:zlib';
import { mkdtemp, readFile, readdir, rm, writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { parseMidi } from 'midi-file';
import { captureAls, restoreBytes, readInput, writeNewFile, songDocumentPath, recordDecision } from '../src/documents.js';
import { inspectAls } from '../src/als.js';
import { buildMpcExport, PPQ } from '../src/mpc.js';
import { buildRebuildPlan } from '../src/rebuild.js';

const note = (start, duration = 0.5, pitch = 60) => ({
  note_id: Math.round(start * 10), pitch, start_time: start, duration, velocity: 100,
  release_velocity: 64, mute: false, probability: 1, velocity_deviation: 0,
});
const clip = (extra = {}) => ({
  index: 0, name: 'Test Clip', is_audio_clip: false, length: 4, looping: true,
  loop_start: 0, loop_end: 4, start_relative: 0, out_marker: 4,
  notes: [note(0), note(3.75)], ...extra,
});
const state = (clips = [clip()], arrangement = []) => ({
  session: { tempo: 115, signature_numerator: 4, signature_denominator: 4 },
  tracks: [{
    index: 0, name: 'Test Track',
    clip_slots: clips.map((c, index) => ({ index, has_clip: true, clip: c })),
    arrangement_clips: arrangement,
  }],
});
const nativeFixture = () => gzipSync(Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<Ableton Creator="Ableton Live Test"><LiveSet><Tracks>
<MidiTrack Id="1"><Name><EffectiveName Value="Test &amp; Track"/></Name><DeviceChain>
<Mixer><Volume><Manual Value="0.75"/></Volume></Mixer>
<MainSequencer><ClipSlotList><ClipSlot Id="0"><ClipSlot><Value>
<MidiClip Id="0" Time="0"><Name Value="Test Clip"/><CurrentStart Value="0"/><CurrentEnd Value="4"/>
<Loop><LoopStart Value="0"/><LoopEnd Value="4"/><StartRelative Value="0"/><LoopOn Value="true"/><OutMarker Value="4"/></Loop>
<Notes><KeyTracks><KeyTrack Id="0"><MidiKey Value="60"/><Notes>
<MidiNoteEvent Time="0.25" Duration="0.5" Velocity="100" OffVelocity="32" NoteId="1"/>
</Notes></KeyTrack></KeyTracks></Notes></MidiClip>
</Value></ClipSlot></ClipSlot></ClipSlotList><ClipTimeable><ArrangerAutomation><Events/></ArrangerAutomation></ClipTimeable></MainSequencer>
<DeviceChain><Devices><InstrumentGroupDevice Id="2"><UserName Value="Outer Rack"/>
<MacroControls.0><Manual Value="42"/></MacroControls.0><MacroDisplayNames.0 Value="Cutoff"/>
<Branches><InstrumentBranch Id="0"><Name><EffectiveName Value="Inner Chain"/></Name>
<MixerDevice><Volume><Manual Value="0.8"/></Volume></MixerDevice>
<DeviceChain><MidiToAudioDeviceChain><Devices><Drift Id="3"><UserName Value="Bass"/>
<Frequency><Manual Value="1234"/></Frequency></Drift></Devices></MidiToAudioDeviceChain></DeviceChain>
</InstrumentBranch></Branches></InstrumentGroupDevice></Devices></DeviceChain>
</DeviceChain></MidiTrack></Tracks>
<MainTrack><Name><EffectiveName Value="Main"/></Name><DeviceChain><Mixer>
<Tempo><Manual Value="115"/></Tempo><TimeSignature><Manual Value="201"/></TimeSignature>
</Mixer><DeviceChain><Devices/></DeviceChain></DeviceChain></MainTrack>
</LiveSet></Ableton>`));

const snapshotFixture = () => ({
  $schema: '../schema/ableton-song.schema.json', schema_version: '0.1.0',
  song: { slug: 'test', title: 'Test' },
  capture: {
    started_at: '2026-11-07T00:00:00.000Z', finished_at: '2026-11-07T00:00:00.000Z',
    source: 'LivePilot MCP', read_only: true, consistency: 'session-summary-unchanged',
    tools: [], included: [], excluded: [],
  },
  session: {
    ...state().session, file_name: 'test.als', live_version: 'Test',
    track_count: 0, return_track_count: 0, scene_count: 0, is_playing: false,
    song_length: 0, current_song_time: 0, loop: false, loop_start: 0, loop_length: 4,
    metronome: false, record_mode: false, session_record: false, api_features: {},
  },
  scenes: [], tracks: [], return_tracks: [],
  master_track: { index: -1000, name: 'Main', volume: 0.75, panning: 0, devices: [] },
});

function absoluteEvents(track) {
  let tick = 0;
  return track.map(event => ({ ...event, tick: tick += event.deltaTime }));
}

test('song JSON keeps nested racks and decisions separate from the byte-identical ALS archive', () => {
  const bytes = nativeFixture();
  const document = captureAls(bytes, 'test.als', '2026-11-07T00:00:00.000Z');
  assert.equal(document.source.gzip_base64, undefined);
  assert.equal(document.source.archive_file, `${document.source.sha256}.als`);
  assert.deepEqual(document.decisions, []);
  assert.deepEqual(restoreBytes(document, bytes), bytes);
  assert.throws(() => restoreBytes(document), /separate .als/);
  assert.equal(document.state.session.signature_numerator, 4);
  assert.equal(document.state.session.signature_denominator, 4);
  const rack = document.state.tracks[0].devices[0];
  assert.equal(rack.macros[0].value, 42);
  assert.deepEqual(rack.chains[0].mixer_values, [{ path: 'Volume', value: '0.8' }]);
  assert.equal(rack.chains[0].devices[0].type, 'Drift');
  assert.equal(document.state.tracks[0].clip_slots[0].clip.notes[0].release_velocity, 32);
});

test('native restore rejects corrupt payloads, changed summaries, and invalid versions', () => {
  const document = captureAls(nativeFixture(), 'test.als');
  const badHash = structuredClone(document);
  badHash.source.sha256 = '0'.repeat(64);
  badHash.source.archive_file = `${badHash.source.sha256}.als`;
  assert.throws(() => restoreBytes(badHash, nativeFixture()), /checksum/);
  const changed = structuredClone(document);
  changed.state.tracks[0].name = 'Edited';
  assert.throws(() => restoreBytes(changed, nativeFixture()), /cannot apply JSON edits/);
  assert.equal(buildRebuildPlan(changed).archive_required, false);
  const badVersion = structuredClone(document);
  badVersion.schema_version = '2.0.0';
  assert.throws(() => restoreBytes(badVersion), /Invalid song document/);
  assert.throws(() => captureAls(nativeFixture(), 'test.als', 'yesterday'), /Invalid song document/);
});

test('ALS reader rejects invalid gzip, invalid XML, document types, and unknown track types', () => {
  assert.throws(() => inspectAls(Buffer.from('not gzip')), /gzip/);
  assert.throws(() => inspectAls(gzipSync(Buffer.from('<Ableton>'))), /Invalid ALS XML/);
  assert.throws(() => inspectAls(gzipSync(Buffer.from('<!DOCTYPE Ableton><Ableton/>'))), /document types/);
  const xml = '<Ableton><LiveSet><Tracks><UnknownTrack/></Tracks></LiveSet></Ableton>';
  assert.throws(() => inspectAls(gzipSync(Buffer.from(xml))), /track type/);
});

test('Session export encodes tempo, signature, trimmed notes, release velocities, and whole-bar duration', () => {
  const plan = buildMpcExport(state(), { view: 'session' });
  const midi = parseMidi(plan.files[0].bytes);
  assert.equal(midi.header.format, 1);
  assert.equal(midi.header.ticksPerBeat, PPQ);
  assert.equal(midi.tracks[0][0].microsecondsPerBeat, Math.round(60_000_000 / 115));
  assert.equal(midi.tracks[0][1].denominator, 4);
  const events = absoluteEvents(midi.tracks[1]);
  assert.deepEqual(events.filter(e => e.type === 'noteOn').map(e => e.tick), [0, 3.75 * PPQ]);
  assert.deepEqual(events.filter(e => e.type === 'noteOff').map(e => e.tick), [0.5 * PPQ, 4 * PPQ]);
  assert.equal(events.at(-1).tick, 4 * PPQ);
  assert.equal(plan.files[0].entry.tracks[0].midi_channel, 1);
});

test('Session loop-region export retains local timing and cannot escape its output directory', () => {
  const c = clip({ name: '../../danger/名前', loop_start: 2, loop_end: 6, notes: [note(1), note(2.25), note(5.75), note(6)] });
  const file = buildMpcExport(state([c]), { view: 'session' }).files[0];
  assert.match(file.path, /^session\/track-1-slot-1-[a-zA-Z0-9_-]+\.mid$/);
  const events = absoluteEvents(parseMidi(file.bytes).tracks[1]);
  assert.deepEqual(events.filter(e => e.type === 'noteOn').map(e => e.tick), [0.25 * PPQ, 3.75 * PPQ]);
  assert.equal(file.entry.tracks[0].exported_notes, 2);
});

test('Arrangement export expands loops, preserves gaps, clips the last repetition, and pads to bars', () => {
  const c = clip({ start_time: 2, end_time: 11, length: 9, notes: [note(0), note(3.75)] });
  const file = buildMpcExport(state([], [c]), { view: 'arrangement' }).files[0];
  const events = absoluteEvents(parseMidi(file.bytes).tracks[1]);
  assert.deepEqual(events.filter(e => e.type === 'noteOn').map(e => e.tick / PPQ), [2, 5.75, 6, 9.75, 10]);
  assert.equal(events.at(-1).tick / PPQ, 12);
  assert.equal(file.entry.length_beats, 11);
});

test('Arrangement non-looping clips preserve absolute position and blank tracks', () => {
  const c = clip({ looping: false, start_time: 8, end_time: 12, notes: [note(1)] });
  const s = state([], [c]);
  s.tracks.push({ index: 1, name: 'Blank', clip_slots: [], arrangement_clips: [clip({ start_time: 0, end_time: 4, notes: [] })] });
  const file = buildMpcExport(s, { view: 'arrangement' }).files[0];
  const midi = parseMidi(file.bytes);
  assert.equal(midi.tracks.length, 3);
  assert.equal(absoluteEvents(midi.tracks[1]).find(e => e.type === 'noteOn').tick / PPQ, 9);
  assert.equal(midi.tracks[2].filter(e => e.type === 'noteOn').length, 0);
});

test('Unsupported offsets, overlapping clips, excessive loops, invalid notes and empty exports fail explicitly', () => {
  assert.throws(() => buildMpcExport(state([], [clip({ start_time: 0, end_time: 4, start_relative: 1 })])), /offsets/);
  assert.throws(() => buildMpcExport(state([], [clip({ start_time: 0, end_time: 4 }), clip({ start_time: 2, end_time: 6 })])), /Overlapping/);
  assert.throws(() => buildMpcExport(state([], [clip({ start_time: 0, end_time: 4, loop_end: 0.000001 })])), /excessive/);
  assert.throws(() => buildMpcExport(state([clip({ notes: [{ ...note(0), pitch: 128 }] })])), /Invalid MIDI note/);
  assert.throws(() => buildMpcExport(state([clip({ notes: [{ ...note(0), release_velocity: -1 }] })])), /Invalid MIDI note/);
  assert.throws(() => buildMpcExport(state([], [])), /No MIDI clips/);
  assert.throws(() => buildMpcExport(state(), { view: 'unknown' }), /View must/);
});

test('Probability and deviation require explicit flattening, while muted and probability-zero notes are excluded', () => {
  const s = state([clip({ notes: [{ ...note(0), mute: true }, { ...note(1), probability: 0 }, { ...note(2), probability: 0.5 }] })]);
  assert.throws(() => buildMpcExport(s), /flatten-expression/);
  const plan = buildMpcExport(s, { flattenExpression: true });
  assert.equal(plan.files[0].entry.tracks[0].exported_notes, 1);
  assert.ok(plan.warnings.some(w => w.includes('Probabilistic')));
});

test('same-tick note-offs precede note-ons and short notes retain a positive MIDI duration', () => {
  const s = state([clip({ notes: [note(0, 0.5), note(0.5, 0.000001)] })]);
  const events = absoluteEvents(parseMidi(buildMpcExport(s).files[0].bytes).tracks[1]);
  assert.deepEqual(events.filter(e => e.tick === 0.5 * PPQ).map(e => e.type), ['noteOff', 'noteOn']);
  assert.equal(events.filter(e => e.type === 'noteOff').at(-1).tick, 0.5 * PPQ + 1);
});

test('legacy MCP snapshots remain readable without modifying the input', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'blooby-snapshot-test-'));
  try {
    const path = join(dir, 'snapshot.json');
    const before = Buffer.from(JSON.stringify(snapshotFixture()));
    await writeFile(path, before);
    const input = await readInput(path);
    assert.equal(input.legacy, true);
    assert.deepEqual(input.state, snapshotFixture());
    const plan = buildMpcExport(state(), { legacy: input.legacy });
    assert.ok(plan.warnings.some(w => w.includes('MCP snapshot lacks')));
    assert.deepEqual(await readFile(path), before);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('CLIs capture, restore, and export with exclusive outputs and non-zero failure status', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'blooby-test-'));
  try {
    const source = join(dir, 'source.als');
    const json = join(dir, 'native.json');
    const restored = join(dir, 'restored.als');
    const out = join(dir, 'mpc');
    await writeFile(source, nativeFixture());
    execFileSync(process.execPath, ['bin/ableton-document.js', 'capture', source, '--out', json]);
    execFileSync(process.execPath, ['bin/ableton-document.js', 'restore', json, '--out', restored]);
    assert.deepEqual(await readFile(source), await readFile(restored));
    execFileSync(process.execPath, ['bin/export-mpc.js', source, '--out', out], { stdio: 'pipe' });
    const manifest = JSON.parse(await readFile(join(out, 'manifest.json'), 'utf8'));
    assert.equal(manifest.files.length, 1);
    assert.equal(parseMidi(await readFile(join(out, manifest.files[0].file))).header.ticksPerBeat, PPQ);
    const second = spawnSync(process.execPath, ['bin/export-mpc.js', source, '--out', out]);
    assert.equal(second.status, 1);
    assert.match(second.stderr.toString(), /EEXIST/);
    await assert.rejects(writeNewFile(source, Buffer.from('overwrite')), { code: 'EEXIST' });
    assert.deepEqual(await readFile(source), nativeFixture());
    const invalid = spawnSync(process.execPath, ['bin/ableton-document.js', 'restore', json, '--out', source]);
    assert.equal(invalid.status, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('song paths preserve names and reject empty or unsafe basename components', () => {
  assert.equal(songDocumentPath('/sets/My Song.als'), join('songs', 'My Song', 'My Song.json'));
  for (const name of ['.als', '..als', '...als', 'bad\\name.als', 'song.json']) {
    assert.throws(() => songDocumentPath(name), /Song name/);
  }
});

test('refresh CLI isolates named songs, resolves the schema, and preserves sibling binary assets', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'blooby-refresh-test-'));
  try {
    const source = join(dir, 'My Song.als');
    const output = join(dir, 'songs', 'My Song', 'My Song.json');
    const cli = join(process.cwd(), 'bin', 'ableton-document.js');
    const first = nativeFixture();
    await writeFile(source, first);
    execFileSync(process.execPath, [cli, 'refresh', source], { cwd: dir });
    const firstDoc = JSON.parse(await readFile(output, 'utf8'));
    assert.deepEqual(restoreBytes(firstDoc, await readFile(join(dirname(output), firstDoc.source.archive_file))), first);
    await recordDecision(output, { id: 'keep-attack', scope: 'Brass', intent: 'Keep attack and fuzz', implementation: 'Parallel synth voices' });
    const audio = Buffer.from([0, 255, 1, 128]);
    const asset = join(dirname(output), 'audio.blob');
    await writeFile(asset, audio);
    const changed = gzipSync(Buffer.from(gunzipSync(first).toString().replace('Value="115"', 'Value="120"')));
    await writeFile(source, changed);
    execFileSync(process.execPath, [cli, 'refresh', source], { cwd: dir });
    const document = JSON.parse(await readFile(output, 'utf8'));
    assert.equal(document.state.session.tempo, 120);
    assert.equal(document.source.file_name, 'My Song.als');
    assert.deepEqual(
      await readFile(resolve(dirname(output), document.$schema)),
      await readFile(new URL('../schema/ableton-song-document.schema.json', import.meta.url)),
    );
    assert.deepEqual(restoreBytes(document, await readFile(join(dirname(output), document.source.archive_file))), changed);
    assert.equal(document.decisions[0].id, 'keep-attack');
    assert.deepEqual(await readFile(source), changed);
    assert.deepEqual(await readFile(asset), audio);
    assert.deepEqual((await readdir(dirname(output))).sort(), [firstDoc.source.archive_file, document.source.archive_file, 'My Song.json', 'audio.blob'].sort());
    const previous = await readFile(output);
    const other = join(dir, 'Other Song.als');
    await writeFile(other, first);
    execFileSync(process.execPath, [cli, 'refresh', other], { cwd: dir });
    const otherDoc = JSON.parse(await readFile(join(dir, 'songs', 'Other Song', 'Other Song.json'), 'utf8'));
    assert.deepEqual(restoreBytes(otherDoc, first), first);
    assert.deepEqual(await readFile(output), previous);
    assert.deepEqual(await readFile(asset), audio);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('refresh failures preserve existing outputs and reject snapshots, invalid native JSON, and unsafe paths', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'blooby-refresh-failure-test-'));
  try {
    const source = join(dir, 'source.als');
    const output = join(dir, 'saved.json');
    const run = (...args) => spawnSync(process.execPath, ['bin/ableton-document.js', 'refresh', source, '--out', output, ...args]);
    await writeFile(source, nativeFixture());
    assert.equal(run().status, 0);
    const previous = await readFile(output);
    await writeFile(source, 'not gzip');
    const invalidSource = run();
    assert.equal(invalidSource.status, 1);
    assert.match(invalidSource.stderr.toString(), /gzip/);
    assert.deepEqual(await readFile(output), previous);
    await writeFile(source, nativeFixture());
    const snapshot = Buffer.from(JSON.stringify(snapshotFixture()));
    const changed = JSON.parse(previous);
    changed.source.archive_file = 'invalid.als';
    for (const existing of [snapshot, Buffer.from('{'), Buffer.from(JSON.stringify(changed))]) {
      await writeFile(output, existing);
      assert.equal(run().status, 1);
      assert.deepEqual(await readFile(output), existing);
    }
    const samePath = spawnSync(process.execPath, ['bin/ableton-document.js', 'refresh', source, '--out', source]);
    assert.equal(samePath.status, 1);
    assert.match(samePath.stderr.toString(), /different/);
    const wrongExtension = spawnSync(process.execPath, ['bin/ableton-document.js', 'refresh', source, '--out', join(dir, 'other.als')]);
    assert.equal(wrongExtension.status, 1);
    assert.match(wrongExtension.stderr.toString(), /extension/);
    assert.deepEqual(await readFile(source), nativeFixture());
    assert.deepEqual((await readdir(dir)).sort(), [JSON.parse(previous).source.archive_file, 'saved.json', 'source.als'].sort());
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('legacy embedded documents migrate to separate archives without losing native bytes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'blooby-migration-test-'));
  try {
    const bytes = nativeFixture();
    const captured = captureAls(bytes, 'source.als');
    const legacy = {
      $schema: '../schema/ableton-native.schema.json', format: 'ableton-native-document',
      schema_version: '0.1.0', captured_at: captured.captured_at,
      source: { file_name: 'source.als', sha256: captured.source.sha256, gzip_base64: bytes.toString('base64') },
      state: captured.state,
    };
    assert.deepEqual(restoreBytes(legacy), bytes);
    const source = join(dir, 'source.als');
    const output = join(dir, 'song.json');
    await writeFile(source, bytes);
    await writeFile(output, JSON.stringify(legacy));
    execFileSync(process.execPath, ['bin/ableton-document.js', 'refresh', source, '--out', output]);
    const document = JSON.parse(await readFile(output, 'utf8'));
    assert.equal(document.format, 'ableton-song-document');
    assert.equal(document.source.gzip_base64, undefined);
    assert.deepEqual(await readFile(join(dir, document.source.archive_file)), bytes);
    await unlink(join(dir, document.source.archive_file));
    assert.deepEqual((await readInput(output)).state, document.state);
    const planFile = join(dir, 'plan.json');
    execFileSync(process.execPath, ['bin/ableton-document.js', 'rebuild-plan', output, '--out', planFile], { stdio: 'pipe' });
    const plan = JSON.parse(await readFile(planFile, 'utf8'));
    assert.equal(plan.archive_required, false);
    const restore = spawnSync(process.execPath, ['bin/ableton-document.js', 'restore', output, '--out', join(dir, 'restored.als')]);
    assert.equal(restore.status, 1);
    assert.match(restore.stderr.toString(), /ENOENT/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('rebuild plans preserve nested topology and explicitly gate manual settings and missing data', () => {
  const document = captureAls(nativeFixture(), 'source.als');
  const rack = document.state.tracks[0].devices[0];
  const nested = structuredClone(rack);
  nested.chains[0].devices[0].name = 'Deep synth';
  rack.chains[0].devices.push(nested);
  const plan = buildRebuildPlan(document);
  assert.equal(plan.exact_recreation, false);
  assert.ok(plan.steps.some(step => step.call?.name === 'insert_device' && step.call.arguments.chain_index === 0));
  assert.ok(plan.steps.some(step => step.kind === 'manual' && step.source.endsWith('/devices/1/chains')));
  assert.equal(plan.steps.filter(step => step.kind === 'missing_data').length, document.coverage.not_captured.length);
  assert.ok(plan.steps.some(step => step.call?.name === 'add_notes' && step.call.arguments.notes[0].pitch === 60));
  for (let i = 1; i < plan.steps.length; i++) assert.deepEqual(plan.steps[i].depends_on, [plan.steps[i - 1].id]);
  document.state.tracks[0].clip_slots[0].clip.notes[0].duration = -1;
  assert.throws(() => buildRebuildPlan(document), /Invalid MIDI note/);
});

test('decision CLI records intent without changing musical state and rejects duplicate or invalid decisions', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'blooby-decision-test-'));
  try {
    const path = join(dir, 'song.json');
    const document = captureAls(nativeFixture(), 'song.als');
    await writeFile(path, JSON.stringify(document));
    const args = ['bin/ableton-document.js', 'decision', path, '--id', 'brass', '--scope', 'Brass', '--intent', 'Keep both tones', '--implementation', 'Two parallel synth voices'];
    execFileSync(process.execPath, args);
    const annotated = JSON.parse(await readFile(path, 'utf8'));
    assert.deepEqual(annotated.state, document.state);
    assert.equal(annotated.decisions[0].intent, 'Keep both tones');
    assert.equal(spawnSync(process.execPath, args).status, 1);
    const before = await readFile(path);
    await assert.rejects(recordDecision(path, { id: 'invalid' }), /Invalid song document/);
    assert.deepEqual(await readFile(path), before);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
