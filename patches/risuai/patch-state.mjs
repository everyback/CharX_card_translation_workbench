#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectState, removeEntry } from './scripts/state-store.mjs';

try {
  const [command, ...argv] = process.argv.slice(2);
  const input = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!['--manifest', '--root', '--id'].includes(argv[i]) || !argv[i + 1]) throw new Error('Invalid state arguments');
    input[argv[i].slice(2)] = argv[i + 1];
  }
  if (!path.isAbsolute(input.manifest || '') || !path.isAbsolute(input.root || '')) throw new Error('Explicit absolute --manifest and --root are required');
  const scriptDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'scripts');
  if (command === 'status') console.log('STATE\t' + JSON.stringify(inspectState(input.manifest, input.root, scriptDir)));
  else if (command === 'remove' && input.id) console.log('STATE\t' + JSON.stringify(removeEntry(input.manifest, input.root, input.id, scriptDir)));
  else throw new Error('Use status or remove --id RECORD_ID');
} catch (error) { console.error(error.message); process.exitCode = 1; }
