export function validateUploadedImage(bytes: Buffer): { bytes: Buffer; mimeType: string } {
  let mimeType = '';
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) mimeType = 'image/png';
  else if (bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) mimeType = 'image/jpeg';
  else if (bytes.length >= 20 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') mimeType = 'image/webp';
  else if (bytes.length >= 13 && /^GIF8[79]a$/u.test(bytes.toString('ascii', 0, 6))) mimeType = 'image/gif';
  if (!mimeType) throw new Error('请选择有效的 PNG、JPEG、WebP 或 GIF 图片。');
  return { bytes, mimeType };
}
