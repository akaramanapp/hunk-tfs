import { HunkExtensionUserError } from "hunkdiff/extension";
import type {
  TfsConnection,
  TfsFileChange,
  TfsPullRequest,
  TfsPullRequestTarget,
  TfsReviewThread,
  TfsThreadComment,
  TfsThreadPosition,
  TfsChangeType,
} from "./types.ts";

const MAX_METADATA_BYTES = 512 * 1024;
const MAX_ITEM_BYTES = 2 * 1024 * 1024;
const MAX_THREADS_BYTES = 4 * 1024 * 1024;
const DEFAULT_API_VERSION = "6.0";

export type TfsFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface TfsClientRuntime {
  fetchImpl: TfsFetch;
  env: NodeJS.ProcessEnv;
}

function userError(message: string, suggestions?: string[]): HunkExtensionUserError {
  return new HunkExtensionUserError(message, {
    suggestions: suggestions ?? [
      "Set TFS_PAT (and TFS_URL unless you pass a full PR URL).",
      "Run `hunk pr-review --help` for accepted forms. (`hunk tfs` is an alias.)",
    ],
  });
}

/** Strip trailing slashes from the collection URL. */
export function normalizeCollectionUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (!trimmed) {
    throw userError("TFS_URL is empty.");
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw userError(`Invalid TFS_URL: ${raw}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw userError("TFS_URL must be an http(s) URL.");
  }
  if (parsed.username || parsed.password) {
    throw userError("TFS_URL must not embed credentials.");
  }
  return trimmed;
}

/** Resolve collection URL + PAT. Project/repo are optional (looked up by PR id). */
export function resolveConnection(
  env: NodeJS.ProcessEnv,
  overrides: {
    project?: string;
    repository?: string;
    url?: string;
    apiVersion?: string;
  } = {},
): TfsConnection {
  const urlRaw = overrides.url ?? env.TFS_URL;
  const pat = env.TFS_PAT;
  const project = (overrides.project ?? env.TFS_PROJECT)?.trim() || "";
  const repository = (overrides.repository ?? env.TFS_REPO)?.trim() || "";
  const apiVersion = overrides.apiVersion ?? env.TFS_API_VERSION ?? DEFAULT_API_VERSION;

  if (!pat?.trim()) throw userError("Missing TFS_PAT.");
  if (!urlRaw?.trim()) {
    throw userError("Missing TFS_URL.", [
      "Set TFS_URL, or pass a full PR URL so the collection is taken from the link.",
    ]);
  }
  if (!apiVersion.trim()) throw userError("TFS_API_VERSION is empty.");

  return {
    url: normalizeCollectionUrl(urlRaw),
    pat: pat.trim(),
    project,
    repository,
    apiVersion: apiVersion.trim(),
  };
}

function collectionApiUrl(
  connection: Pick<TfsConnection, "url" | "apiVersion">,
  suffix: string,
  query: Record<string, string | number | undefined> = {},
): URL {
  const url = new URL(`${connection.url}${suffix}`);
  url.searchParams.set("api-version", connection.apiVersion);
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    url.searchParams.set(key, String(value));
  }
  return url;
}

function basicAuthHeader(pat: string): string {
  try {
    return `Basic ${Buffer.from(`:${pat}`, "utf8").toString("base64")}`;
  } catch {
    throw userError("TFS_PAT could not be encoded for HTTP Basic auth.");
  }
}

function tfsHeaders(connection: TfsConnection, accept = "application/json"): Headers {
  const headers = new Headers({
    Accept: accept,
    "User-Agent": "hunk-tfs",
  });
  try {
    headers.set("Authorization", basicAuthHeader(connection.pat));
  } catch (error) {
    if (error instanceof HunkExtensionUserError) throw error;
    throw userError("TFS_PAT contains characters that cannot be sent in an HTTP header.");
  }
  return headers;
}

function encodePathSegment(value: string): string {
  return encodeURIComponent(value);
}

function apiUrl(
  connection: TfsConnection,
  project: string,
  repository: string,
  suffix: string,
  query: Record<string, string | number | undefined> = {},
): URL {
  const base = `${connection.url}/${encodePathSegment(project)}/_apis/git/repositories/${encodePathSegment(repository)}${suffix}`;
  const url = new URL(base);
  url.searchParams.set("api-version", connection.apiVersion);
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    url.searchParams.set(key, String(value));
  }
  return url;
}

async function readBoundedBytes(
  response: Response,
  signal: AbortSignal,
  maxBytes: number,
  label: string,
): Promise<Uint8Array> {
  if (!response.body) {
    const buffer = new Uint8Array(await response.arrayBuffer());
    if (buffer.byteLength > maxBytes) {
      throw userError(`${label} exceeded ${maxBytes.toLocaleString()} bytes.`);
    }
    return buffer;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    if (signal.aborted) {
      await reader.cancel().catch(() => undefined);
      throw userError("TFS request was cancelled.");
    }
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw userError(`${label} exceeded ${maxBytes.toLocaleString()} bytes.`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function responseError(response: Response, target: TfsPullRequestTarget): HunkExtensionUserError {
  const name =
    target.project === "collection" && target.repository === "lookup"
      ? `#${target.id}`
      : `${target.project}/${target.repository}#${target.id}`;
  if (response.status === 401) {
    return userError(`TFS rejected the configured PAT for ${name}.`, [
      "Refresh TFS_PAT and confirm it has Code (Read) scope.",
    ]);
  }
  if (response.status === 403) {
    return userError(`TFS denied access to ${name}.`, [
      "Check project/repo permissions for the PAT identity.",
    ]);
  }
  if (response.status === 404) {
    return userError(`TFS could not find pull request ${name}.`, [
      "Check the pull-request id and that TFS_URL points at the right collection.",
    ]);
  }
  return userError(`TFS returned HTTP ${response.status} for ${name}.`);
}

async function tfsGetJson(
  connection: TfsConnection,
  url: URL,
  signal: AbortSignal,
  target: TfsPullRequestTarget,
  maxBytes: number,
  label: string,
  fetchImpl: TfsFetch,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: tfsHeaders(connection),
      signal,
      redirect: "manual",
    });
  } catch (error) {
    if (signal.aborted) throw userError("TFS request was cancelled.");
    const detail = error instanceof Error ? error.message : "network error";
    throw userError(`Failed to reach TFS (${label}): ${detail}`, [
      "Confirm TFS_URL is reachable from this machine.",
    ]);
  }

  if (response.status >= 300 && response.status < 400) {
    throw userError("TFS redirected the request; refusing to forward credentials.");
  }
  if (!response.ok) throw responseError(response, target);

  const bytes = await readBoundedBytes(response, signal, maxBytes, label);
  const text = new TextDecoder("utf-8").decode(bytes);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw userError(`TFS returned malformed JSON for ${label}.`);
  }
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw userError(`TFS returned malformed ${label}.`);
  }
  return value as Record<string, unknown>;
}

