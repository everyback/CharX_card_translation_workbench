import { rm } from 'node:fs/promises';

await rm('dist-electron', { recursive: true, force: true });
