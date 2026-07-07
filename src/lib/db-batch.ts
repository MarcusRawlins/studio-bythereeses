// Phase 22 (rev 2, B2): Cloudflare D1 caps bound parameters at 100 per query. Any
// `inArray(column, ids)` built from a batch whose size can exceed that (e.g. the projects list's
// default `pageSize = 200`, `src/app/projects/page.tsx` ~11) THROWS in production D1 while
// passing local SQLite — local dev cannot catch this class of bug. Every batched `inArray` fetch
// on a possibly-large id set MUST go through `chunkedInArrayFetch` below, chunked at
// `D1_IN_ARRAY_CHUNK_SIZE` (90, safely under the 100 cap).
//
// DB-agnostic on purpose: the caller supplies the actual drizzle query as `fetcher`, so this file
// has no `@/db` / drizzle-orm dependency of its own.

export const D1_IN_ARRAY_CHUNK_SIZE = 90;

export function chunkIds<T>(ids: T[], chunkSize: number = D1_IN_ARRAY_CHUNK_SIZE): T[][] {
  if (!ids.length) return [];
  const chunks: T[][] = [];
  for (let index = 0; index < ids.length; index += chunkSize) {
    chunks.push(ids.slice(index, index + chunkSize));
  }
  return chunks;
}

export async function chunkedInArrayFetch<TId, TRow>(
  ids: TId[],
  fetcher: (chunkOfIds: TId[]) => Promise<TRow[]>,
  chunkSize: number = D1_IN_ARRAY_CHUNK_SIZE,
): Promise<TRow[]> {
  const chunks = chunkIds(ids, chunkSize);
  if (!chunks.length) return [];
  const results = await Promise.all(chunks.map((chunk) => fetcher(chunk)));
  return results.flat();
}
