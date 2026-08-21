import { Braces, Check, CircleAlert, LoaderCircle, RefreshCw, Search, ShieldCheck, Sparkles, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { ProtocolFieldRule, ProtocolSchema, ProtocolStatus } from '../../types';

const PROTOCOL_STATUS_LABELS: Record<ProtocolStatus, string> = {
  pending: '待判断',
  analyzed: '模型已判断',
  approved: '已采用',
  ignored: '已忽略',
};

const PROTOCOL_SOURCE_LABELS: Record<ProtocolSchema['source'], string> = {
  local: '卡片样本',
  'regex-lua': 'Risu 正则 + Lua',
  model: '模型判断',
  manual: '人工规则',
};

export function ProtocolsView({
  protocols,
  busy,
  onDiscover,
  onAnalyze,
  onSave,
  onApproveHighConfidence,
}: {
  protocols: ProtocolSchema[];
  busy: boolean;
  onDiscover: () => void;
  onAnalyze: (schemaIds: string[]) => void;
  onSave: (schemaId: string, status: ProtocolStatus, fields: ProtocolFieldRule[]) => void;
  onApproveHighConfidence: (schemaIds: string[]) => void;
}) {
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<'all' | ProtocolStatus>('all');
  const [selectedId, setSelectedId] = useState('');
  const [draftFields, setDraftFields] = useState<ProtocolFieldRule[]>([]);
  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return protocols.filter((protocol) => (
      (status === 'all' || protocol.status === status)
      && (!normalized || [
        protocol.name,
        protocol.declaration,
        protocol.signature,
        ...protocol.examples,
        ...protocol.fieldRules.flatMap((field) => [field.role, field.reason]),
      ].some((value) => value.toLowerCase().includes(normalized)))
    ));
  }, [protocols, query, status]);
  const selected = protocols.find((protocol) => protocol.id === selectedId) ?? null;
  useEffect(() => {
    if (!selectedId || !filtered.some((protocol) => protocol.id === selectedId)) {
      setSelectedId(filtered[0]?.id ?? '');
    }
  }, [filtered, selectedId]);
  useEffect(() => {
    setDraftFields(selected?.fieldRules.map((field) => ({ ...field })) ?? []);
  }, [selected?.id, selected?.fieldRules]);

  const updateDraftField = (index: number, changes: Partial<ProtocolFieldRule>) => {
    setDraftFields((current) => current.map((field) => field.index === index ? { ...field, ...changes } : field));
  };
  const visibleAnalyzable = filtered.filter((protocol) => (
    protocol.status === 'pending' || protocol.status === 'analyzed'
  ));
  const highConfidence = filtered.filter((protocol) => (
    protocol.source === 'model'
    && protocol.status === 'analyzed'
    && protocol.confidence >= 0.9
    && protocol.fieldRules.every((field) => field.policy !== 'manual')
  ));

  return (
    <section className="protocol-section">
      <div className="protocol-toolbar">
        <div className="search-input">
          <Search size={15} />
          <input aria-label="搜索协议" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="协议名、槽位或样本" />
        </div>
        <select aria-label="协议状态" value={status} onChange={(event) => setStatus(event.target.value as 'all' | ProtocolStatus)}>
          <option value="all">全部状态</option>
          <option value="pending">待判断</option>
          <option value="analyzed">模型已判断</option>
          <option value="approved">已采用</option>
          <option value="ignored">已忽略</option>
        </select>
        <button className="secondary-button" disabled={busy} onClick={onDiscover}>
          {busy ? <LoaderCircle className="spin" size={16} /> : <RefreshCw size={16} />}重新发现
        </button>
        <button className="primary-button" disabled={busy || visibleAnalyzable.length === 0} onClick={() => onAnalyze(visibleAnalyzable.map((protocol) => protocol.id))}>
          <Sparkles size={16} />模型识别（{visibleAnalyzable.length}）
        </button>
        <button className="secondary-button" disabled={busy || highConfidence.length === 0} onClick={() => onApproveHighConfidence(highConfidence.map((protocol) => protocol.id))}>
          <ShieldCheck size={16} />采用高置信度（{highConfidence.length}）
        </button>
        <span className="result-count">{filtered.length} 种</span>
      </div>

      <div className="protocol-layout">
        <aside className="protocol-list">
          {filtered.map((protocol) => (
            <button key={protocol.id} className={selected?.id === protocol.id ? 'active' : ''} onClick={() => setSelectedId(protocol.id)}>
              <Braces size={17} />
              <span>
                <strong>{protocol.opener}{protocol.name}{protocol.delimiter}…{protocol.closer}</strong>
                <small>{protocol.occurrenceCount} 个实例 · {protocol.fieldCount} 个槽位</small>
              </span>
              <b className={`protocol-status protocol-status-${protocol.status}`}>{PROTOCOL_STATUS_LABELS[protocol.status]}</b>
            </button>
          ))}
          {!filtered.length && <div className="table-empty">没有符合条件的协议</div>}
        </aside>

        <div className="protocol-editor">
          {selected ? <>
            <header className="protocol-editor-header">
              <div>
                <span>结构指纹 {selected.signature} · {PROTOCOL_SOURCE_LABELS[selected.source]}</span>
                <h2>{selected.opener}{selected.name}{selected.delimiter}{draftFields.map((field) => field.role).join(selected.delimiter)}{selected.closer}</h2>
              </div>
              <div>
                <span className={`protocol-status protocol-status-${selected.status}`}>{PROTOCOL_STATUS_LABELS[selected.status]}</span>
                <strong>{Math.round(selected.confidence * 100)}%</strong>
              </div>
            </header>

            {selected.lastError && <div className="translation-error-banner"><CircleAlert size={16} /><div><strong>模型识别失败</strong><span>{selected.lastError}</span></div></div>}
            {selected.declaration && (
              <div className="protocol-declaration">
                <span>{selected.declaration.startsWith('Risu 正则') ? '正则 / Lua 依据' : '卡内格式声明'}</span>
                <code>{selected.declaration}</code>
              </div>
            )}

            <div className="protocol-field-table">
              <div className="protocol-field-head"><span>槽位</span><span>用途</span><span>处理方式</span><span>置信度</span><span>判断依据</span></div>
              {draftFields.map((field) => (
                <div className="protocol-field-row" key={field.index}>
                  <strong>{field.index}</strong>
                  <input aria-label={`槽位 ${field.index} 用途`} value={field.role} disabled={field.hardProtected} onChange={(event) => updateDraftField(field.index, { role: event.target.value })} />
                  <select aria-label={`槽位 ${field.index} 处理方式`} value={field.policy} disabled={field.hardProtected} onChange={(event) => updateDraftField(field.index, { policy: event.target.value as ProtocolFieldRule['policy'] })}>
                    <option value="translate">翻译</option>
                    <option value="protect">保护</option>
                    <option value="manual">待确认</option>
                  </select>
                  <span>{Math.round(field.confidence * 100)}%</span>
                  <span>{field.hardProtected && <ShieldCheck size={14} />}{field.reason}</span>
                </div>
              ))}
            </div>

            <div className="protocol-samples">
              <div><strong>实例样本</strong><span>模型按协议类型分析，不会逐条调用</span></div>
              {selected.occurrences.filter((occurrence) => !occurrence.isDeclaration).slice(0, 5).map((occurrence, index) => (
                <div key={`${occurrence.pathLabel}:${occurrence.start}`}>
                  <span>{occurrence.pathLabel} · #{index + 1}</span>
                  <code>{occurrence.rawPreview}</code>
                </div>
              ))}
              {!selected.occurrences.some((occurrence) => !occurrence.isDeclaration) && <p>只有格式声明，尚未发现真实实例。</p>}
            </div>

            <div className="protocol-actions">
              <button className="secondary-button" disabled={busy} onClick={() => onAnalyze([selected.id])}><Sparkles size={16} />重新判断</button>
              <button className="secondary-button danger-ghost" disabled={busy} onClick={() => onSave(selected.id, 'ignored', draftFields)}><X size={16} />忽略协议</button>
              <button className="primary-button" disabled={busy} onClick={() => onSave(selected.id, 'approved', draftFields)}><Check size={16} />采用为项目规则</button>
            </div>
          </> : <div className="table-empty">先重新发现协议，再从左侧选择一种结构</div>}
        </div>
      </div>
    </section>
  );
}
