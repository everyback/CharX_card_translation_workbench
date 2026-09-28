import { FileCode2, ChevronRight } from 'lucide-react';
import { patchCatalog } from './patch-catalog';
export function PatchList({ value, available, disabled, onChange }: { value: string; available: string[]; disabled: boolean; onChange: (value: string) => void }) {
  return <nav className="patch-list" aria-label="补丁列表">{patchCatalog.filter((item) => available.includes(item.id)).map((item) => <button key={item.id} aria-current={value === item.id ? 'true' : undefined} disabled={disabled} onClick={() => onChange(item.id)}><FileCode2 size={16} /><span><strong>{item.name}</strong><small>{item.kind === 'source' ? '源码' : item.kind === 'server' ? '前端 + 服务端' : '构建文件'}</small></span><ChevronRight size={14} /></button>)}</nav>;
}
