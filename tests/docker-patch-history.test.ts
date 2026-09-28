import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
const bash = process.platform === 'win32' ? 'D:/Program Files/Git/bin/bash.exe' : 'bash';
const shell = (file: string) => process.platform === 'win32' ? `/${file[0].toLowerCase()}${file.slice(2).replaceAll('\\', '/')}` : file;
const before = 'sha256:' + 'a'.repeat(64), after = 'sha256:' + 'b'.repeat(64);

test('Docker history verifies image/config, restores latest and recovers after failed rollback', { skip: process.platform === 'win32' && !fs.existsSync(bash) }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docker-patch-history-'));
  try {
    const base = path.join(dir, 'records'); const record = path.join(base, 'docker-fixture'); const bin = path.join(dir, 'bin');
    fs.mkdirSync(record, { recursive: true }); fs.mkdirSync(bin);
    const config = path.join(dir, 'compose.yml'); const current = path.join(dir, 'image');
    fs.writeFileSync(config, 'services: {}\n'); fs.writeFileSync(current, after);
    fs.writeFileSync(path.join(record, 'record.txt'), ['risuai', 'preset-switch', '2026-09-27T00:00:00Z', before, after, 'project', 'service', shell(dir), 'revision'].join('\n') + '\n');
    fs.writeFileSync(path.join(record, 'configs.txt'), shell(config) + '\n');
    fs.writeFileSync(path.join(record, 'config-hashes'), createHash('sha256').update(fs.readFileSync(config)).digest('hex') + '  ' + shell(config) + '\n');
    fs.writeFileSync(path.join(record, 'state'), 'deployed\n');
    fs.writeFileSync(path.join(record, 'patch-override.yml'), 'fixture');
    const runner = path.join(dir, 'history.sh');
    fs.writeFileSync(runner, fs.readFileSync('patches/risuai/remote/docker-history.sh', 'utf8').replace('base=/opt/cardloom-patch-backups', `base='${shell(base)}'`));
    fs.writeFileSync(path.join(bin, 'sleep'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
    fs.writeFileSync(path.join(bin, 'docker'), `#!/usr/bin/env bash
case "$1" in
  diff) if [[ $FAIL == drift ]]; then echo 'C /app/dist/assets/manual.js'; fi ;;
  inspect) if [[ $3 == '{{.Image}}' ]]; then cat "$CURRENT"; else echo running; fi ;;
  image) echo '${before}' ;;
  compose)
    if [[ "$*" == *rollback.yml* ]]; then
      [[ $FAIL == rollback || $FAIL == both ]] && exit 1
      printf '%s' '${before}' > "$CURRENT"
    else
      [[ $FAIL == both ]] && exit 1
      printf '%s' '${after}' > "$CURRENT"
    fi ;;
  *) exit 2 ;;
esac
`, { mode: 0o755 });
    const run = (mode: string, fail = '') => spawnSync(bash, [shell(runner), mode, 'risuai', 'docker-fixture', after], { encoding: 'utf8', env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, CURRENT: shell(current), FAIL: fail } });
    const history = run('history'); assert.equal(history.status, 0, history.stderr); assert.match(history.stdout, /\ttrue/);
    assert.notEqual(run('remove', 'drift').status, 0);
    fs.appendFileSync(config, '# drift');
    assert.notEqual(run('remove').status, 0);
    assert.equal(fs.readFileSync(current, 'utf8'), after);
    fs.writeFileSync(config, 'services: {}\n');
    const failed = run('remove', 'rollback'); assert.notEqual(failed.status, 0); assert.match(failed.stderr, /patched image restored and verified/);
    assert.equal(fs.readFileSync(current, 'utf8'), after);
    const removed = run('remove'); assert.equal(removed.status, 0, removed.stderr); assert.match(removed.stdout, /"removed":true/);
    assert.equal(fs.readFileSync(current, 'utf8'), before);
    assert.notEqual(run('remove').status, 0);
    fs.writeFileSync(current, after); fs.writeFileSync(path.join(record, 'state'), 'deployed\n');
    const broken = run('remove', 'both'); assert.notEqual(broken.status, 0); assert.match(broken.stderr, /manual recovery required/);
    assert.match(fs.readFileSync(path.join(record, 'state'), 'utf8'), /recovery-required/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
