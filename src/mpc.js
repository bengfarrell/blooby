import { writeMidi } from 'midi-file';
import { mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { writeNewFile } from './documents.js';

export const PPQ = 960;
const MAX_EVENTS = 1_000_000;
const MAX_TICKS = 0x0fffffff;

function ticks(beats) {
  const value = Math.round(beats * PPQ);
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_TICKS) {
    throw new Error(`MIDI time outside supported range: ${beats} beats`);
  }
  return value;
}

function safeName(name) {
  return name.normalize('NFKD').replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'clip';
}

function noteEvents(notes, channel, flatten, warnings) {
  return notes.flatMap(note => {
    if (!Number.isInteger(note.pitch) || note.pitch < 0 || note.pitch > 127
      || !Number.isFinite(note.start_time) || !Number.isFinite(note.duration) || note.duration <= 0
      || !Number.isFinite(note.velocity) || note.velocity < 0 || note.velocity > 127
      || !Number.isFinite(note.probability) || note.probability < 0 || note.probability > 1
      || (note.velocity_deviation !== undefined && (!Number.isFinite(note.velocity_deviation) || Math.abs(note.velocity_deviation) > 127))
      || (note.release_velocity !== undefined && (!Number.isFinite(note.release_velocity) || note.release_velocity < 0 || note.release_velocity > 127))) {
      throw new Error('Invalid MIDI note');
    }
    if (note.mute || note.probability === 0 || note.velocity === 0) return [];
    if (note.probability !== 1 || (note.velocity_deviation ?? 0) !== 0) {
      if (!flatten) throw new Error('Probability/velocity variation requires --flatten-expression');
      warnings.add('Probabilistic notes included once at their base velocity; velocity variation omitted.');
    }
    const start = ticks(note.start_time);
    const end = Math.max(start + 1, ticks(note.start_time + note.duration));
    if (end > MAX_TICKS) throw new Error('MIDI note end exceeds supported range');
    return [
      { tick: start, type: 'noteOn', channel, noteNumber: note.pitch, velocity: Math.max(1, Math.round(note.velocity)) },
      { tick: end, type: 'noteOff', channel, noteNumber: note.pitch, velocity: Math.round(note.release_velocity ?? 64) },
    ];
  });
}

function deltaTrack(events, endTick) {
  events.sort((a, b) => a.tick - b.tick || (a.type === 'noteOff' ? -1 : 0) - (b.type === 'noteOff' ? -1 : 0));
  let previous = 0;
  const result = events.map(({ tick, ...event }) => {
    const deltaTime = tick - previous;
    previous = tick;
    return { deltaTime, ...event };
  });
  result.push({ deltaTime: Math.max(previous, endTick) - previous, meta: true, type: 'endOfTrack' });
  return result;
}

function makeMidi(tracks, session, length, flatten, warnings) {
  if (tracks.length > 16) throw new Error('This exporter supports up to 16 MIDI tracks per file');
  if (tracks.reduce((count, track) => count + track.notes.length * 2, 0) > MAX_EVENTS) {
    throw new Error('File exceeds the MIDI event limit');
  }
  const numerator = session.signature_numerator;
  const denominator = session.signature_denominator;
  const tempo = Math.round(60_000_000 / session.tempo);
  if (!Number.isInteger(numerator) || numerator < 1 || numerator > 255
    || !Number.isInteger(denominator) || denominator < 1 || denominator > 128
    || !Number.isInteger(Math.log2(denominator))
    || !Number.isFinite(tempo) || tempo < 1 || tempo > 0xffffff) {
    throw new Error('Tempo/time signature cannot be represented in Standard MIDI');
  }
  const bars = Math.max(1, Math.ceil(length / (numerator * 4 / denominator)));
  const paddedLength = bars * numerator * 4 / denominator;
  const endTick = ticks(paddedLength);
  const conductor = deltaTrack([
    { tick: 0, meta: true, type: 'setTempo', microsecondsPerBeat: tempo },
    { tick: 0, meta: true, type: 'timeSignature', numerator, denominator, metronome: 24, thirtyseconds: 8 },
  ], endTick);
  const midiTracks = tracks.map((track, index) => deltaTrack([
    { tick: 0, meta: true, type: 'trackName', text: safeName(track.name) },
    ...noteEvents(track.notes, index, flatten, warnings),
  ], endTick));
  return {
    bytes: Buffer.from(writeMidi({ header: { format: 1, numTracks: midiTracks.length + 1, ticksPerBeat: PPQ }, tracks: [conductor, ...midiTracks] })),
    bars,
    padded_length_beats: paddedLength,
  };
}

function clipWindow(clip) {
  const start = clip.looping ? clip.loop_start : (clip.start_relative ?? clip.start_marker ?? 0);
  const end = clip.looping ? clip.loop_end : (clip.out_marker ?? clip.end_marker ?? clip.length);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) throw new Error('Invalid clip playback window');
  return { start, end };
}

function within(notes, start, end, offset = 0) {
  return notes.filter(note => note.start_time >= start && note.start_time < end).map(note => ({
    ...note,
    start_time: note.start_time - start + offset,
    duration: Math.min(note.duration, end - note.start_time),
  }));
}