function readString(container: Record<string, unknown>, field: string): string | undefined {
  const value = container[field];
  return typeof value === "string" ? value : undefined;
}

function shortRef(refName: string | undefined): string | undefined {
  if (!refName) return undefined;
  return refName.replace(/^refs\/heads\//, "").replace(/^refs\/tags\//, "");
}

/** Map Azure DevOps PR status onto Hunk's change-request state. */
export function mapPullRequestState(status: string): "open" | "closed" | "merged" {
  const normalized = status.toLowerCase();
  if (normalized === "active") return "open";
  if (normalized === "completed") return "merged";
  return "closed";
}

export function parsePullRequest(value: unknown): TfsPullRequest {
  const candidate = asRecord(value, "pull-request metadata");
  const pullRequestId = candidate.pullRequestId;
  const title = readString(candidate, "title");
  const status = readString(candidate, "status");
  if (typeof pullRequestId !== "number" || !Number.isSafeInteger(pullRequestId) || pullRequestId < 1) {
    throw userError("TFS returned a pull request without a valid id.");
  }
  if (!title?.trim()) throw userError("TFS returned a pull request without a title.");
  if (!status?.trim()) throw userError("TFS returned a pull request without a status.");

  const createdByRaw = candidate.createdBy;
  let createdBy: TfsPullRequest["createdBy"];
  if (typeof createdByRaw === "object" && createdByRaw !== null && !Array.isArray(createdByRaw)) {
    const author = createdByRaw as Record<string, unknown>;
    createdBy = {
      displayName: readString(author, "displayName"),
      uniqueName: readString(author, "uniqueName"),
    };
  }

  const readCommit = (field: string): TfsPullRequest["lastMergeSourceCommit"] => {
    const raw = candidate[field];
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
    const commitId = readString(raw as Record<string, unknown>, "commitId");
    return commitId ? { commitId } : undefined;
  };

  let project: string | undefined;
  let repository: string | undefined;
  const repositoryRaw = candidate.repository;
  if (typeof repositoryRaw === "object" && repositoryRaw !== null && !Array.isArray(repositoryRaw)) {
    const repo = repositoryRaw as Record<string, unknown>;
    repository = readString(repo, "name")?.trim();
    const projectRaw = repo.project;
    if (typeof projectRaw === "object" && projectRaw !== null && !Array.isArray(projectRaw)) {
      project = readString(projectRaw as Record<string, unknown>, "name")?.trim();
    }
  }

  return {
    pullRequestId,
    title: title.trim(),
    status: status.trim(),
    isDraft: typeof candidate.isDraft === "boolean" ? candidate.isDraft : undefined,
    creationDate: readString(candidate, "creationDate"),
    createdBy,
    sourceRefName: readString(candidate, "sourceRefName"),
    targetRefName: readString(candidate, "targetRefName"),
    lastMergeSourceCommit: readCommit("lastMergeSourceCommit"),
    lastMergeTargetCommit: readCommit("lastMergeTargetCommit"),
    url: readString(candidate, "url"),
    project,
    repository,
  };
}

export function webPullRequestUrl(connection: TfsConnection, target: TfsPullRequestTarget): string {
  return `${connection.url}/${encodeURIComponent(target.project)}/_git/${encodeURIComponent(target.repository)}/pullrequest/${target.id}`;
}

/**
 * Collection-scoped lookup: GET {collection}/_apis/git/pullrequests/{id}
 * Returns project + repository from the PR payload — no prior knowledge required.
 */
export async function fetchPullRequestById(
  connection: Pick<TfsConnection, "url" | "pat" | "apiVersion">,
  pullRequestId: string,
  signal: AbortSignal,
  fetchImpl: TfsFetch = fetch,
): Promise<TfsPullRequest & { project: string; repository: string }> {
  const target: TfsPullRequestTarget = {
    project: "collection",
    repository: "lookup",
    id: pullRequestId,
  };
  const url = collectionApiUrl(connection, `/_apis/git/pullrequests/${pullRequestId}`);
  const json = await tfsGetJson(
    connection as TfsConnection,
    url,
    signal,
    target,
    MAX_METADATA_BYTES,
    "pull-request lookup",
    fetchImpl,
  );
  const pr = parsePullRequest(json);
  if (!pr.project || !pr.repository) {
    throw userError(`TFS PR #${pullRequestId} did not include project/repository names.`, [
      "Pass a full PR URL, or set TFS_PROJECT and TFS_REPO.",
    ]);
  }
  return { ...pr, project: pr.project, repository: pr.repository };
}

/** Fetch active PRs scoped to one repository, including drafts. */
export async function fetchActivePullRequests(
  connection: TfsConnection,
  project: string,
  repository: string,
  signal: AbortSignal,
  fetchImpl: TfsFetch = fetch,
): Promise<TfsPullRequest[]> {
  const target: TfsPullRequestTarget = { project, repository, id: "active" };
  const url = apiUrl(connection, project, repository, "/pullRequests", {
    "searchCriteria.status": "active",
  });
  const json = await tfsGetJson(
    connection,
    url,
    signal,
    target,
    MAX_METADATA_BYTES,
    "active pull requests",
    fetchImpl,
  );
  const body = asRecord(json, "active pull requests");
  if (!Array.isArray(body.value)) {
    throw userError("TFS returned malformed active pull-request data.");
  }
  return body.value
    .map(parsePullRequest)
    .filter((pr) => pr.status.trim().toLowerCase() === "active");
}

export async function fetchPullRequest(
  connection: TfsConnection,
  target: TfsPullRequestTarget,
  signal: AbortSignal,
  fetchImpl: TfsFetch = fetch,
): Promise<TfsPullRequest> {
  const url = apiUrl(connection, target.project, target.repository, `/pullRequests/${target.id}`);
  const json = await tfsGetJson(
    connection,
    url,
    signal,
    target,
    MAX_METADATA_BYTES,
    "pull-request metadata",
    fetchImpl,
  );
  return parsePullRequest(json);
}

function parseChangeType(raw: unknown): TfsChangeType {
  const text = typeof raw === "string" ? raw.toLowerCase() : String(raw ?? "").toLowerCase();
  if (text.includes("delete")) return "delete";
  if (text.includes("add")) return "add";
  if (text.includes("rename") || text.includes("sourceRename") || text.includes("targetRename")) {
    return "rename";
  }
  if (text.includes("edit")) return "edit";
  return "other";
}

function normalizeRepoPath(path: string): string {
  return path.replace(/^\/+/, "");
}

/** List every file changed between the PR target and source commits. */
export async function fetchPullRequestChanges(
  connection: TfsConnection,
  target: TfsPullRequestTarget,
  baseCommit: string,
  headCommit: string,
  signal: AbortSignal,
  fetchImpl: TfsFetch = fetch,
): Promise<TfsFileChange[]> {
  const changes: TfsFileChange[] = [];
  let continuationToken: string | undefined;

  do {
    const url = apiUrl(connection, target.project, target.repository, "/diffs/commits", {
      baseVersion: baseCommit,
      baseVersionType: "commit",
      targetVersion: headCommit,
      targetVersionType: "commit",
      $top: 2000,
      continuationToken,
    });

    const json = await tfsGetJson(
      connection,
      url,
      signal,
      target,
      MAX_METADATA_BYTES,
      "pull-request diff",
      fetchImpl,
    );
    const body = asRecord(json, "pull-request diff");
    const rawChanges = body.changes;
    if (!Array.isArray(rawChanges)) {
      throw userError("TFS returned a diff without a changes array.");
    }

    for (const entry of rawChanges) {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
      const change = entry as Record<string, unknown>;
      const itemRaw = change.item;
      if (typeof itemRaw !== "object" || itemRaw === null || Array.isArray(itemRaw)) continue;
      const item = itemRaw as Record<string, unknown>;
      if (item.isFolder === true) continue;
      const path = readString(item, "path");
      if (!path) continue;
      const originalPath = readString(change, "sourceServerItem") ?? readString(change, "originalPath");
      changes.push({
        path: normalizeRepoPath(path),
        originalPath: originalPath ? normalizeRepoPath(originalPath) : undefined,
        changeType: parseChangeType(change.changeType),
      });
    }

    const next = body.continuationToken;
    continuationToken = typeof next === "string" && next.length > 0 ? next : undefined;
  } while (continuationToken);

  return changes;
}

/**
 * Fetch one blob as UTF-8 text at a commit.
 * Returns null when the path does not exist at that commit (404) or looks binary.
 */
export async function fetchItemText(
  connection: TfsConnection,
  target: TfsPullRequestTarget,
  path: string,
  commitId: string,
  signal: AbortSignal,
  fetchImpl: TfsFetch = fetch,
): Promise<string | null> {
  const url = apiUrl(connection, target.project, target.repository, "/items", {
    path: `/${path}`,
    "versionDescriptor.version": commitId,
    "versionDescriptor.versionType": "commit",
    includeContent: "true",
  });

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: tfsHeaders(connection),
      signal,
      redirect: "manual",
    });
  } catch (error) {
    if (signal.aborted) throw userError("TFS request was cancelled.");
    const detail = error instanceof Error ? error.message : "network error";
    throw userError(`Failed to fetch ${path}: ${detail}`);
  }

  if (response.status >= 300 && response.status < 400) {
    throw userError("TFS redirected an item request; refusing to forward credentials.");
  }
  if (response.status === 404) return null;
  if (!response.ok) throw responseError(response, target);

  const bytes = await readBoundedBytes(response, signal, MAX_ITEM_BYTES, path);
  const text = new TextDecoder("utf-8").decode(bytes);

  // Items with includeContent=true usually return JSON; accept raw text too.
  if (text.trimStart().startsWith("{")) {
    try {
      const json = JSON.parse(text) as Record<string, unknown>;
      const metadata = json.contentMetadata;
      if (typeof metadata === "object" && metadata !== null && !Array.isArray(metadata)) {
        if ((metadata as Record<string, unknown>).isBinary === true) return null;
      }
      const content = json.content;
      if (typeof content !== "string") return null;
      if (content.includes("\u0000")) return null;
      return content;
    } catch {
      // fall through to treat as plain text
    }
  }

  if (text.includes("\u0000")) return null;
  return text;
}

