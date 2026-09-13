import type { AsyncDatabase } from '../../async-db.js';
import type { RejectedTranslationError } from '../../domain/translation/translation-errors.js';

/** Keep the rejected output available for review without completing the running item. */
export async function saveRejectedTranslation(
  database: AsyncDatabase,
  now: () => string,
  jobId: string,
  jobItemId: string,
  error: RejectedTranslationError,
): Promise<void> {
  await database.prepare(`
    UPDATE segments SET translated_text = ?, final_text = NULL, review_status = 'pending', qa_flags = ?, updated_at = ?
    WHERE id = ? AND EXISTS (
      SELECT 1 FROM job_items WHERE id = ? AND job_id = ? AND segment_id = segments.id AND status = 'running'
    )
  `).run(error.translatedText, JSON.stringify(error.qaFlags), now(), error.segmentId, jobItemId, jobId);
}
