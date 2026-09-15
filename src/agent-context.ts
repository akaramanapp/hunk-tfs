import type { AgentAnnotation, AgentFileContext } from "hunkdiff/extension";
import type { TfsReviewThread } from "./types.ts";

/** Top-level sidecar shape accepted by `hunk patch --agent-context`. */
export interface AgentContextDocument {
  readonly version: 1;
  readonly summary?: string;
  readonly files: readonly AgentFileContext[];
}

function normalizePath(path: string): string {
  return path.replace(/^\/+/, "");
}

function threadSummary(thread: TfsReviewThread): string {
  const first = thread.comments[0];
  if (!first) return `Thread #${thread.id}`;
  const oneLine = first.content.replace(/\s+/g, " ").trim();
  return oneLine.length > 120 ? `${oneLine.slice(0, 117)}...` : oneLine;
}

function threadRationale(thread: TfsReviewThread): string {
  return thread.comments
    .map((comment, index) => {
      const header = index === 0 ? comment.author : `${comment.author} (reply)`;
      return `${header}:\n${comment.content.trim()}`;
    })
    .join("\n\n");
}

function annotationForThread(thread: TfsReviewThread): AgentAnnotation | null {
  const position = thread.position;
  if (!position) return null;

  const first = thread.comments[0];
  const start = position.line;
  const end = position.endLine && position.endLine >= start ? position.endLine : start;
  const range: [number, number] = [start, end];

  return {
    id: `tfs-thread-${thread.id}`,
    ...(position.side === "old" ? { oldRange: range } : { newRange: range }),
    summary: threadSummary(thread),
    rationale: threadRationale(thread),
    author: first?.author ?? "TFS",
    source: "agent",
    title: `TFS · ${thread.status}`,
    createdAt: first?.publishedDate,
    editable: false,
    tags: ["tfs", thread.status],
  };
}

/** Convert file-anchored TFS threads into a Hunk agent-context document. */
export function buildAgentContextFromThreads(
  pullRequestId: string,
  threads: readonly TfsReviewThread[],
): AgentContextDocument {
  const byPath = new Map<string, AgentAnnotation[]>();

  for (const thread of threads) {
    const annotation = annotationForThread(thread);
    if (!annotation || !thread.position) continue;
    const path = normalizePath(thread.position.filePath);
    const list = byPath.get(path) ?? [];
    list.push(annotation);
    byPath.set(path, list);
  }

  const files: AgentFileContext[] = [...byPath.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([path, annotations]) => ({
      path,
      summary: `${annotations.length} TFS comment${annotations.length === 1 ? "" : "s"}`,
      annotations,
    }));

  const anchored = files.reduce((sum, file) => sum + file.annotations.length, 0);
  const general = threads.length - anchored;

  return {
    version: 1,
    summary:
      general > 0
        ? `TFS PR #${pullRequestId}: ${anchored} inline comment${anchored === 1 ? "" : "s"}, ${general} general thread${general === 1 ? "" : "s"} (see Comments pane).`
        : `TFS PR #${pullRequestId}: ${anchored} inline review comment${anchored === 1 ? "" : "s"}.`,
    files,
  };
}
