/** Bounded parallel reads; assemble by offset even when responses finish out of order. */
export async function loadSegmentPages<T>(total: number, pageSize: number,
  read: (offset: number, limit: number) => Promise<{ total: number; segments: T[] }>,
  progress: (current: number) => void, signal: AbortSignal, concurrency = 3): Promise<T[]> {
  const pages: T[][] = [];
  let next = 0;
  let loaded = 0;
  let failed = false;
  const workers = Array.from({ length: Math.min(concurrency, Math.ceil(total / pageSize)) }, async () => {
    while (next < total && !failed) {
      signal.throwIfAborted();
      const offset = next;
      next += pageSize;
      try {
        const page = await read(offset, pageSize);
        signal.throwIfAborted();
        if (page.total !== total || page.segments.length !== Math.min(pageSize, total - offset)) {
          throw new Error('卡片段落在读取期间发生变化或返回不完整，请重新打开项目。');
        }
        pages[offset / pageSize] = page.segments;
        loaded += page.segments.length;
        progress(loaded);
      } catch (error) { failed = true; throw error; }
    }
  });
  await Promise.all(workers);
  signal.throwIfAborted();
  return pages.flat();
}
