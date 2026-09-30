import type { LuaManagementReport } from '@/shared/types';

export function diagnosticState(report: LuaManagementReport) {
  const validated = report.syntaxStatus === 'passed';
  const syntaxIssues = report.issues.filter(issue => issue.kind === 'syntax');
  return {
    syntax: !report.hasModule ? '不适用' : syntaxIssues.length ? `发现 ${syntaxIssues.length} 条问题` : validated ? '语法通过' : '待校验',
    syntaxPassed: report.hasModule && validated && !syntaxIssues.length,
    export: report.blockerCount ? `${report.blockerCount} 个阻断` : report.steps.find(step => step.id === 'export')?.status === 'complete'
      ? '审核稿已就绪，导出时回验' : '保存审核稿后回验',
  };
}
