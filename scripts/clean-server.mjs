import { rm } from 'node:fs/promises';

// TypeScript does not remove output for deleted source files.
await rm(new URL('../dist-server/', import.meta.url), { recursive: true, force: true });
