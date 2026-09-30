import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
// Workers may chdir to disposable databases; keep the TS/JSX configuration absolute.
const child = spawn(process.execPath, [
  fileURLToPath(new URL('node_modules/tsx/dist/cli.mjs', root)),
  '--tsconfig', fileURLToPath(new URL('tsconfig.web.json', root)),
  '--test', ...process.argv.slice(2), 'tests/**/*.test.ts',
], { cwd: fileURLToPath(root), stdio: 'inherit' });
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
