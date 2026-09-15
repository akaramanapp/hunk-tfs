import type { TfsFileChange } from "./types.ts";

const CONTEXT = 3;

/** Split text into lines without retaining a trailing empty line from a final newline. */
export function splitLines(text: string): string[] {
  if (text.length === 0) return [];
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

/**
 * Compact Myers O(ND) line diff.
 * Returns operations as pairs of (oldIndex, newIndex) equality matches plus insert/delete markers.
 */
function myersDiff(a: string[], b: string[]): Array<{ type: "equal" | "insert" | "delete"; line: string }> {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  if (max === 0) return [];

  const offset = max;
  const v = new Int32Array(2 * max + 1);
  v.fill(-1);
  v[offset + 1] = 0;
  const trace: Int32Array[] = [];

  let found = false;
  let finalD = 0;
  for (let d = 0; d <= max; d += 1) {
    const snapshot = Int32Array.from(v);
    trace.push(snapshot);
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!)) {
        x = v[offset + k + 1]!;
      } else {
        x = v[offset + k - 1]! + 1;
      }
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x += 1;
        y += 1;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        found = true;
        finalD = d;
        break;
      }
    }
    if (found) break;
  }

  if (!found) {
    // Fallback: treat as full replace (should be unreachable for finite inputs).
    return [
      ...a.map((line) => ({ type: "delete" as const, line })),
      ...b.map((line) => ({ type: "insert" as const, line })),
    ];
  }

  const ops: Array<{ type: "equal" | "insert" | "delete"; line: string }> = [];
  let x = n;
  let y = m;
  for (let d = finalD; d > 0; d -= 1) {
    // Snapshot is taken at the *start* of depth d (before edits), i.e. V after d-1.
    // Backtracking depth d must therefore read trace[d], not trace[d - 1].
    const vPrev = trace[d]!;
    const k = x - y;
    let prevK: number;
    if (k === -d || (k !== d && vPrev[offset + k - 1]! < vPrev[offset + k + 1]!)) {
      prevK = k + 1;
    } else {
      prevK = k - 1;
    }
    const prevX = vPrev[offset + prevK]!;
    const prevY = prevX - prevK;

    while (x > prevX && y > prevY) {
      x -= 1;
      y -= 1;
      ops.push({ type: "equal", line: a[x]! });
    }
    if (x === prevX) {
      y -= 1;
      ops.push({ type: "insert", line: b[y]! });
    } else {
      x -= 1;
      ops.push({ type: "delete", line: a[x]! });
    }
  }
  while (x > 0 && y > 0) {
    x -= 1;
    y -= 1;
    ops.push({ type: "equal", line: a[x]! });
  }
  while (x > 0) {
    x -= 1;
    ops.push({ type: "delete", line: a[x]! });
  }
  while (y > 0) {
    y -= 1;
    ops.push({ type: "insert", line: b[y]! });
  }

  ops.reverse();
  return ops;
}

function formatPath(path: string): string {
  return path.replace(/\\/g, "/");
}

/** Build one unified-diff file section from old/new text. */
export function createUnifiedFilePatch(
  oldPath: string,
  newPath: string,
  oldText: string | null,
  newText: string | null,
): string {
  const a = oldText === null ? [] : splitLines(oldText);
  const b = newText === null ? [] : splitLines(newText);
  const oldHeader = oldText === null ? "/dev/null" : `a/${formatPath(oldPath)}`;
  const newHeader = newText === null ? "/dev/null" : `b/${formatPath(newPath)}`;

  if (a.length === 0 && b.length === 0) return "";

  const ops = myersDiff(a, b);
  const hunks: string[] = [];

  let i = 0;
  while (i < ops.length) {
    while (i < ops.length && ops[i]!.type === "equal") i += 1;
    if (i >= ops.length) break;

    const hunkStart = Math.max(0, i - CONTEXT);
    let j = i;
    while (j < ops.length) {
      while (j < ops.length && ops[j]!.type !== "equal") j += 1;
      let equalRun = 0;
      while (j + equalRun < ops.length && ops[j + equalRun]!.type === "equal") equalRun += 1;
      if (equalRun > CONTEXT * 2) {
        j += CONTEXT;
        break;
      }
      j += equalRun;
    }
    const hunkEnd = Math.min(ops.length, j);

    let oldStart = 0;
    let newStart = 0;
    for (let k = 0; k < hunkStart; k += 1) {
      const op = ops[k]!;
      if (op.type === "equal" || op.type === "delete") oldStart += 1;
      if (op.type === "equal" || op.type === "insert") newStart += 1;
    }

    let oldCount = 0;
    let newCount = 0;
    const body: string[] = [];
    for (let k = hunkStart; k < hunkEnd; k += 1) {
      const op = ops[k]!;
      if (op.type === "equal") {
        body.push(` ${op.line}`);
        oldCount += 1;
        newCount += 1;
      } else if (op.type === "delete") {
        body.push(`-${op.line}`);
        oldCount += 1;
      } else {
        body.push(`+${op.line}`);
        newCount += 1;
      }
    }

    const oldRange = oldCount === 0 ? `${oldStart},0` : oldCount === 1 ? `${oldStart + 1}` : `${oldStart + 1},${oldCount}`;
    const newRange = newCount === 0 ? `${newStart},0` : newCount === 1 ? `${newStart + 1}` : `${newStart + 1},${newCount}`;
    hunks.push(`@@ -${oldRange} +${newRange} @@`, ...body);
    i = hunkEnd;
  }

  if (hunks.length === 0) return "";

  return [`diff --git a/${formatPath(oldPath)} b/${formatPath(newPath)}`, `--- ${oldHeader}`, `+++ ${newHeader}`, ...hunks].join(
    "\n",
  );
}

export interface BuiltPatch {
  readonly text: string;
  readonly skipped: readonly string[];
}

export type ItemReader = (
  path: string,
  commitId: string,
) => Promise<string | null>;

/** Fetch contents for each change and assemble a multi-file unified patch. */
export async function buildUnifiedPatch(
  changes: readonly TfsFileChange[],
  baseCommit: string,
  headCommit: string,
  readItem: ItemReader,
  onProgress?: (message: string) => void,
): Promise<BuiltPatch> {
  const sections: string[] = [];
  const skipped: string[] = [];

  for (const [index, change] of changes.entries()) {
    onProgress?.(`Building patch ${index + 1}/${changes.length}: ${change.path}`);

    const oldPath = change.originalPath ?? change.path;
    const newPath = change.path;

    let oldText: string | null = null;
    let newText: string | null = null;

    if (change.changeType === "add") {
      newText = await readItem(newPath, headCommit);
      if (newText === null) {
        skipped.push(`${newPath} (missing or binary add)`);
        continue;
      }
    } else if (change.changeType === "delete") {
      oldText = await readItem(oldPath, baseCommit);
      if (oldText === null) {
        skipped.push(`${oldPath} (missing or binary delete)`);
        continue;
      }
    } else {
      oldText = await readItem(oldPath, baseCommit);
      newText = await readItem(newPath, headCommit);
      if (oldText === null && newText === null) {
        skipped.push(`${newPath} (missing or binary)`);
        continue;
      }
      // Treat missing old as add, missing new as delete.
      if (oldText === null) {
        // keep as add-like
      } else if (newText === null) {
        // keep as delete-like
      }
    }

    const section = createUnifiedFilePatch(oldPath, newPath, oldText, newText);
    if (section) sections.push(section);
  }

  const text = sections.length > 0 ? `${sections.join("\n")}\n` : "";
  return { text, skipped };
}
