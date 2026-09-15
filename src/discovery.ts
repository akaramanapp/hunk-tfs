import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { HunkExtensionUserError } from "hunkdiff/extension";
import type { TfsPullRequest } from "./types.ts";
import { shortRef } from "./tfs-client.ts";

export interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
  readonly notFound?: boolean;
}

export type CommandRunner = (
  executable: string,
  args: readonly string[],
  options: { cwd: string; signal: AbortSignal },
) => Promise<CommandResult>;

export interface DiscoveryRuntime {
  readonly run: CommandRunner;
  readonly interactive: boolean;
  readonly prompt: (question: string) => Promise<string>;
}

export interface ParsedTfsRemote {
  readonly collectionUrl: string;
  readonly project: string;
  readonly repository: string;
}

export interface GitDiscovery {
  readonly remoteName: string;
  readonly remoteUrl: string;
  readonly repository: ParsedTfsRemote;
  readonly branchName?: string;
  readonly sourceBranch?: string;
}

function error(message: string, suggestions: string[] = []): HunkExtensionUserError {
  return new HunkExtensionUserError(message, { suggestions });
}

export const defaultCommandRunner: CommandRunner = (executable, args, options) =>
  new Promise((resolve, reject) => {
    const child = spawn(executable, [...args], {
      cwd: options.cwd,
      signal: options.signal,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", (cause: Error) => {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") resolve({ stdout, stderr, code: 127, notFound: true });
      else reject(cause);
    });
    child.on("close", (code) => resolve({ stdout, stderr, code: code ?? 1 }));
  });

export function defaultDiscoveryRuntime(): DiscoveryRuntime {
  return {
    run: defaultCommandRunner,
    interactive: process.stdin.isTTY === true && process.stderr.isTTY === true,
    prompt: async (question) => {
      const terminal = createInterface({ input: process.stdin, output: process.stderr });
      try {
        return await terminal.question(question);
      } finally {
        terminal.close();
      }
    },
  };
}

function cleanDisplay(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").trim();
}

function decodeSegment(value: string, remote: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw unsupportedRemote(remote);
  }
}

function displayRemote(remote: string): string {
  try {
    const parsed = new URL(remote);
    if (parsed.password) parsed.password = "***";
    return cleanDisplay(parsed.toString());
  } catch {
    return cleanDisplay(remote);
  }
}

function unsupportedRemote(remote: string): HunkExtensionUserError {
  return error(`Unsupported or malformed TFS remote: ${displayRemote(remote)}`, [
    "Use an HTTP(S) remote shaped as {collection}/{project}/_git/{repository}.",
    "Or supply an explicit pull-request locator to `hunk pr-review`.",
  ]);
}

/** Parse an HTTP(S) TFS repository remote without retaining browser query data. */
export function parseTfsRepositoryRemote(remote: string): ParsedTfsRemote {
  let url: URL;
  try {
    url = new URL(remote);
  } catch {
    throw unsupportedRemote(remote);
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.password) {
    throw unsupportedRemote(remote);
  }

  const encoded = url.pathname.split("/").filter(Boolean);
  const decoded = encoded.map((part) => decodeSegment(part, remote));
  const gitIndexes = decoded
    .map((part, index) => part.toLowerCase() === "_git" ? index : -1)
    .filter((index) => index >= 0);
  if (gitIndexes.length !== 1) throw unsupportedRemote(remote);
  const gitIndex = gitIndexes[0]!;
  if (gitIndex < 1 || gitIndex + 1 !== encoded.length - 1) throw unsupportedRemote(remote);

  const project = decoded[gitIndex - 1]!;
  const repository = decoded[gitIndex + 1]!;
  if (!project || !repository) throw unsupportedRemote(remote);
  const collectionPath = encoded.slice(0, gitIndex - 1).join("/");
  const collectionUrl = `${url.origin}${collectionPath ? `/${collectionPath}` : ""}`;
  return { collectionUrl, project, repository };
}

async function git(
  runtime: DiscoveryRuntime,
  cwd: string,
  signal: AbortSignal,
  args: readonly string[],
): Promise<CommandResult> {
  if (signal.aborted) throw error("Pull-request discovery was cancelled.");
  try {
    return await runtime.run("git", args, { cwd, signal });
  } catch {
    if (signal.aborted) throw error("Pull-request discovery was cancelled.");
    throw error("Git pull-request discovery failed.");
  }
}

async function choose<T>(
  heading: string,
  choices: readonly { value: T; label: string }[],
  cwd: string,
  signal: AbortSignal,
  runtime: DiscoveryRuntime,
  write: (text: string) => Promise<unknown>,
): Promise<T> {
  const labels = choices.map((choice, index) => `${index + 1}. ${cleanDisplay(choice.label)}`);
  if (!runtime.interactive) {
    await write(`${heading} requires a choice:\n${labels.map((label) => `  ${label}`).join("\n")}\n`);
    throw error(`Cannot select ${heading.toLowerCase()} in a non-interactive terminal.`);
  }
  const gum: CommandResult = await runtime.run(
    "gum",
    ["choose", ...labels],
    { cwd, signal },
  ).catch((): CommandResult => ({ stdout: "", stderr: "", code: 1 }));
  if (!gum.notFound) {
    if (gum.code !== 0 || !gum.stdout.trim()) throw error(`${heading} selection was cancelled.`);
    const selected = labels.indexOf(gum.stdout.trim());
    if (selected < 0) throw error(`${heading} selection was invalid.`);
    return choices[selected]!.value;
  }

  await write(`${heading}:\n${labels.map((label) => `  ${label}`).join("\n")}\n`);
  const answer = (await runtime.prompt(`Choose 1-${choices.length}: `)).trim();
  if (!/^\d+$/.test(answer)) throw error(`${heading} selection was cancelled or invalid.`);
  const index = Number(answer) - 1;
  if (index < 0 || index >= choices.length) throw error(`${heading} selection was invalid.`);
  return choices[index]!.value;
}

