import dependencies from '../../../patches/risuai/scripts/dependencies.json';

export function PatchDependencies({ patch }: { patch: string }) {
  const required = (dependencies as Record<string, Array<{ patch: string; name: string }>>)[patch];
  if (!required?.length) return null;
  return <p className="patch-agent-help" role="note"><strong>前置补丁：</strong>{required.map((item) => item.name).join('、')}。两项均安装后，再安装资源清单缓存；缺失时预检将提示先安装对应补丁。</p>;
}
