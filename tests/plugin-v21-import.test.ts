import assert from 'node:assert/strict';
import test from 'node:test';
import { patchPluginV21Import } from '../patches/risuai/scripts/patch-plugin-v21-import.mjs';

const rejection = `        if(apiVersion === '2.1'){
            showError('Your plugin specifies API version 2.1, which is outdated and no longer supported. Please update your plugin to use at least API version 3.0.')
            return
        }`;
const native = `        if(apiVersion === '2.1'){
            const safety = await checkCodeSafety(jsFile)
            if(!safety.isSafe){
                pluginAlertModalStore.errors = safety.errors
                pluginAlertModalStore.open = true

                //I can use event but lazy
                while(pluginAlertModalStore.open){
                    await sleep(100)
                }

                if(pluginAlertModalStore.errors.length > 0){
                    return
                }
            }
            apiInternalVersion = '2.1'
        }`;
const fixture = (branch: string) => `import { checkCodeSafety } from './safety';
import { pluginAlertModalStore } from './stores';
async function install() {
${branch}
        else if(apiVersion === '2.0'){ return }
        else if(apiVersion === '3.0'){ apiInternalVersion = '3.0' }
        if(apiInternalVersion !== '3.0' && argu.isHotReload){ return }
}`;

test('API 2.1 native checked import is unchanged, including CRLF', () => {
  for (const input of [fixture(native), fixture(native).replaceAll('\n', '\r\n')]) {
    assert.equal(patchPluginV21Import(input), input);
  }
});

test('API 2.1 rejection is restored and reapplication is idempotent', () => {
  const result = patchPluginV21Import(fixture(rejection));
  assert.match(result, /codex: restore checked API 2.1 imports/);
  assert.match(result, /await checkCodeSafety\(jsFile\)/);
  assert.equal(patchPluginV21Import(result), result);
});

test('API 2.1 unknown, unsafe, duplicate and incomplete implementations remain rejected', () => {
  for (const input of [
    fixture(native.replace('await checkCodeSafety(jsFile)', '{ isSafe: true }')),
    fixture(native.replace('                    return', '                    continue')),
    fixture(native + '\n' + native),
    fixture(native).replace('import { checkCodeSafety }', 'import { other }'),
    fixture(native.replace("apiInternalVersion = '2.1'", "apiInternalVersion = '3.0'")),
    fixture(rejection).replace('no longer supported.', 'not supported.'),
  ]) assert.throws(() => patchPluginV21Import(input));
});
