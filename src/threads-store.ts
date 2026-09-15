import type { TfsReviewThread } from "./types.ts";

export interface ThreadsSnapshot {
  readonly pullRequestId: string;
  readonly threads: readonly TfsReviewThread[];
}

let snapshot: ThreadsSnapshot = { pullRequestId: "", threads: [] };
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function setThreads(pullRequestId: string, threads: readonly TfsReviewThread[]): void {
  snapshot = { pullRequestId, threads: Object.freeze([...threads]) };
  emit();
}

export function clearThreads(): void {
  snapshot = { pullRequestId: "", threads: [] };
  emit();
}

export function getThreadsSnapshot(): ThreadsSnapshot {
  return snapshot;
}

export function subscribeThreads(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Threads that touch a given review path (leading slash tolerant). */
export function threadsForPath(path: string): readonly TfsReviewThread[] {
  const normalized = path.replace(/^\/+/, "");
  return snapshot.threads.filter((thread) => {
    const filePath = thread.position?.filePath.replace(/^\/+/, "");
    return filePath === normalized;
  });
}
