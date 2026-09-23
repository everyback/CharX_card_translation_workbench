declare module 'png-chunks-extract' {
  export interface PngChunk {
    name: string;
    data: Uint8Array;
  }
  export default function extract(data: Uint8Array): PngChunk[];
}

declare module 'png-chunks-encode' {
  import type { PngChunk } from 'png-chunks-extract';
  export default function encode(chunks: PngChunk[]): Uint8Array;
}

declare module 'png-chunk-text' {
  import type { PngChunk } from 'png-chunks-extract';
  const textChunk: {
    encode(keyword: string, text: string): PngChunk;
    decode(data: Uint8Array): { keyword: string; text: string };
  };
  export default textChunk;
}

/**
 * RisuAI bundles msgpackr's `index-no-eval` entry (it avoids `eval` for CSP).
 * The package ships types only for its main entry, so declare the subpath here
 * and keep using the exact same module RisuAI does.
 */
declare module 'msgpackr/index-no-eval' {
  export interface MsgpackOptions {
    useRecords?: boolean;
    mapsAsObjects?: boolean;
    variableMapSize?: boolean;
    structuredClone?: boolean;
  }
  export function encode(value: unknown, options?: MsgpackOptions): Buffer;
  export function decode(input: Uint8Array, options?: MsgpackOptions): unknown;
  export function pack(value: unknown, options?: MsgpackOptions): Buffer;
  export function unpack(input: Uint8Array, options?: MsgpackOptions): unknown;
}
