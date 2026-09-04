export interface Settings {
  apiBaseUrl: string;
  apiKeyConfigured: boolean;
  model: string;
  streamingEnabled: boolean;
  sourceLanguage: string;
  fallbackLanguage: string;
  targetLanguage: string;
  languageBehaviorMode: 'target' | 'preserve';
  concurrency: number;
  batchItems: number;
  batchChars: number;
  requestTimeoutSeconds: number;
  imageApiUrl: string;
  imageApiKeyConfigured: boolean;
  imageModel: string;
}
