import { CheckCheck, Pause, Play, RefreshCw, ShieldCheck, Square } from 'lucide-react';
import { STATUS_LABELS } from '../../constants';
import type { Job } from '../../types';
import { formatClock, formatTime } from '../../utils/format';

export function JobsView({
  jobs,
  selected,
  onSelect,
  onAction,
  onOpenReview,
  languageBehaviorMode,
  targetLanguage,
}: {
  jobs: Job[];
  selected: Job | null;
  onSelect: (job: Job) => void;
  onAction: (jobId: string, action: 'pause' | 'resume' | 'retry-failed' | 'rerun-postprocessing' | 'cancel') => void;
  onOpenReview: () => void;
  languageBehaviorMode: 'target' | 'preserve';
  targetLanguage: string;
}) {
  const selectedJob = selected && jobs.some((item) => item.id === selected.id) ? selected : null;
  const job = selectedJob ?? jobs[0] ?? null;
  const processedItems = job ? Math.max(0, job.completedItems + job.failedItems) : 0;
  const postTotalItems = job ? Math.max(0, job.postTotalItems ?? 0) : 0;
  const postCompletedItems = job ? Math.max(0, job.postCompletedItems ?? 0) : 0;
  const postFailedItems = job ? Math.max(0, job.postFailedItems ?? 0) : 0;
  const postProcessedItems = Math.min(postTotalItems, postCompletedItems + postFailedItems);
  const totalWorkItems = job ? Math.max(0, job.totalItems + postTotalItems) : 0;
  const processedWorkItems = Math.min(totalWorkItems, processedItems + postProcessedItems);
  const translatingItems = job ? Math.max(0, totalWorkItems - processedWorkItems) : 0;
  const percent = totalWorkItems
    ? translatingItems > 0
      ? Math.min(99, Math.floor((processedWorkItems / totalWorkItems) * 100))
      : 100
    : 0;
  const translationFinished = Boolean(job && (
    translatingItems === 0
    && (['review', 'review_with_errors', 'failed'].includes(job.status)
      || (totalWorkItems > 0 && processedWorkItems >= totalWorkItems))
  ));
  const hasFollowUpFailure = postFailedItems > 0;
  const followUpNeedsRetry = hasFollowUpFailure || (postTotalItems > 0 && postProcessedItems < postTotalItems);
  const mainTranslationRemaining = job ? Math.max(0, job.totalItems - processedItems) : 0;
  const followUpPending = postTotalItems > 0 && mainTranslationRemaining > 0;
  const followUpInProgress = postTotalItems > 0 && !followUpPending && postProcessedItems < postTotalItems;
  const hasTranslationFailure = Boolean(job && (job.failedItems > 0 || hasFollowUpFailure || job.status === 'review_with_errors'));
  return (
    <section className="jobs-layout">
      <div className="job-list">
        {jobs.map((item) => {
          const itemPostTotal = Math.max(0, item.postTotalItems ?? 0);
          const itemPostProcessed = Math.min(itemPostTotal, Math.max(0, (item.postCompletedItems ?? 0) + (item.postFailedItems ?? 0)));
          return (
            <button key={item.id} className={`job-list-item ${job?.id === item.id ? 'active' : ''}`} onClick={() => onSelect(item)}>
              <span className={`job-state state-${item.status}`} />
              <span><strong>{STATUS_LABELS[item.status] || item.status}</strong><small>{formatTime(item.createdAt)} · {item.model}</small></span>
              <b>{item.completedItems + itemPostProcessed}/{item.totalItems + itemPostTotal}</b>
            </button>
          );
        })}
        {!jobs.length && <div className="table-empty">还没有翻译任务</div>}
      </div>
      <div className="job-detail">
        {job ? <>
          <div className="job-title-row"><div><h2>任务进度</h2><span>{job.model} · 卡片语言设定：{languageBehaviorMode === 'preserve' ? '保留卡片原设定' : `跟随${targetLanguage}`}</span></div><strong>{percent}%</strong></div>
          <div className="progress-track"><span style={{ width: `${percent}%` }} /></div>
          <div className="job-metrics"><span>成功 <b>{job.completedItems}</b></span><span>失败 <b>{job.failedItems}</b></span><span>翻译中 <b>{translatingItems}</b></span><span>总计（含后续） <b>{totalWorkItems}</b></span></div>
          {job.status === 'queued' && <div className="job-live-status" role="status">任务已排队，等待模型请求开始；日志会实时显示阶段和返回结果。</div>}
          {job.status === 'running' && translatingItems > 0 && <div className="job-live-status active" role="status">正在请求模型，收到返回后会自动提交本批结果；请查看下方运行日志。</div>}
          {postTotalItems > 0 && (
            <div className={`job-follow-up ${followUpPending ? 'pending' : followUpInProgress ? 'active' : hasFollowUpFailure ? 'failed' : 'complete'}`} role="status" aria-live="polite">
              <div className="job-follow-up-heading"><strong>阶段 2：Lua 正则与关键词适配</strong><b>运行时名称 {postProcessedItems}/{postTotalItems}</b></div>
              <span>{followUpPending ? `文本翻译完成后处理 Lua 正则、关键词和 ${postTotalItems} 个运行时名称。` : followUpInProgress ? `正在处理 Lua 正则、关键词和剩余 ${postTotalItems - postProcessedItems} 个运行时名称，完成后进入审核。` : hasFollowUpFailure ? `有 ${postFailedItems} 个运行时名称未完成，导出阶段会再次尝试。` : 'Lua 正则、关键词和运行时名称已处理完成，可以进入审核。'}</span>
            </div>
          )}
          {translationFinished && (
            <div className="job-complete-callout" role="status" aria-live="polite">
              <span className="job-complete-icon"><ShieldCheck size={18} /></span>
              <div className="job-complete-copy">
                <strong>{hasTranslationFailure ? '翻译已完成，但有项目需要留意' : '翻译已完成，下一步进入审核'}</strong>
                <span>{hasTranslationFailure ? '请先查看失败项和阶段 2 的适配提示，再确认哪些译文可以通过。' : '请在审核页对照原文、译文和风险提示，确认后点击“保存”或“保存并导出”。'}</span>
              </div>
              <button className="primary-button" type="button" onClick={onOpenReview}><CheckCheck size={16} />进入审核</button>
            </div>
          )}
          <div className="job-actions">
            {['queued', 'running'].includes(job.status) && <button onClick={() => onAction(job.id, 'pause')}><Pause size={16} />暂停</button>}
            {['paused', 'failed', 'cancelled'].includes(job.status) && <button onClick={() => onAction(job.id, 'resume')}><Play size={16} />继续翻译</button>}
            {(job.failedItems > 0 || hasFollowUpFailure || job.status === 'review_with_errors') && <button onClick={() => onAction(job.id, 'retry-failed')}><RefreshCw size={16} />{job.failedItems > 0 && (hasFollowUpFailure || job.status === 'review_with_errors') ? '重试失败项与阶段 2' : hasFollowUpFailure || job.status === 'review_with_errors' ? '重试阶段 2' : '重试失败项'}</button>}
            {job.status === 'review' && followUpNeedsRetry && <button onClick={() => onAction(job.id, 'rerun-postprocessing')}><RefreshCw size={16} />重试阶段 2</button>}
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
