import { ArrowRight, Code2 } from 'lucide-react';
import type { LuaManagementReport } from '@/shared/types';

export interface LuaRuntimeRegexListProps {
  references: LuaManagementReport['controlReferences'];
  onOpen: (reference: LuaManagementReport['controlReferences'][number]) => void;
}

export function LuaRuntimeRegexList({ references, onOpen }: LuaRuntimeRegexListProps) {
  return (
    <section className="lua-panel lua-runtime-regex-panel" id="lua-runtime-regex-detection-detail">
      <div className="lua-panel-header"><div><h2>运行时展示正则详情</h2><span>消息展示时执行；不以静态卡片命中数作为通过条件</span></div><Code2 size={17} /></div>
      <div className="lua-runtime-regex-list">
        {references.map((reference) => (
          <button type="button" className="lua-runtime-regex-row" key={reference.pathLabel} onClick={() => onOpen(reference)}>
            <code>{reference.pathLabel}</code><span>{reference.fullPattern || reference.pattern}</span><em>运行时编译校验</em><ArrowRight size={14} />
          </button>
        ))}
        {!references.length && <div className="lua-simple-empty">没有消息展示阶段的正则规则。</div>}
      </div>
    </section>
  );
}