function parseThreadPosition(threadContext: unknown): TfsThreadPosition | null {
  if (typeof threadContext !== "object" || threadContext === null || Array.isArray(threadContext)) {
    return null;
  }
  const ctx = threadContext as Record<string, unknown>;
  const filePathRaw = readString(ctx, "filePath");
  if (!filePathRaw) return null;
  const filePath = normalizeRepoPath(filePathRaw);

  const readLine = (pos: unknown): number | null => {
    if (typeof pos !== "object" || pos === null || Array.isArray(pos)) return null;
    const line = (pos as Record<string, unknown>).line;
    return typeof line === "number" && Number.isSafeInteger(line) && line > 0 ? line : null;
  };

  const rightStart = readLine(ctx.rightFileStart);
  if (rightStart !== null) {
    const rightEnd = readLine(ctx.rightFileEnd);
    return {
      filePath,
      side: "new",
      line: rightStart,
      endLine: rightEnd !== null && rightEnd >= rightStart ? rightEnd : rightStart,
    };
  }

  const leftStart = readLine(ctx.leftFileStart);
  if (leftStart !== null) {
    const leftEnd = readLine(ctx.leftFileEnd);
    return {
      filePath,
      side: "old",
      line: leftStart,
      endLine: leftEnd !== null && leftEnd >= leftStart ? leftEnd : leftStart,
    };
  }

  return { filePath, side: "new", line: 1, endLine: 1 };
}

