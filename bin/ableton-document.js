import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import { resolve, extname, dirname, join } from 'node:path';
import { captureAls, restoreBytes, writeNewFile, writeSongDocument, refreshNativeDocument, songDocumentPath, recordDecision, validateSongDocument } from '../src/documents.js';
import { buildRebuildPlan } from '../src/rebuild.js';

const usage = `Usage:
  npm run ableton -- capture input.als --out document.json
  npm run ableton -- refresh input.als [--out document.json]
  npm run ableton -- restore document.json --out restored.als
  npm run ableton -- rebuild-plan document.json --out plan.json
  npm run ableton -- decision document.json --id ID --scope SCOPE --intent WHY --implementation HOW [--verification RESULT]

Capture/restore/plan outputs must not exist. Capture/refresh store the original ALS
separately as <sha256>.als beside the JSON. Refresh preserves recorded decisions.
Refresh defaults to songs/<ALS basename>/<ALS basename>.json and preserves sibling assets.
Restore copies the separate archive, not JSON edits. Rebuild-plan uses JSON alone,
emitting MCP calls plus explicit manual steps and missing-data warnings. It does NOT execute them.`;

try {
  const { values, positionals } = parseArgs({
    options: {
      out: { type: 'string' }, help: { type: 'boolean' },
      id: { type: 'string' }, scope: { type: 'string' }, intent: { type: 'string' },
      implementation: { type: 'string' }, verification: { type: 'string' },
    },
    allowPositionals: true,
  });
  if (values.help) {
    console.log(usage);
  } else {
    const [command, input] = positionals;
    const output = values.out ?? (command === 'refresh' && input ? songDocumentPath(input) : undefined);
    if (command === 'decision') {
      if (!input || positionals.length !== 2 || values.out) throw new Error(usage);
      const decision = Object.fromEntries(['id', 'scope', 'intent', 'implementation', 'verification']
        .filter(key => values[key] !== undefined).map(key => [key, values[key]]));
      await recordDecision(input, decision);
      console.log(`Recorded decision ${decision.id} in ${input}.`);
    } else {
      if (!['capture', 'refresh', 'restore', 'rebuild-plan'].includes(command) || !input || positionals.length !== 2 || !output) throw new Error(usage);
      if (resolve(input) === resolve(output)) throw new Error('Input and output must be different');
      if (extname(output).toLowerCase() !== (command === 'restore' ? '.als' : '.json')) throw new Error('Incorrect output extension');
      const source = await readFile(input);
      if (command === 'refresh') {
        await refreshNativeDocument(output, captureAls(source, input), source);
      } else if (command === 'capture') {
        await writeSongDocument(output, captureAls(source, input, undefined, output), source);
      } else if (command === 'rebuild-plan') {
        const plan = buildRebuildPlan(JSON.parse(source.toString('utf8')));
        await writeNewFile(output, `${JSON.stringify(plan, null, 2)}\n`);
        console.error(`Plan only: ${plan.steps.filter(step => step.kind !== 'mcp').length} manual/missing-data steps; no Live changes made.`);
      } else {
        const document = JSON.parse(source.toString('utf8'));
        const archive = document.format === 'ableton-song-document'
          ? await readFile(join(dirname(input), validateSongDocument(document).source.archive_file))
          : undefined;
        await writeNewFile(output, restoreBytes(document, archive));
      }
      console.log(`Wrote ${output}.`);
    }
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
