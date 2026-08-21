import { Pause, Play, RefreshCw, Square } from 'lucide-react';
import { STATUS_LABELS } from '../../constants';
import type { Job } from '../../types';
import { formatClock, formatTime } from '../../utils/format';

export function JobsView({
  jobs,
  selected,
  onSelect,
  onAction,
  languageBehaviorMode,
  targetLanguage,
}: {
  jobs: Job[];
  selected: Job | null;
  onSelect: (job: Job) => void;
  onAction: (jobId: string, action: 'pause' | 'resume' | 'retry-failed' | 'cancel') => void;
  languageBehaviorMode: 'target' | 'preserve';
  targetLanguage: string;
}) {
  const selectedJob = selected && jobs.some((item) => item.id === selected.id) ? selected : null;
  const job = selectedJob ?? jobs[0] ?? null;
  const percent = job?.totalItems ? Math.round(((job.completedItems + job.failedItems) / job.totalItems) * 100) : 0;
  return (
    <section className="jobs-layout">
      <div className="job-list">
        {jobs.map((item) => (
          <button key={item.id} className={`job-list-item ${job?.id === item.id ? 'active' : ''}`} onClick={() => onSelect(item)}>
            <span className={`job-state state-${item.status}`} />
            <span><strong>{STATUS_LABELS[item.status] || item.status}</strong><small>{formatTime(item.createdAt)} · {item.model}</small></span>
            <b>{item.completedItems}/{item.totalItems}</b>
          </button>
        ))}
        {!jobs.length && <div className="table-empty">还没有翻译任务</div>}
      </div>
      <div className="job-detail">
        {job ? <>
          <div className="job-title-row"><div><h2>任务进度</h2><span>{job.model} · 卡片语言设定：{languageBehaviorMode === 'preserve' ? '保留卡片原设定' : `跟随${targetLanguage}`}</span></div><strong>{percent}%</strong></div>
          <div className="progress-track"><span style={{ width: `${percent}%` }} /></div>
          <div className="job-metrics"><span>成功 <b>{job.completedItems}</b></span><span>失败 <b>{job.failedItems}</b></span><span>总计 <b>{job.totalItems}</b></span></div>
          <div className="job-actions">
            {['queued', 'running'].includes(job.status) && <button onClick={() => onAction(job.id, 'pause')}><Pause size={16} />暂停</button>}
            {['paused', 'failed'].includes(job.status) && <button onClick={() => onAction(job.id, 'resume')}><Play size={16} />继续</button>}
            {job.failedItems > 0 && <button onClick={() => onAction(job.id, 'retry-failed')}><RefreshCw size={16} />重试失败项</button>}
            {['queued', 'running', 'paused'].includes(job.status) && <button onClick={() => onAction(job.id, 'cancel')}><Square size={15} />取消</button>}
          </div>
          {job.lastError && <div className="job-error">{job.lastError}</div>}
          <div className="log-panel">
            {(job.logs ?? []).map((entry) => <div key={entry.id} className={`log-${entry.level}`}><time>{formatClock(entry.createdAt)}</time><span>{entry.message}</span></div>)}
            {!job.logs?.length && <div className="muted-text">选择任务后读取运行日志</div>}
          </div>
        </> : <div className="table-empty">选择一个任务查看详情</div>}
      </div>
    </section>
  );
}
