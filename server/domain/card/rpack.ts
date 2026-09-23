// RPack byte-substitution table from RisuAI. See THIRD_PARTY_NOTICES.md.
// Shared by the RISUM module container and the .risup preset container so the
// two copies can never drift apart.
const RPACK_MAP = Buffer.from(
  'xA0eC70rP1X8RW71ZlNPGuC7MJSGumu/QVBvm+/etxBhFyDfMomonW2ryZAADF2v0sFW5RZkkYJldJfKI9ZS0f+0oOgvilg4WmAZlknb18g7PkNLpWNHqmopkvQVz2I0eNMdPOIFjipXDhvNTC3yQCwleUgPsnq1p2w35px7VH7+h9yaAuQzouuxLgPdmaaw59WIGIN89r7hXJ/DIUYfCE7QdhJf7v2PROqjXosoCTWeacwKx4UHrUrzd+ln1NqEgJO2TXP6JyZ/BMb78XI5UcI2qWis+O3FucvOdaQ9gdlCcByVEbzYjJj5WaET9xR9s+xxwOON8AGuWzEGJCI6uCz3hIvJZfu2n66zAy0BaXQf5KPs7lw0IZNKD2riYgKeIpz9PPxxx8atWWcFcG2KRBL6JIZfr9F6R87+UGPdUQZvGOBSqAmdVnNMuFNsw6AOGc8+DX4HMmhG6kj5mS6rpEkgXlU1OAy807FYFnkoChrh8s3EOduiumBydn2V73/IwN43lL+1FIGSJUWs5/Vmpys2WsET40s66I2DG3wnsJpC64eq3FSOeCbSVynUt/gvj4l18EF3wh7/2BUR5QSXF/Mx0JsA18q0Tyo72bJr2l2hPzBhvZE9Tubfvk2CjB0jEJhk9IUze5BDu6mI8dalHPbMbrlbC5bt1enFywimgEA=',
  'base64',
);

if (RPACK_MAP.length !== 512) throw new Error('内置 RPack 映射无效。');

const ENCODE_MAP = RPACK_MAP.subarray(0, 256);
const DECODE_MAP = RPACK_MAP.subarray(256);

/** Apply the RPack substitution table used by RisuAI containers. */
export function encodeRpack(data: Uint8Array): Buffer {
  return transform(data, ENCODE_MAP);
}

/** Reverse the RPack substitution table used by RisuAI containers. */
export function decodeRpack(data: Uint8Array): Buffer {
  return transform(data, DECODE_MAP);
}

function transform(source: Uint8Array, map: Uint8Array): Buffer {
  const output = Buffer.allocUnsafe(source.length);
  for (let index = 0; index < source.length; index += 1) output[index] = map[source[index]];
  return output;
}