import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const marker = '// codex: restore checked API 2.1 imports';
const blocked = `        if(apiVersion === '2.1'){
            showError('Your plugin specifies API version 2.1, which is outdated and no longer supported. Please update your plugin to use at least API version 3.0.')
            return
        }`;
const restored = `        if(apiVersion === '2.1'){
            ${marker}
            const safety = await checkCodeSafety(jsFile)
            if(!safety.isSafe){
                pluginAlertModalStore.errors = safety.errors
                pluginAlertModalStore.open = true
                while(pluginAlertModalStore.open){
                    await sleep(100)
                }
                if(pluginAlertModalStore.errors.length > 0){
                    return
                }
            }
            apiInternalVersion = '2.1'
        }`;

export function patchPluginV21Import(input) {
  const source = input.replace(/\r\n/g, '\n');
  if (source.includes(marker)) {
    if (source.split(restored).length !== 2 || source.includes(blocked)) {
      throw new Error('Incomplete or ambiguous existing API 2.1 patch');
    }
    return input;
  }
  for (const anchor of [
    'import { checkCodeSafety }',
    'pluginAlertModalStore',
    "else if(apiVersion === '2.0')",
    "else if(apiVersion === '3.0')",
    "if(apiInternalVersion !== '3.0' && argu.isHotReload)",
  ]) {
    if (!source.includes(anchor)) throw new Error(`Missing required upstream anchor: ${anchor}`);
  }
  // The older upstream implementation already has the complete checked import path.
  // Ignore only blank lines, indentation and its known comment, not arbitrary code.
  const normalizeLines = (text) => text.split('\n').map((line) => line.trim())
    .filter((line) => line && line !== '//I can use event but lazy').join('\n');
  const start = "if(apiVersion === '2.1'){";
  const end = "else if(apiVersion === '2.0')";
  if (source.split(start).length === 2 && source.split(end).length === 2) {
    const branch = source.slice(source.indexOf(start), source.indexOf(end));
    const native = restored.replace(marker, '');
    if (normalizeLines(branch) === normalizeLines(native)) return input;
  }
  if (source.split(blocked).length !== 2) {
    throw new Error('API 2.1 source is neither the supported rejection nor the verified native checked import implementation; no files changed');
  }
  const output = source.replace(blocked, restored);
  return input.includes('\r\n') ? output.replace(/\n/g, '\r\n') : output;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [inputPath, outputPath] = process.argv.slice(2);
  if (!inputPath || !outputPath || path.resolve(inputPath) === path.resolve(outputPath)) {
    throw new Error('usage: node patch-plugin-v21-import.mjs <original plugins.svelte.ts> <new output.ts> (distinct paths)');
  }
  const input = fs.readFileSync(inputPath, 'utf8');
  const output = patchPluginV21Import(input);
  fs.writeFileSync(outputPath, output, { flag: 'wx' });
  console.log(output === input ? 'Already patched; copied unchanged.' : 'Restored checked API 2.1 imports. Rebuild frontend before deployment.');
}