export function buildMpcExport(state, { view = 'both', flattenExpression = false, legacy = false } = {}) {
  if (!['session', 'arrangement', 'both'].includes(view)) throw new Error('View must be session, arrangement, or both');
  const warnings = new Set([
    'MIDI only: assign MPC instruments/programs manually; no Ableton sounds, effects, automation, MPE, or media are transferred.',
    'Uses constant master tempo/time signature; tempo maps and per-clip/scene signatures are not exported.',
    'Muted notes are omitted. Track mute/solo, groove, and launch/follow actions are not applied.',
    'Timing is rounded to 960 ticks per quarter note; velocity/release velocity are rounded to MIDI integers.',
    'Notes starting outside a selected window are omitted; note tails crossing its end are trimmed.',
    'Files are padded with silence to a whole bar. Check sequence length, tempo, and program assignment after MPC import.',
  ]);
  if (legacy) warnings.add('MCP snapshot lacks some playback offsets; missing Arrangement offsets are treated as zero. Prefer .als input for saved timing.');
  const files = [];
  const addFile = (path, tracks, length, context) => {
    const midi = makeMidi(tracks, state.session, length, flattenExpression, warnings);
    files.push({
      path, bytes: midi.bytes,
      entry: {
        file: path, ...context, length_beats: length, bars: midi.bars,
        padded_length_beats: midi.padded_length_beats,
        tracks: tracks.map((track, channel) => ({
          source_track_index: track.index, name: track.name, midi_channel: channel + 1,
          exported_notes: track.notes.filter(note => !note.mute && note.probability !== 0 && note.velocity !== 0).length,
          midi_pitches: [...new Set(track.notes.filter(note => !note.mute && note.probability !== 0 && note.velocity !== 0).map(note => note.pitch))].sort((a, b) => a - b),
          source_devices: (track.devices ?? []).map(device => ({
            name: device.name, type: device.type ?? device.class_name,
          })),
        })),
      },
    });
  };
  if (view !== 'arrangement') {
    warnings.add('Session files contain one pass through each clip window, not an indefinitely looping Session performance.');
    for (const track of state.tracks) {
      for (const slot of track.clip_slots) {
        if (!slot.has_clip) continue;
        const clip = slot.clip;
        if (clip.is_audio_clip) {
          warnings.add(`Audio clip omitted: track ${track.index}, Session slot ${slot.index}.`);
          continue;
        }
        const { start, end } = clipWindow(clip);
        const notes = within(clip.notes, start, end);
        addFile(`session/track-${track.index + 1}-slot-${slot.index + 1}-${safeName(clip.name)}.mid`,
          [{ ...track, notes }], end - start, { view: 'session', slot_index: slot.index, clip_name: clip.name, window_start: start, window_end: end });
      }
    }
  }
  if (view !== 'session') {
    let length = 0;
    let totalEvents = 0;
    const tracks = [];
    for (const track of state.tracks) {
      const clips = [...track.arrangement_clips].sort((a, b) => a.start_time - b.start_time);
      let previousEnd = 0;
      const notes = [];
      for (const clip of clips) {
        if (!Number.isFinite(clip.start_time) || !Number.isFinite(clip.end_time)
          || clip.start_time < previousEnd || clip.end_time <= clip.start_time) {
          throw new Error('Overlapping or invalid Arrangement clips are not supported');
        }
        previousEnd = clip.end_time;
        length = Math.max(length, clip.end_time);
        if (clip.is_audio_clip) {
          warnings.add(`Audio clip omitted: track ${track.index}, Arrangement clip ${clip.index}.`);
          continue;
        }
        if ((clip.start_relative ?? 0) !== 0 || (clip.loop_start ?? 0) !== 0) {
          throw new Error('Non-zero Arrangement playback offsets are not supported in this first version');
        }
        const span = clip.end_time - clip.start_time;
        const period = clip.looping ? clip.loop_end - clip.loop_start : span;
        if (!Number.isFinite(period) || period <= 0 || span / period > MAX_EVENTS) {
          throw new Error('Invalid or excessive Arrangement loop repetition');
        }
        for (let offset = 0; offset < span; offset += period) {
          const part = within(clip.notes, 0, Math.min(period, span - offset), clip.start_time + offset);
          totalEvents += part.length * 2;
          if (totalEvents > MAX_EVENTS) throw new Error('Arrangement exceeds the MIDI event limit');
          notes.push(...part);
        }
      }
      if (clips.some(clip => !clip.is_audio_clip)) tracks.push({ ...track, notes });
    }
    if (tracks.length) addFile('arrangement.mid', tracks, length, { view: 'arrangement' });
  }
  if (!files.length) throw new Error(`No MIDI clips found for ${view} export`);
  return { files, warnings: [...warnings] };
}

export async function writeMpcExport(input, output, options) {
  const plan = buildMpcExport(input.state, { ...options, legacy: input.legacy });
  const manifest = {
    format: 'mpc-midi-transfer',
    schema_version: '0.1.0',
    target: 'MPC One+',
    midi_format: 1,
    ticks_per_quarter_note: PPQ,
    source: input.source,
    tempo: input.state.session.tempo,
    time_signature: [input.state.session.signature_numerator, input.state.session.signature_denominator],
    files: plan.files.map(file => file.entry),
    warnings: plan.warnings,
  };
  await mkdir(dirname(output), { recursive: true });
  await mkdir(output);
  for (const file of plan.files) await writeNewFile(join(output, file.path), file.bytes);
  await writeNewFile(join(output, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}
