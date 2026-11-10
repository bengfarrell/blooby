import { validateSongDocument } from './documents.js';

const nativeNames = {
  InstrumentGroupDevice: 'Instrument Rack',
  AudioEffectGroupDevice: 'Audio Effect Rack',
  UltraAnalog: 'Analog',
  Drift: 'Drift',
  Eq8: 'EQ Eight',
  FilterEQ3: 'EQ Three',
  Compressor2: 'Compressor',
  Reverb: 'Reverb',
  Delay: 'Delay',
  Saturator: 'Saturator',
};

export function buildRebuildPlan(document) {
  validateSongDocument(document);
  const steps = [];
  function step(kind, source, instruction, call) {
    const id = `step-${steps.length + 1}`;
    steps.push({
      id, kind, source, instruction,
      depends_on: steps.length ? [steps.at(-1).id] : [],
      ...(call ? { call } : {}),
    });
  }
  const manual = (source, instruction) => step('manual', source, instruction);
  const tool = (source, name, args) => step('mcp', source, `Call ${name}; verify success before continuing.`, { name, arguments: args });
  const state = document.state;
  if (state.session.tempo < 20 || state.session.tempo > 999) throw new Error('Tempo is outside the MCP range (20-999 BPM)');
  const sceneCount = Math.max(0, ...state.tracks.map(track => track.clip_slots.length));
  manual('/state', `Use a NEW, separate Live Set with transport stopped. Create the listed regular/return tracks in order, preserving their types, and at least ${sceneCount} scenes. Remove default devices. Do not modify the source song. Confirm track indices before continuing.`);
  tool('/state/session/tempo', 'set_tempo', { tempo: state.session.tempo });
  tool('/state/session', 'set_time_signature', {
    numerator: state.session.signature_numerator, denominator: state.session.signature_denominator,
  });

  function devices(list, trackIndex, source, parent) {
    list.forEach((device, index) => {
      const path = `${source}/${index}`;
      const nativeName = nativeNames[device.type];
      if (!nativeName) {
        manual(path, `Create "${device.name}" (${device.type}) at this exact position and configure its entire subtree from the JSON. No verified native-device mapping is available; sample/plugin state may also be missing.`);
        return;
      }
      tool(path, 'insert_device', {
        track_index: trackIndex, device_name: nativeName, position: index, ...parent,
      });
      if (device.chains.length) {
        if (parent) {
          manual(`${path}/chains`, 'Build this nested rack subtree manually, preserving parallel chains, device order, mixer values and every nested device. The available insertion tools cannot address racks at this depth.');
        } else {
          device.chains.forEach((chain, chainIndex) => {
            const chainPath = `${path}/chains/${chainIndex}`;
            tool(chainPath, 'insert_rack_chain', {
              track_index: trackIndex, device_index: index, position: chainIndex,
            });
            tool(`${chainPath}/name`, 'rename_chain', {
              track_index: trackIndex, device_index: index, chain_index: chainIndex, name: chain.name,
            });
            manual(`${chainPath}/mixer_values`, 'Apply the chain mixer values manually, checking native amplitude versus MCP/display units. Confirm selector/key/velocity zones and macro mappings; these are not captured by this reader.');
            devices(chain.devices, trackIndex, `${chainPath}/devices`, { device_index: index, chain_index: chainIndex });
          });
        }
      }
      if (device.return_chains.length) {
        manual(`${path}/return_chains`, 'Recreate the rack return chains, their devices, mixers and routing manually from the JSON.');
      }
      manual(path, `Name this device "${device.name}". Apply its parameter_values and macros using verified native-to-MCP/display mappings, or manually in Live. Saved native values are NOT assumed to be MCP values. Do not proceed until this device is configured.`);
    });
  }

  const tracks = [
    ...state.tracks.map((track, i) => [track, `/state/tracks/${i}`, i]),
    ...state.return_tracks.map((track, i) => [track, `/state/return_tracks/${i}`, -i - 1]),
    [state.master_track, '/state/master_track', -1000],
  ];
  for (const [track, path, expectedIndex] of tracks) {
    if (track.index !== expectedIndex) throw new Error(`Non-contiguous track indices at ${path}`);
    manual(path, `Verify track "${track.name}" (${track.type}) at index ${track.index}. Apply mixer_values manually, including mute, level, pan and sends. Confirm routing/group membership separately; complete routing is not captured.`);
    devices(track.devices, track.index, `${path}/devices`);
    track.clip_slots.forEach((slot, slotIndex) => {
      if (slot.index !== slotIndex) throw new Error(`Non-contiguous clip slots at ${path}`);
      if (!slot.has_clip) return;
      const clipPath = `${path}/clip_slots/${slotIndex}/clip`;
      const clip = slot.clip;
      if (!clip || clip.is_audio_clip) {
        manual(clipPath, 'Recreate this audio clip manually. File references alone do not specify sample assignment, warp markers or the complete playback state.');
        return;
      }
      const clipArgs = { track_index: track.index, clip_index: slot.index };
      if (!Number.isFinite(clip.length) || clip.length <= 0
        || !Number.isFinite(clip.loop_start) || !Number.isFinite(clip.loop_end) || clip.loop_end <= clip.loop_start) {
        throw new Error(`Invalid clip loop at ${clipPath}`);
      }
      if (!Array.isArray(clip.notes)) throw new Error(`Missing MIDI notes at ${clipPath}`);
      const notes = clip.notes.map(note => {
        if (!Number.isInteger(note.pitch) || note.pitch < 0 || note.pitch > 127
          || !Number.isFinite(note.start_time) || !Number.isFinite(note.duration) || note.duration <= 0
          || !Number.isFinite(note.velocity) || note.velocity < 0 || note.velocity > 127
          || !Number.isFinite(note.release_velocity) || note.release_velocity < 0 || note.release_velocity > 127
          || !Number.isFinite(note.probability) || note.probability < 0 || note.probability > 1
          || !Number.isFinite(note.velocity_deviation) || Math.abs(note.velocity_deviation) > 127) {
          throw new Error(`Invalid MIDI note at ${clipPath}`);
        }
        return { muted: note.mute, note: {
          pitch: note.pitch, start_time: note.start_time, duration: note.duration, velocity: note.velocity,
          release_velocity: note.release_velocity, probability: note.probability, velocity_deviation: note.velocity_deviation,
        } };
      }).filter(entry => !entry.muted).map(entry => entry.note);
      tool(clipPath, 'create_clip', { ...clipArgs, length: Math.max(clip.loop_end, clip.length) });
      tool(`${clipPath}/name`, 'set_clip_name', { ...clipArgs, name: clip.name });
      if (notes.length) tool(`${clipPath}/notes`, 'add_notes', { ...clipArgs, notes });
      tool(clipPath, 'set_clip_loop', {
        ...clipArgs, enabled: clip.looping, loop_start: clip.loop_start, loop_end: clip.loop_end,
      });
      manual(clipPath, 'Apply start_relative/out_marker and any muted notes manually. Launch/follow settings, expression and grooves need additional capture; do not assume defaults reproduce the source.');
    });
    if (track.arrangement_clips.length) {
      manual(`${path}/arrangement_clips`, 'Recreate Arrangement clips from their absolute positions, loops, offsets and notes. This planner currently emits Session MIDI calls only; do not substitute a single loop for the Arrangement.');
    }
  }
  for (const gap of document.coverage.not_captured) step('missing_data', '/coverage/not_captured', `Capture or explicitly resolve before claiming equivalence: ${gap}`);
  manual('/decisions', 'Audition against the recorded musical decisions. Compare rebuilt state with the specification, save the NEW set and capture it separately. A completed tool call list is not proof of equivalent sound.');
  return {
    format: 'ableton-mcp-rebuild-plan',
    schema_version: '0.1.0',
    status: 'requires-manual-work',
    exact_recreation: false,
    execution: 'Plan only. An MCP-capable agent/operator must execute in order, stop at every manual/missing_data step, verify tool availability and results, and never skip dependencies.',
    archive_required: false,
    decisions: document.decisions,
    steps,
  };
}
