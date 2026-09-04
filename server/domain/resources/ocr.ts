import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { createWorker } from 'tesseract.js';
import { workbenchConfig } from '../../../config/workbench.js';

export interface OcrCandidateResult {
  text: string;
  confidence: number | null;
  engine: string;
  language: string;
}

export type OcrLanguage = 'auto' | 'zh-CN' | 'ko' | 'ja' | 'en';

const LANGUAGE_MODELS: Record<OcrLanguage, string> = {
  auto: 'eng+chi_sim',
  'zh-CN': 'chi_sim+eng',
  ko: 'kor+eng',
  ja: 'jpn+eng',
  en: 'eng',
};

const workerPromises = new Map<string, Promise<Awaited<ReturnType<typeof createWorker>>>>();
const OCR_TIMEOUT_MS = 90_000;
const ocrCachePath = workbenchConfig.paths.ocrCache;
const tesseractPackagePath = path.join(workbenchConfig.paths.nodeModulesRoot, 'tesseract.js');
const tesseractCorePath = path.join(workbenchConfig.paths.nodeModulesRoot, 'tesseract.js-core');
mkdirSync(ocrCachePath, { recursive: true });

/**
 * OCR is deliberately isolated from card mutation. It only returns a text
 * candidate; callers decide whether it should be edited or confirmed.
 */
export async function recognizeImage(bytes: Uint8Array, sourcePath: string, requestedLanguage: OcrLanguage = 'auto'): Promise<OcrCandidateResult> {
  if (!bytes.length) throw new Error('图片内容为空，无法进行 OCR。');
  const language = LANGUAGE_MODELS[requestedLanguage] ?? LANGUAGE_MODELS.auto;
  const worker = await withTimeout(getWorker(language), OCR_TIMEOUT_MS, () => {
    workerPromises.delete(language);
  });
  try {
    const result = await withTimeout(worker.recognize(Buffer.from(bytes)), OCR_TIMEOUT_MS, () => {
      workerPromises.delete(language);
      void worker.terminate();
    });
    const text = result.data.text.replace(/\r\n?/gu, '\n').trim();
    const confidence = Number.isFinite(result.data.confidence) ? Number(result.data.confidence) : null;
    return {
      text,
      confidence,
      engine: `Tesseract.js ${language}`,
      language,
    };
  } catch (error) {
    // A failed worker cannot be safely reused; the next request gets a fresh one.
    workerPromises.delete(language);
    throw new Error(`OCR 识别失败（${path.basename(sourcePath)}）：${error instanceof Error ? error.message : String(error)}`);
  }
}

async function getWorker(language: string) {
  let workerPromise = workerPromises.get(language);
  if (!workerPromise) {
    workerPromise = createWorker(language, 1, {
      logger: () => undefined,
      cachePath: ocrCachePath,
      langPath: ocrCachePath,
      corePath: tesseractCorePath,
      workerPath: path.join(tesseractPackagePath, 'src', 'worker-script', 'node', 'index.js'),
      gzip: false,
    });
    workerPromises.set(language, workerPromise);
  }
  return workerPromise;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, onTimeout: () => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      onTimeout();
      reject(new Error(`OCR 初始化或识别超过 ${Math.round(timeoutMs / 1000)} 秒。请稍后重试，或先选择更具体的识别语言。`));
    }, timeoutMs);
    promise.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
  });
}
