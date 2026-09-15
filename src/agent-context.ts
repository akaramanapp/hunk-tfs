import type { AgentAnnotation, AgentFileContext } from "hunkdiff/extension";
import type { TfsReviewThread, TfsThreadComment } from "./types.ts";

/** Top-level sidecar shape accepted by `hunk patch --agent-context`. */
export interface AgentContextDocument {
  readonly version: 1;
  readonly summary?: string;
  readonly files: readonly AgentFileContext[];
}

function normalizePath(path: string): string {
  return path.replace(/^\/+/, "");
}

function annotationForComment(
  thread: TfsReviewThread,
  comment: TfsThreadComment,
): AgentAnnotation | null {
  const position = thread.position;
  if (!position) return null;
  const start = position.line;
  const end = position.endLine && position.endLine >= start ? position.endLine : start;
  const range: [number, number] = [start, end];
  const status = thread.status.trim().toLowerCase() || "unknown";

  return {
    id: `tfs-thread-${thread.id}-comment-${comment.id}`,
    ...(position.side === "old" ? { oldRange: range } : { newRange: range }),
    summary: comment.content,
    rationale: `threadId: ${thread.id} (${status})`,
    author: comment.author,
    source: "agent",
    title: `TFS · ${status}`,
    createdAt: comment.publishedDate,
    editable: false,
    tags: ["tfs", status],
  };
}

/** Convert each comment in each file-anchored TFS thread into a Hunk annotation. */
export function buildAgentContextFromThreads(
  pullRequestId: string,
  threads: readonly TfsReviewThread[],
): AgentContextDocument {
  const byPath = new Map<string, AgentAnnotation[]>();

  for (const thread of threads) {
    if (!thread.position) continue;
    const path = normalizePath(thread.position.filePath);
    const list = byPath.get(path) ?? [];
    for (const comment of thread.comments) {
      const annotation = annotationForComment(thread, comment);
      if (annotation) list.push(annotation);
    }
    if (list.length > 0) byPath.set(path, list);
  }

  const files: AgentFileContext[] = [...byPath.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([path, annotations]) => ({
      path,
      summary: `${annotations.length} TFS comment${annotations.length === 1 ? "" : "s"}`,
      annotations,
    }));

  const anchored = files.reduce((sum, file) => sum + file.annotations.length, 0);
  const general = threads.filter((thread) => !thread.position).length;

  return {
    version: 1,
    summary:
      general > 0
        ? `TFS PR #${pullRequestId}: ${anchored} inline comment${anchored === 1 ? "" : "s"}, ${general} general thread${general === 1 ? "" : "s"} (see Comments pane).`
        : `TFS PR #${pullRequestId}: ${anchored} inline review comment${anchored === 1 ? "" : "s"}.`,
    files,
  };
}
