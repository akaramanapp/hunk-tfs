import { useSyncExternalStore, useState } from "react";
import type { ExtensionPaneProps } from "hunkdiff/extension";
import { getThreadsSnapshot, subscribeThreads } from "./threads-store.ts";
import type { TfsReviewThread } from "./types.ts";

function useThreads() {
  return useSyncExternalStore(subscribeThreads, getThreadsSnapshot);
}

function summarize(thread: TfsReviewThread): string {
  const first = thread.comments[0];
  if (!first) return "(empty)";
  const oneLine = first.content.replace(/\s+/g, " ").trim();
  return oneLine.length > 72 ? `${oneLine.slice(0, 69)}...` : oneLine;
}

function locationLabel(thread: TfsReviewThread): string {
  if (!thread.position) return "general";
  return `${thread.position.filePath}:${thread.position.line}`;
}

function findFileId(files: ExtensionPaneProps["files"], path: string): string | null {
  const normalized = path.replace(/^\/+/, "");
  const match = files.find((file) => file.path.replace(/^\/+/, "") === normalized);
  return match?.id ?? null;
}

export function CommentsPane({ files, theme, actions, selectedFileId }: ExtensionPaneProps) {
  const snapshot = useThreads();
  const [cursor, setCursor] = useState(0);
  const threads = snapshot.threads;
  const active = threads.length === 0 ? 0 : Math.min(cursor, threads.length - 1);

  const jumpTo = (thread: TfsReviewThread) => {
    if (!thread.position) {
      actions.notify("This thread is not anchored to a file line", "warning");
      return;
    }
    const fileId = findFileId(files, thread.position.filePath);
    if (!fileId) {
      actions.notify(`File not in this review: ${thread.position.filePath}`, "warning");
      return;
    }
    actions.revealLine(fileId, thread.position.side, thread.position.line);
  };

  if (threads.length === 0) {
    return (
      <box width="100%" height="100%" backgroundColor={theme.panel}>
        <text
          content={
            snapshot.pullRequestId
              ? `No review comments on PR #${snapshot.pullRequestId}`
              : "No TFS comments loaded"
          }
          style={{ fg: theme.muted, bg: theme.panel }}
        />
      </box>
    );
  }

  return (
    <box
      width="100%"
      height="100%"
      backgroundColor={theme.panel}
      onKeyDown={(event: { name?: string }) => {
        if (event.name === "up" || event.name === "k") {
          setCursor((value) => Math.max(0, value - 1));
          return;
        }
        if (event.name === "down" || event.name === "j") {
          setCursor((value) => Math.min(threads.length - 1, value + 1));
          return;
        }
        if (event.name === "return" || event.name === "enter") {
          const thread = threads[active];
          if (thread) jumpTo(thread);
        }
      }}
    >
      <text
        content={`PR #${snapshot.pullRequestId} · ${threads.length} thread${threads.length === 1 ? "" : "s"}`}
        style={{ fg: theme.accent, bg: theme.panel }}
      />
      <scrollbox scrollY={true} width="100%" flexGrow={1}>
        {threads.map((thread, index) => {
          const selected = index === active;
          const fileSelected =
            thread.position !== null &&
            findFileId(files, thread.position.filePath) === selectedFileId;
          const fg = selected ? theme.accent : fileSelected ? theme.text : theme.muted;
          const author = thread.comments[0]?.author ?? "unknown";
          const line = `[${thread.status}] ${author} · ${locationLabel(thread)}`;
          const body = `  ${summarize(thread)}`;
          return (
            <box
              key={String(thread.id)}
              width="100%"
              flexDirection="column"
              onMouseDown={() => {
                setCursor(index);
                jumpTo(thread);
              }}
            >
              <text content={selected ? `❯ ${line}` : `  ${line}`} style={{ fg, bg: theme.panel }} />
              <text content={body} style={{ fg: theme.muted, bg: theme.panel }} />
            </box>
          );
        })}
      </scrollbox>
      <text content="j/k move · enter jump" style={{ fg: theme.muted, bg: theme.panel }} />
    </box>
  );
}
