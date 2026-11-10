import { createHash, randomUUID } from 'node:crypto';
import { readFile, open, mkdir, rename, unlink } from 'node:fs/promises';
import { dirname, basename, join, relative, resolve, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { inspectAls, MAX_ALS_BYTES } from './als.js';

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
const nativeSchema = JSON.parse(await readFile(new URL('../schema/ableton-native.schema.json', import.meta.url), 'utf8'));
const songSchema = JSON.parse(await readFile(new URL('../schema/ableton-song-document.schema.json', import.meta.url), 'utf8'));
const snapshotSchema = JSON.parse(await readFile(new URL('../schema/ableton-song.schema.json', import.meta.url), 'utf8'));
ajv.addSchema(nativeSchema, 'ableton-native.schema.json');
const validateNative = ajv.compile(nativeSchema);
const validateSong = ajv.compile(songSchema);
const validateSnapshot = ajv.compile(snapshotSchema);
export const hash = bytes => createHash('sha256').update(bytes).digest('hex');

export function songDocumentPath(input) {
  const fileName = basename(input);
  const name = basename(input, '.als');
  if (!fileName.endsWith('.als') || !name || name === '.' || name === '..' || name.includes('\\')) {
    throw new Error('Song name must be a non-empty .als basename, not a path component');
  }
  return join('songs', name, `${name}.json`);
}

function songSchemaReference(outputPath) {
  return relative(dirname(resolve(outputPath)), fileURLToPath(new URL('../schema/ableton-song-document.schema.json', import.meta.url)))
    .split(sep).join('/');
}

function validate(validator, document) {
  if (!validator(document)) throw new Error(`Invalid song document: ${ajv.errorsText(validator.errors)}`);
}

export function captureAls(bytes, fileName, capturedAt = new Date().toISOString(), outputPath) {
  const sha256 = hash(bytes);
  const document = {
    $schema: outputPath ? songSchemaReference(outputPath) : '../schema/ableton-song-document.schema.json',
    format: 'ableton-song-document',
    schema_version: '0.2.0',
    captured_at: capturedAt,
    source: {
      file_name: basename(fileName),
      sha256,
      archive_file: `${sha256}.als`,
    },
    coverage: {
      captured: [
        'Tempo and time signature; ordered tracks, devices, nested rack chains and chain mixers.',
        'Saved native manual parameter paths/values, macro values, MIDI notes and clip timing.',
        'External file references (not the files themselves).',
      ],
      not_captured: [
        'Automation, modulation, rack macro mappings and key/velocity/selector zones.',
        'Complete routing/group relationships, scene settings, clip launch/follow settings and grooves.',
        'Full audio-clip playback/warp state, sample assignments and opaque plugin/device state.',
        'Native-parameter to MCP/display-unit mappings and equivalent instruments in other DAWs.',
      ],
    },
    decisions: [],
    state: inspectAls(bytes),
  };
  validateSongDocument(document);
  return document;
}

export function validateSongDocument(document) {
  validate(validateSong, document);
  if (document.source.archive_file !== `${document.source.sha256}.als`) {
    throw new Error('Archive filename does not match the source checksum');
  }
  return document;
}

export function restoreBytes(document, archiveBytes) {
  let bytes;
  if (document.format === 'ableton-native-document') {
    validate(validateNative, document);
    if (document.source.gzip_base64.length > Math.ceil(MAX_ALS_BYTES / 3) * 4) {
      throw new Error('Native payload exceeds the input limit');
    }
    bytes = Buffer.from(document.source.gzip_base64, 'base64');
    if (bytes.toString('base64') !== document.source.gzip_base64) throw new Error('Invalid canonical base64 payload');
  } else {
    validateSongDocument(document);
    if (!archiveBytes) throw new Error('Archive restore requires the separate .als file; use rebuild-plan for JSON-only reconstruction');
    bytes = archiveBytes;
  }
  if (hash(bytes) !== document.source.sha256) throw new Error('Native payload checksum mismatch');
  const state = inspectAls(bytes);
  if (!isDeepStrictEqual(state, document.state)) {
    throw new Error('Song state differs from the archive. Archive restore cannot apply JSON edits; use rebuild-plan.');
  }
  return bytes;
}

export async function readInput(path) {
  if (path instanceof URL) path = fileURLToPath(path);
  const bytes = await readFile(path);
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    return { state: inspectAls(bytes), source: { file_name: basename(path), sha256: hash(bytes) } };
  }
  if (bytes.length > 128 * 1024 * 1024) throw new Error('JSON input exceeds 128 MiB');
  const document = JSON.parse(bytes.toString('utf8'));
  if (document.format === 'ableton-song-document') {
    validateSongDocument(document);
    return { state: document.state, source: { file_name: document.source.file_name, sha256: document.source.sha256 } };
  }
  if (document.format === 'ableton-native-document') {
    restoreBytes(document);
    return { state: document.state, source: { file_name: document.source.file_name, sha256: document.source.sha256 } };
  }
  validate(validateSnapshot, document);
  if (document.tracks.length !== document.session.track_count
    || document.return_tracks.length !== document.session.return_track_count
    || document.scenes.length !== document.session.scene_count) {
    throw new Error('Snapshot counts do not match its arrays');
  }
  return { state: document, source: { file_name: basename(path), sha256: hash(bytes) }, legacy: true };
}

export async function writeNewFile(path, bytes) {
  await mkdir(dirname(path), { recursive: true });
  const handle = await open(path, 'wx');
  try {
    await handle.writeFile(bytes);
  } finally {
    await handle.close();
  }
}

async function writeArchive(path, document, bytes) {
  restoreBytes(document, bytes);
  const archive = join(dirname(path), document.source.archive_file);
  try {
    await writeNewFile(archive, bytes);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    if (hash(await readFile(archive)) !== document.source.sha256) {
      throw new Error(`Existing archive checksum mismatch: ${archive}`);
    }
  }
}

export async function writeSongDocument(path, document, bytes) {
  document = { ...document, $schema: songSchemaReference(path) };
  await writeArchive(path, document, bytes);
  await writeNewFile(path, `${JSON.stringify(document, null, 2)}\n`);
}

export async function refreshNativeDocument(path, document, bytes) {
  document = { ...document, $schema: songSchemaReference(path) };
  try {
    const existing = JSON.parse(await readFile(path, 'utf8'));
    if (existing.format === 'ableton-native-document') {
      restoreBytes(existing);
    } else {
      validateSongDocument(existing);
      document.decisions = existing.decisions;
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await writeArchive(path, document, bytes);
  await replaceDocument(path, document);
}

export async function recordDecision(path, decision) {
  const document = validateSongDocument(JSON.parse(await readFile(path, 'utf8')));
  if (document.decisions.some(existing => existing.id === decision.id)) {
    throw new Error(`Decision already exists: ${decision.id}`);
  }
  document.decisions.push(decision);
  validateSongDocument(document);
  await replaceDocument(path, document);
}

async function replaceDocument(path, document) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, 'wx');
  let renamed = false;
  try {
    try {
      await handle.writeFile(`${JSON.stringify(document, null, 2)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
    renamed = true;
  } finally {
    if (!renamed) await unlink(temporary);
  }
}