/** Validate Git state, choose a remote, and derive repository identity and branch matching data. */
export async function discoverGitRepository(
  cwd: string,
  signal: AbortSignal,
  runtime: DiscoveryRuntime,
  write: (text: string) => Promise<unknown>,
): Promise<GitDiscovery> {
  const workTree = await git(runtime, cwd, signal, ["rev-parse", "--is-inside-work-tree"]);
  if (workTree.code !== 0 || workTree.stdout.trim() !== "true") {
    throw error("Cannot auto-discover a pull request because the current directory is not inside a Git repository.", [
      "Change into the repository, or supply an explicit PR locator.",
    ]);
  }

  const remoteResult = await git(runtime, cwd, signal, ["remote"]);
  const remotes = remoteResult.stdout.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
  if (remoteResult.code !== 0 || remotes.length === 0) {
    throw error("Cannot auto-discover a pull request because this Git repository has no remotes.", [
      "Configure an HTTP(S) TFS remote, or supply an explicit PR locator.",
    ]);
  }

  const branchResult = await git(runtime, cwd, signal, ["branch", "--show-current"]);
  const branchName = branchResult.code === 0 ? branchResult.stdout.trim() || undefined : undefined;
  let upstreamRemote: string | undefined;
  let upstreamBranch: string | undefined;
  if (branchName) {
    const [remote, merge] = await Promise.all([
      git(runtime, cwd, signal, ["config", "--get", `branch.${branchName}.remote`]),
      git(runtime, cwd, signal, ["config", "--get", `branch.${branchName}.merge`]),
    ]);
    const configuredRemote = remote.code === 0 ? remote.stdout.trim() : "";
    if (configuredRemote && configuredRemote !== "." && remotes.includes(configuredRemote)) {
      upstreamRemote = configuredRemote;
    }
    if (merge.code === 0) upstreamBranch = shortRef(merge.stdout.trim());
  }

  let remoteName = upstreamRemote;
  if (!remoteName && remotes.includes("origin")) remoteName = "origin";
  if (!remoteName && remotes.length === 1) remoteName = remotes[0];
  if (!remoteName) {
    remoteName = await choose(
      "Git remote",
      remotes.map((name) => ({ value: name, label: name })),
      cwd,
      signal,
      runtime,
      write,
    );
  }

  const urlResult = await git(runtime, cwd, signal, ["remote", "get-url", remoteName]);
  const remoteUrl = urlResult.stdout.trim();
  if (urlResult.code !== 0 || !remoteUrl) throw unsupportedRemote(remoteName);
  return {
    remoteName,
    remoteUrl,
    repository: parseTfsRepositoryRemote(remoteUrl),
    branchName,
    sourceBranch: upstreamBranch ?? branchName,
  };
}

function createdTime(pr: TfsPullRequest): number {
  const time = pr.creationDate ? Date.parse(pr.creationDate) : Number.NaN;
  return Number.isFinite(time) ? time : 0;
}

export function formatPullRequestCandidate(pr: TfsPullRequest): string {
  const draft = pr.isDraft === true ? "[draft] " : "";
  const source = cleanDisplay(shortRef(pr.sourceRefName) ?? "unknown");
  const target = cleanDisplay(shortRef(pr.targetRefName) ?? "unknown");
  const author = cleanDisplay(pr.createdBy?.displayName ?? pr.createdBy?.uniqueName ?? "unknown");
  return `${draft}#${pr.pullRequestId} — ${cleanDisplay(pr.title)} — ${source} → ${target} — ${author}`;
}

/** Apply branch preference/newest ordering and select an active PR. */
export async function selectPullRequest(
  pullRequests: readonly TfsPullRequest[],
  sourceBranch: string | undefined,
  cwd: string,
  signal: AbortSignal,
  runtime: DiscoveryRuntime,
  write: (text: string) => Promise<unknown>,
): Promise<TfsPullRequest> {
  const active = pullRequests.filter((pr) => pr.status.trim().toLowerCase() === "active");
  if (active.length === 0) throw error("No active pull requests are available for selection.");
  const matches = sourceBranch
    ? active.filter((pr) => shortRef(pr.sourceRefName) === sourceBranch)
    : [];
  const candidates = (matches.length > 0 ? matches : active)
    .slice()
    .sort((a, b) => createdTime(b) - createdTime(a) || b.pullRequestId - a.pullRequestId);
  if (candidates.length === 1) return candidates[0]!;
  return choose(
    "Pull request",
    candidates.map((pr) => ({ value: pr, label: formatPullRequestCandidate(pr) })),
    cwd,
    signal,
    runtime,
    write,
  );
}
