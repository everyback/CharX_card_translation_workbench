export interface ImageEditSettings {
  apiUrl: string;
  apiKey: string;
  model: string;
}

export interface EditedImage {
  bytes: Buffer;
  mimeType: string;
}

const IMAGE_EDIT_TIMEOUT_MS = 180_000;

export async function editImageText(
  source: Uint8Array,
  sourceMimeType: string,
  targetLanguage: string,
  settings: ImageEditSettings,
): Promise<EditedImage> {
  if (!settings.apiUrl || !/^https?:\/\//iu.test(settings.apiUrl)) throw new Error('尚未配置有效的图片编辑 API 地址。');
  if (!settings.apiKey) throw new Error('尚未配置图片编辑 API Key。');
  if (!settings.model) throw new Error('尚未配置图片编辑模型。');

  const prompt = [
    `将图片内所有可见文字翻译并替换为 ${targetLanguage}。`,
    '严格保持原图构图、人物、背景、颜色、尺寸、图标和非文字细节不变。',
    '只重绘文字所在区域，保留原有排版层级、字号、字体风格、描边、阴影和对齐方式。',
    '不要增加解释、标注、水印或原文对照；无法辨认的文字保持原样。',
  ].join('\n');
  const form = new FormData();
  form.set('model', settings.model);
  form.set('prompt', prompt);
  const sourceBytes = Uint8Array.from(source);
  form.set('image', new Blob([sourceBytes.buffer], { type: sourceMimeType }), `source.${extensionForMime(sourceMimeType)}`);
  form.set('response_format', 'b64_json');

  const response = await fetch(settings.apiUrl, {
    method: 'POST',
    headers: { Authorization: `Bearer ${settings.apiKey}` },
    body: form,
    signal: AbortSignal.timeout(IMAGE_EDIT_TIMEOUT_MS),
  });
  if (!response.ok) {
    const body = (await response.text()).slice(0, 1_000);
    throw new Error(`图片编辑接口 ${response.status}：${body || response.statusText}`);
  }
  const payload = await response.json() as Record<string, unknown>;
  const first = Array.isArray(payload.data) && payload.data[0] && typeof payload.data[0] === 'object'
    ? payload.data[0] as Record<string, unknown>
    : payload;
  const base64 = typeof first.b64_json === 'string' ? first.b64_json : typeof first.image === 'string' ? first.image : '';
  if (base64) {
    const normalized = base64.replace(/^data:[^;]+;base64,/u, '');
    const bytes = Buffer.from(normalized, 'base64');
    if (!bytes.length) throw new Error('图片编辑接口返回了空图片。');
    return { bytes, mimeType: detectImageMime(bytes) ?? sourceMimeType };
  }
  const url = typeof first.url === 'string' ? first.url : '';
  if (!url) throw new Error('图片编辑接口没有返回 b64_json、image 或 url。');
  const imageResponse = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!imageResponse.ok) throw new Error(`无法下载图片编辑结果：${imageResponse.status}。`);
  const bytes = Buffer.from(await imageResponse.arrayBuffer());
  return { bytes, mimeType: imageResponse.headers.get('content-type')?.split(';')[0] || detectImageMime(bytes) || sourceMimeType };
}

function extensionForMime(mimeType: string): string {
  if (mimeType === 'image/jpeg') return 'jpg';
  if (mimeType === 'image/webp') return 'webp';
  if (mimeType === 'image/gif') return 'gif';
  return 'png';
}

function detectImageMime(bytes: Uint8Array): string | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 12 && Buffer.from(bytes.subarray(0, 4)).toString('ascii') === 'RIFF' && Buffer.from(bytes.subarray(8, 12)).toString('ascii') === 'WEBP') return 'image/webp';
  return null;
}
