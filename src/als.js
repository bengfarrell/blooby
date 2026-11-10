import { gunzipSync } from 'node:zlib';
import { DOMParser } from '@xmldom/xmldom';

export const MAX_ALS_BYTES = 64 * 1024 * 1024;
const MAX_XML_BYTES = 128 * 1024 * 1024;

export function children(node, name) {
  return Array.from(node?.childNodes ?? []).filter(
    child => child.nodeType === 1 && (!name || child.tagName === name),
  );
}

function at(node, path) {
  return path.split('/').reduce((parent, name) => children(parent, name)[0], node);
}

function value(node, path, fallback) {
  const field = at(node, path);
  if (!field?.hasAttribute('Value')) {
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing ALS field: ${path}`);
  }
  return field.getAttribute('Value');
}

function number(text, label) {
  if (text === '' || !Number.isFinite(Number(text))) {
    throw new Error(`Invalid ALS number for ${label}: ${text}`);
  }
  return Number(text);
}

function numeric(node, path, fallback) {
  return number(value(node, path, fallback), path);
}

function boolean(text, label) {
  if (text !== 'true' && text !== 'false') throw new Error(`Invalid ALS boolean for ${label}: ${text}`);
  return text === 'true';
}

function manualFields(node, path = '') {
  const fields = [];
  for (const child of children(node)) {
    if (['Devices', 'Branches', 'ReturnBranches'].includes(child.tagName)) continue;
    const nextPath = path ? `${path}/${child.tagName}` : child.tagName;
    const manual = children(child, 'Manual')[0];
    if (manual?.hasAttribute('Value')) {
      fields.push({ path: nextPath, value: manual.getAttribute('Value') });
    } else {
      fields.push(...manualFields(child, nextPath));
    }
  }
  return fields;
}

function deviceTree(node, index) {
  const branchTree = branch => {
    const chain = children(at(branch, 'DeviceChain'))[0];
    const mixer = at(branch, 'MixerDevice');
    return {
      id: branch.getAttribute('Id'),
      type: branch.tagName,
      name: value(branch, 'Name/EffectiveName', ''),
      mixer_values: mixer ? manualFields(mixer) : [],
      devices: children(at(chain, 'Devices')).map(deviceTree),
    };
  };
  return {
    index,
    id: node.getAttribute('Id'),
    type: node.tagName,
    name: value(node, 'UserName', '') || node.tagName,
    parameter_values: manualFields(node),
    macros: children(node).filter(child => /^MacroControls\.\d+$/.test(child.tagName)).map(child => {
      const index = Number(child.tagName.split('.')[1]);
      return {
        index,
        name: value(node, `MacroDisplayNames.${index}`, `Macro ${index + 1}`),
        value: numeric(child, 'Manual'),
      };
    }),
    chains: children(at(node, 'Branches')).map(branchTree),
    return_chains: children(at(node, 'ReturnBranches')).map(branchTree),
  };
}

function noteAttribute(node, name, fallback) {
  return node.hasAttribute(name) ? node.getAttribute(name) : fallback;
}

function readClip(node, index, arrangement) {
  const loopStart = numeric(node, 'Loop/LoopStart');
  const loopEnd = numeric(node, 'Loop/LoopEnd');
  const start = numeric(node, 'CurrentStart');
  const end = numeric(node, 'CurrentEnd');
  const audio = node.tagName === 'AudioClip';
  const clip = {
    index,
    name: value(node, 'Name'),
    is_audio_clip: audio,
    length: arrangement ? end - start : loopEnd - loopStart,
    looping: boolean(value(node, 'Loop/LoopOn'), 'LoopOn'),
    loop_start: loopStart,
    loop_end: loopEnd,
    start_relative: numeric(node, 'Loop/StartRelative'),
    out_marker: numeric(node, 'Loop/OutMarker'),
  };
  if (arrangement) {
    clip.start_time = start;
    clip.end_time = end;
  }
  if (audio) return clip;
  clip.notes = children(at(node, 'Notes/KeyTracks')).flatMap(key => {
    const pitch = numeric(key, 'MidiKey');
    return children(at(key, 'Notes'), 'MidiNoteEvent').map(note => ({
      note_id: number(noteAttribute(note, 'NoteId', ''), 'NoteId'),
      pitch,
      start_time: number(noteAttribute(note, 'Time', ''), 'Time'),
      duration: number(noteAttribute(note, 'Duration', ''), 'Duration'),
      velocity: number(noteAttribute(note, 'Velocity', ''), 'Velocity'),
      release_velocity: number(noteAttribute(note, 'OffVelocity', '64'), 'OffVelocity'),
      mute: !boolean(noteAttribute(note, 'IsEnabled', 'true'), 'IsEnabled'),
      probability: number(noteAttribute(note, 'Probability', '1'), 'Probability'),
      velocity_deviation: number(noteAttribute(note, 'VelocityDeviation', '0'), 'VelocityDeviation'),
    }));
  }).sort((a, b) => a.start_time - b.start_time || a.pitch - b.pitch || a.note_id - b.note_id);
  return clip;
}

function readTrack(node, index) {
  const sequencer = at(node, 'DeviceChain/MainSequencer');
  const slots = children(at(sequencer, 'ClipSlotList')).map((slot, index) => {
    const contents = children(at(slot, 'ClipSlot/Value'));
    if (contents.length > 1 || contents.some(child => !['MidiClip', 'AudioClip'].includes(child.tagName))) {
      throw new Error(`Unsupported Session slot contents on track ${index}`);
    }
    return {
      index,
      has_clip: contents.length === 1,
      ...(contents.length ? { clip: readClip(contents[0], index, false) } : {}),
    };
  });
  const eventContainers = ['ClipTimeable', 'Sample'].map(tag =>
    at(sequencer, `${tag}/ArrangerAutomation/Events`),
  ).filter(Boolean);
  if (eventContainers.length > 1) throw new Error('Ambiguous Arrangement event containers');
  const arrangement = children(eventContainers[0]);
  if (arrangement.some(child => !['MidiClip', 'AudioClip'].includes(child.tagName))) {
    throw new Error('Unsupported Arrangement event type');
  }
  return {
    index,
    id: node.getAttribute('Id'),
    type: node.tagName,
    name: value(node, 'Name/EffectiveName'),
    devices: children(at(node, 'DeviceChain/DeviceChain/Devices')).map(deviceTree),
    mixer_values: manualFields(at(node, 'DeviceChain/Mixer')),
    clip_slots: slots,
    arrangement_clips: arrangement.map((clip, index) => readClip(clip, index, true)),
  };
}

export function inspectAls(bytes) {
  if (bytes.length > MAX_ALS_BYTES) throw new Error('ALS file exceeds the 64 MiB input limit');
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) throw new Error('Expected a gzip-compressed .als file');
  const xml = gunzipSync(bytes, { maxOutputLength: MAX_XML_BYTES }).toString('utf8');
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('XML document types and entities are not supported');
  const dom = new DOMParser({
    onError(level, message) { throw new Error(`Invalid ALS XML (${level}): ${message}`); },
  }).parseFromString(xml, 'application/xml');
  const root = dom.documentElement;
  if (root.tagName !== 'Ableton') throw new Error('Expected an Ableton XML document');
  const live = at(root, 'LiveSet');
  if (!live || !at(live, 'Tracks')) throw new Error('Missing LiveSet/Tracks');
  const nodes = children(at(live, 'Tracks'));
  if (nodes.some(node => !['MidiTrack', 'AudioTrack', 'ReturnTrack', 'GroupTrack'].includes(node.tagName))) {
    throw new Error('Unsupported ALS track type');
  }
  const master = at(live, 'MainTrack') ?? at(live, 'MasterTrack');
  if (!master) throw new Error('Missing MainTrack/MasterTrack');
  const signatureId = numeric(master, 'DeviceChain/Mixer/TimeSignature/Manual');
  if (!Number.isInteger(signatureId) || signatureId < 0 || signatureId > 494) {
    throw new Error('Unsupported Live time-signature encoding');
  }
  const references = Array.from(root.getElementsByTagName('FileRef')).map(ref => ({
    path: value(ref, 'Path', ''),
    relative_path: value(ref, 'RelativePath', ''),
    pack: value(ref, 'LivePackName', ''),
  })).filter(ref => ref.path || ref.relative_path);
  return {
    creator: root.getAttribute('Creator'),
    session: {
      tempo: numeric(master, 'DeviceChain/Mixer/Tempo/Manual'),
      signature_numerator: signatureId % 99 + 1,
      signature_denominator: 2 ** Math.floor(signatureId / 99),
    },
    tracks: nodes.filter(node => node.tagName !== 'ReturnTrack').map(readTrack),
    return_tracks: nodes.filter(node => node.tagName === 'ReturnTrack').map((node, index) => readTrack(node, -index - 1)),
    master_track: readTrack(master, -1000),
    file_references: [...new Map(references.map(ref => [JSON.stringify(ref), ref])).values()],
  };
}