function isSystemCommentType(value: unknown): boolean {
  if (typeof value === "number") return value === 3;
  if (typeof value === "string") return value.toLowerCase() === "system";
  return false;
}

export function parseThreads(value: unknown): TfsReviewThread[] {
  const body = asRecord(value, "pull-request threads");
  const rawThreads = body.value;
  if (!Array.isArray(rawThreads)) {
    throw userError("TFS returned threads without a value array.");
  }

  const threads: TfsReviewThread[] = [];
  for (const entry of rawThreads) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
    const thread = entry as Record<string, unknown>;
    if (thread.isDeleted === true) continue;
    const id = thread.id;
    if (typeof id !== "number" || !Number.isSafeInteger(id)) continue;

    const commentsRaw = thread.comments;
    if (!Array.isArray(commentsRaw)) continue;

    const comments: TfsThreadComment[] = [];
    for (const commentRaw of commentsRaw) {
      if (typeof commentRaw !== "object" || commentRaw === null || Array.isArray(commentRaw)) continue;
      const comment = commentRaw as Record<string, unknown>;
      if (comment.isDeleted === true) continue;
      if (isSystemCommentType(comment.commentType)) continue;
      const content = readString(comment, "content");
      if (!content || !content.trim()) continue;
      const commentId = comment.id;
      if (typeof commentId !== "number") continue;
      let author = "unknown";
      const authorRaw = comment.author;
      if (typeof authorRaw === "object" && authorRaw !== null && !Array.isArray(authorRaw)) {
        author =
          readString(authorRaw as Record<string, unknown>, "displayName") ??
          readString(authorRaw as Record<string, unknown>, "uniqueName") ??
          "unknown";
      }
      comments.push({
        id: commentId,
        author,
        content,
        publishedDate: readString(comment, "publishedDate"),
      });
    }

    if (comments.length === 0) continue;

    threads.push({
      id,
      status: (readString(thread, "status") ?? "unknown").trim().toLowerCase() || "unknown",
      position: parseThreadPosition(thread.threadContext),
      comments,
    });
  }

  return threads;
}

export async function fetchPullRequestThreads(
  connection: TfsConnection,
  target: TfsPullRequestTarget,
  signal: AbortSignal,
  fetchImpl: TfsFetch = fetch,
): Promise<TfsReviewThread[]> {
  const url = apiUrl(connection, target.project, target.repository, `/pullRequests/${target.id}/threads`);
  const json = await tfsGetJson(
    connection,
    url,
    signal,
    target,
    MAX_THREADS_BYTES,
    "pull-request threads",
    fetchImpl,
  );
  return parseThreads(json);
}

export { shortRef };
