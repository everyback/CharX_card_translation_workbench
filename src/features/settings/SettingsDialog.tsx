import { Save, X } from 'lucide-react';
import { useState } from 'react';
import type { Settings } from '../../types';

export function SettingsDialog({ settings, onClose, onSave }: { settings: Settings; onClose: () => void; onSave: (value: Settings) => Promise<void> }) {
  const [value, setValue] = useState({ ...settings, apiKey: '', imageApiKey: '' as string });
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <div className="dialog-header"><div><h2 id="settings-title">模型与调度</h2><span>{settings.apiKeyConfigured ? 'API Key 已配置' : 'API Key 未配置'}</span></div><button className="icon-button" onClick={onClose}><X size={18} /></button></div>
        <div className="settings-grid">
          <label><span>API Base URL / 完整接口</span><input value={value.apiBaseUrl} onChange={(event) => setValue({ ...value, apiBaseUrl: event.target.value })} placeholder="https://example.com/v1 或完整 /chat/completions 地址" /></label>
          <label><span>模型名称</span><input value={value.model} onChange={(event) => setValue({ ...value, model: event.target.value })} placeholder="例如 gpt-4.1-mini" /></label>
          <label className="wide"><span>API Key</span><input type="password" value={value.apiKey} onChange={(event) => setValue({ ...value, apiKey: event.target.value })} placeholder={settings.apiKeyConfigured ? '留空则保持现有密钥' : '输入模型 API Key'} /></label>
          <label className="wide settings-section-label"><span>图片编辑模型</span><small>用于资源页“AI 图片汉化”，采用 OpenAI 兼容的 multipart 图片编辑接口，与文本翻译配置相互独立。</small></label>
          <label><span>图片编辑 API 完整地址</span><input value={value.imageApiUrl} onChange={(event) => setValue({ ...value, imageApiUrl: event.target.value })} placeholder="https://api.openai.com/v1/images/edits" /></label>
          <label><span>图片编辑模型</span><input value={value.imageModel} onChange={(event) => setValue({ ...value, imageModel: event.target.value })} placeholder="例如 gpt-image-1" /></label>
          <label className="wide"><span>图片编辑 API Key</span><input type="password" value={value.imageApiKey} onChange={(event) => setValue({ ...value, imageApiKey: event.target.value })} placeholder={settings.imageApiKeyConfigured ? '留空则保持现有密钥' : '输入图片编辑 API Key'} /></label>
          <label><span>源语言</span><input value={value.sourceLanguage} onChange={(event) => setValue({ ...value, sourceLanguage: event.target.value })} placeholder="auto" /></label>
          <label><span>备用语言</span><input value={value.fallbackLanguage} onChange={(event) => setValue({ ...value, fallbackLanguage: event.target.value })} placeholder="en" /></label>
          <label><span>目标语言</span><input value={value.targetLanguage} onChange={(event) => setValue({ ...value, targetLanguage: event.target.value })} placeholder="zh-CN" /></label>
          <label className="wide"><span>卡片语言设定</span><select value={value.languageBehaviorMode} onChange={(event) => setValue({ ...value, languageBehaviorMode: event.target.value as 'target' | 'preserve' })}><option value="target">跟随目标语言（推荐）</option><option value="preserve">保留卡片原设定</option></select><small>处理卡片中“使用韩语思考 / 用韩文交流 / written in Korean”等语言设定；代码、变量、正则、协议参数和触发关键词仍受保护。</small></label>
          <label><span>模型请求并发</span><input type="number" min="1" step="1" value={value.concurrency} onChange={(event) => setValue({ ...value, concurrency: Number(event.target.value) })} /></label>
          <label><span>每批段落</span><input type="number" min="1" step="1" value={value.batchItems} onChange={(event) => setValue({ ...value, batchItems: Number(event.target.value) })} /></label>
          <label><span>每批字符</span><input type="number" min="1000" step="500" value={value.batchChars} onChange={(event) => setValue({ ...value, batchChars: Number(event.target.value) })} /></label>
        </div>
        <div className="dialog-actions"><button className="secondary-button" onClick={onClose}>取消</button><button className="primary-button" onClick={() => void onSave(value)}><Save size={16} />保存设置</button></div>
      </div>
    </div>
  );
}
