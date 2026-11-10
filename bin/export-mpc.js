import { parseArgs } from 'node:util';
import { readInput } from '../src/documents.js';
import { writeMpcExport } from '../src/mpc.js';

const usage = `Usage:
  npm run mpc -- input.als --out output/mpc [--view session|arrangement|both]
  npm run mpc -- document.json --out output/mpc [--flatten-expression]

Accepts .als, song JSON (without its archive), legacy native JSON, or MCP snapshots.
Writes standard MIDI and manifest.json to a new directory. No instruments/media are copied.`;

try {
  const { values, positionals } = parseArgs({
    options: {
      out: { type: 'string' }, view: { type: 'string', default: 'both' },
      'flatten-expression': { type: 'boolean', default: false }, help: { type: 'boolean' },
    },
    allowPositionals: true,
  });
  if (values.help) {
    console.log(usage);
  } else {
    if (positionals.length !== 1 || !values.out) throw new Error(usage);
    const input = await readInput(positionals[0]);
    const manifest = await writeMpcExport(input, values.out, { view: values.view, flattenExpression: values['flatten-expression'] });
    console.log(`Wrote ${manifest.files.length} MIDI files and ${values.out}/manifest.json`);
    for (const warning of manifest.warnings) console.error(`Warning: ${warning}`);
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
