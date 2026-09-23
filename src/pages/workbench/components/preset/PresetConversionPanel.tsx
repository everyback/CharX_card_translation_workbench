import { AlertTriangle, CheckCircle2, FileWarning, Plug, Regex, ToggleLeft } from 'lucide-react';
import type { CapabilityOwner, PresetProjectView } from '@/features/preset/model/types';

interface PresetConversionPanelProps {
  view: PresetProjectView;
  busy: boolean;
  onSelectBlock: (blockIndex: number | null) => void;
}

const OWNER_LABEL: Record<CapabilityOwner, string> = {
  direct: '直用',
  convert: '需转换',
  bridge: '需桥接',
  impossible: '无法实现',
};

function blockLabel(characterId: string | number | null, index: number, count: number): string {
  const id = characterId === null ? '未知' : String(characterId);
  return `#${index} · character_id=${id} · ${count} 条`;
}

/**
 * Conversion summary for a preset project: what the `.risup` will contain, which
 * `prompt_order` block is used, and everything the conversion could not carry
 * over. Nothing is hidden — a silent difference here is exactly what makes a
 * converted preset look right and behave wrong.
 */
export function PresetConversionPanel({ view, busy, onSelectBlock }: PresetConversionPanelProps) {
  const { analysis, report, capabilities } = view;
  const always = view.prompts.filter((prompt) => prompt.state === 'always').length;
  const gated = view.prompts.filter((prompt) => prompt.state === 'gated').length;
  const bridged = capabilities.rules.filter((rule) => rule.requiresBridge);
  const otherRules = capabilities.rules.filter((rule) => !rule.requiresBridge && rule.findings.length > 0);

  return (
    <section className="preset-panel" aria-label="转换概要">
      <div className="preset-panel-head">
        <div>
          <h2>转换概要</h2>
          <span>{analysis.promptCount} 条提示词 → {always} 条常驻 + {gated} 个开关</span>
        </div>
      </div>

      <div className="preset-stats">
        <div><ToggleLeft size={15} /><strong>{gated}</strong><span>首次默认关闭的开关</span></div>
        <div><CheckCircle2 size={15} /><strong>{report.regexConverted.length}</strong><span>条正则已转换</span></div>
        <div className={report.dropped.length ? 'warn' : ''}><FileWarning size={15} /><strong>{report.dropped.length}</strong><span>条无法映射</span></div>
        <div className={report.regexSkipped.length ? 'warn' : ''}><Regex size={15} /><strong>{report.regexSkipped.length}</strong><span>条正则跳过</span></div>
      </div>

      {capabilities.notices.length > 0 && (
        <div className={`preset-note${capabilities.summary.requiresPlugin ? ' warn' : ''}`} role="status">
          <AlertTriangle size={14} />
          <div>{capabilities.notices.map((notice) => <span key={notice}>{notice}</span>)}</div>
        </div>
      )}

      {bridged.length > 0 && (
        <details className="preset-details" open>
          <summary>
            <Plug size={13} /> 需要桥接插件的规则 {bridged.length} 条（未安装时点了没反应）
          </summary>
          <ul>
            {bridged.map((rule) => (
              <li key={rule.index}>
                <b>regex[{rule.index}] {rule.comment}</b>
                {'：动作 '}{rule.bridgeActions.join('、')}
              </li>
            ))}
          </ul>
          <small>
            这些规则把点击动作交给页面级插件执行（写聊天输入框、触发发送）。
            RisuAI 的消息内脚本与 Lua 触发器都够不到输入框，所以必须装插件。
          </small>
        </details>
      )}

      {otherRules.length > 0 && (
        <details className="preset-details">
          <summary>其他转换说明 {otherRules.length} 条</summary>
          <ul>
            {otherRules.map((rule) => (
              <li key={rule.index}>
                <b>regex[{rule.index}] {rule.comment}</b>
                {'（'}{OWNER_LABEL[rule.owner]}{'）'}
                <ul>
                  {rule.findings.map((finding, index) => (
                    <li key={`${finding.code}-${index}`}>{finding.message}</li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </details>
      )}

      {analysis.blocks.length > 1 && (
        <div className="preset-block-picker">
          <label htmlFor="preset-block">使用的 prompt_order 块</label>
          <select
            id="preset-block"
            value={String(view.blockIndex ?? '')}
            disabled={busy}
            onChange={(event) => void onSelectBlock(event.target.value === '' ? null : Number(event.target.value))}
          >
            <option value="">自动（推荐 #{analysis.recommendedBlockIndex}）</option>
            {analysis.blocks.map((block) => (
              <option key={block.index} value={block.index}>{blockLabel(block.characterId, block.index, block.entries.length)}</option>
            ))}
          </select>
          <small>RisuAI 预设只有一份提示词模板，多块时只能选一个；默认选引用集合最大的块。</small>
        </div>
      )}

      {report.issues.some((item) => item.severity === 'error') && (
        <div className="preset-note warn" role="alert">
          <strong>存在尚未迁移的运行行为，暂不能生成可运行 .risup。可下载存档包保留全部内容。</strong>
          <ul>{report.issues.filter((item) => item.severity === 'error').map((item, index) => <li key={`${item.code}-${index}`}>{item.path}：{item.message}</li>)}</ul>
        </div>
      )}
      {(report.covered.length > 0 || report.archived.length > 0) && (
        <details className="preset-details">
          <summary>原生承载 {report.covered.length} 条 · 存档 {report.archived.length} 条</summary>
          <ul>{[...report.covered, ...report.archived].map((item) => <li key={item.identifier}><b>{item.name}</b>：{item.reason}</li>)}</ul>
        </details>
      )}
      {report.promotedToAlwaysOn.length > 0 && (
        <div className="preset-note">
          <strong>{report.promotedToAlwaysOn.length} 条 jailbreak/nsfw 提示词按「常驻」转换</strong>
          <span>RisuAI 的 jailbreak 类型默认被关闭，照搬映射会让这些内容（常含变量定义）不发送。</span>
        </div>
      )}

      {(report.dropped.length > 0 || report.degraded.length > 0 || report.regexSkipped.length > 0 || report.unmappedFields.length > 0) && (
        <details className="preset-details">
          <summary>查看无法映射的内容（{report.dropped.length + report.degraded.length + report.regexSkipped.length} 条）</summary>
          {report.dropped.length > 0 && (
            <>
              <h4>未映射或空内容</h4>
              <ul>{report.dropped.map((item) => <li key={item.identifier}><b>{item.name}</b>：{item.reason}</li>)}</ul>
            </>
          )}
          {report.degraded.length > 0 && (
            <>
              <h4>语义降级</h4>
              <ul>{report.degraded.map((item) => <li key={item.identifier}><b>{item.name}</b>：{item.reason}</li>)}</ul>
            </>
          )}
          {report.regexSkipped.length > 0 && (
            <>
              <h4>正则跳过</h4>
              <ul>{report.regexSkipped.map((item) => <li key={item.name}><b>{item.name}</b>：{item.reason}</li>)}</ul>
            </>
          )}
          {report.unmappedFields.length > 0 && (
            <>
              <h4>尚未映射的源字段（完整存档保留）</h4>
              <p className="preset-field-list">{report.unmappedFields.join('、')}</p>
            </>
          )}
        </details>
      )}

      {report.warnings.length > 0 && (
        <div className="preset-note muted">
          <AlertTriangle size={14} />
          <div>{report.warnings.map((warning) => <span key={warning}>{warning}</span>)}</div>
        </div>
      )}
    </section>
  );
}
