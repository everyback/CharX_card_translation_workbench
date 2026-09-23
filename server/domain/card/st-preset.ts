/**
 * Public entry point for SillyTavern preset support.
 *
 * The implementation lives in `st-preset-convert.ts`; this module keeps a stable
 * import path for callers while the detection helper stays close to the
 * conversion logic it guards.
 */
export {
  analyzeStPreset,
  convertStPreset,
  isSillyTavernPreset,
  normalizeStRole,
  readStPresetBlocks,
  readStPresetPrompts,
  type StPresetAnalysis,
  type StPresetBlock,
  type StPresetConversion,
  type StPresetConversionOptions,
  type StPresetConversionReport,
  type StPresetEmittedPrompt,
  type StPresetPrompt,
} from './st-preset-convert.js';
