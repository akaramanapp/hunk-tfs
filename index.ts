import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HunkExtensionUserError,
  type ExtensionChangeRequestReviewDescriptor,
  type ExtensionCliCommandHandler,
  type ExtensionFactory,
  type ExtensionLineHighlight,
} from "hunkdiff/extension";
import { parseTfsPrInvocation, TFS_PR_HELP } from "./src/cli.ts";
import { buildUnifiedPatch } from "./src/build-patch.ts";
import { buildAgentContextFromThreads } from "./src/agent-context.ts";
import { CommentsPane } from "./src/comments-pane.tsx";
import {
  defaultDiscoveryRuntime,
  discoverGitRepository,
  selectPullRequest,
  type CommandRunner,
} from "./src/discovery.ts";
import { loadTfsDotEnv } from "./src/load-env.ts";
import { clearThreads, setThreads, threadsForPath } from "./src/threads-store.ts";
import {
  fetchActivePullRequests,
  fetchItemText,
  fetchPullRequest,
  fetchPullRequestById,
  fetchPullRequestChanges,
  fetchPullRequestThreads,
  mapPullRequestState,
  resolveConnection,
  shortRef,
  webPullRequestUrl,
  type TfsFetch,
} from "./src/tfs-client.ts";
import type { TfsConnection, TfsPullRequest, TfsPullRequestTarget } from "./src/types.ts";

const MAX_PATCH_BYTES = 64 * 1024 * 1024;

export interface TfsPrExtensionRuntime {
  fetchImpl: TfsFetch;
  env: NodeJS.ProcessEnv;
  temporaryRoot: string;
  commandRunner: CommandRunner;
  interactive: boolean;
  prompt: (question: string) => Promise<string>;
}

function toReviewDescriptor(
  connection: { url: string; project: string; repository: string; pat: string; apiVersion: string },
  target: TfsPullRequestTarget,
  title: string,
  status: string,
  isDraft: boolean | undefined,
  author: string | undefined,
  base: string | undefined,
  head: string | undefined,
): ExtensionChangeRequestReviewDescriptor {
  const pageUrl = webPullRequestUrl(connection, target);
  // Hunk only accepts credential-free HTTPS URLs on the review descriptor.
  const url = pageUrl.startsWith("https://") ? pageUrl : undefined;

  return {
    kind: "change-request",
    provider: "hunk-tfs",
    title,
    url,
    id: `#${target.id}`,
    repository: `${target.project}/${target.repository}`,
    author,
    base,
    head,
    state: mapPullRequestState(status),
    draft: isDraft === true,
  };
}

async function writeTemporaryPatch(
  target: TfsPullRequestTarget,
  text: string,
  temporaryRoot: string,
  retainedDirectories: Set<string>,
): Promise<{ patchPath: string; directory: string }> {
  const bytes = new TextEncoder().encode(text);
  if (bytes.byteLength > MAX_PATCH_BYTES) {
    throw new HunkExtensionUserError(
      `Generated patch exceeded ${MAX_PATCH_BYTES.toLocaleString()} bytes.`,
    );
  }

  const directory = await mkdtemp(join(temporaryRoot, "hunk-tfs-"));
  retainedDirectories.add(directory);
  try {
    await chmod(directory, 0o700);
    const safeRepo = target.repository.replace(/[^A-Za-z0-9_.-]/g, "-");
    const patchPath = join(directory, `${safeRepo}-pr-${target.id}.diff`);
    await writeFile(patchPath, bytes, { flag: "wx", mode: 0o600 });
    return { patchPath, directory };
  } catch (error) {
    retainedDirectories.delete(directory);
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

/** Build the hunk-tfs extension with injectable runtime boundaries for tests. */
export function createHunkTfsExtension(
  overrides: Partial<TfsPrExtensionRuntime> = {},
): ExtensionFactory {
  const discoveryDefaults = defaultDiscoveryRuntime();
  const runtime: TfsPrExtensionRuntime = {
    fetchImpl: overrides.fetchImpl ?? fetch,
    env: overrides.env ?? process.env,
    temporaryRoot: overrides.temporaryRoot ?? tmpdir(),
    commandRunner: overrides.commandRunner ?? discoveryDefaults.run,
    interactive: overrides.interactive ?? discoveryDefaults.interactive,
    prompt: overrides.prompt ?? discoveryDefaults.prompt,
  };
  const retainedDirectories = new Set<string>();
  let activeRegistries = 0;

  return (hunk) => {
    activeRegistries += 1;
    let retired = false;

    const handler: ExtensionCliCommandHandler = async (args, ctx) => {
      const invocation = parseTfsPrInvocation(args);
      if (invocation.help) {
        await ctx.stdout.write(TFS_PR_HELP);
        return { kind: "exit" };
      }

      const env: NodeJS.ProcessEnv = { ...runtime.env };
      loadTfsDotEnv(env, ctx.cwd);

      let connection: TfsConnection;
      let target: TfsPullRequestTarget;
      let pr: TfsPullRequest;

      if (invocation.locator) {
        const locator = invocation.locator;
        const hintedProject = invocation.project ?? locator.project;
        const hintedRepository = invocation.repository ?? locator.repository;
        const base = resolveConnection(env, {
          project: hintedProject,
          repository: hintedRepository,
          url: locator.collectionUrl,
        });
        if (new URL(base.url).protocol === "http:") {
          await ctx.stderr.write(
            "Warning: this TFS server uses HTTP; TFS_PAT and review data will be sent without transport encryption.\n",
          );
        }

        await ctx.stderr.write(`Looking up TFS pull request #${locator.id}…\n`);
        const resolved = await fetchPullRequestById(
          base,
          locator.id,
          ctx.signal,
          runtime.fetchImpl,
        );
        if (hintedProject && hintedProject !== resolved.project) {
          throw new HunkExtensionUserError(
            `PR #${locator.id} belongs to project "${resolved.project}", not "${hintedProject}".`,
          );
        }
        if (hintedRepository && hintedRepository !== resolved.repository) {
          throw new HunkExtensionUserError(
            `PR #${locator.id} belongs to repository "${resolved.repository}", not "${hintedRepository}".`,
          );
        }
        connection = { ...base, project: resolved.project, repository: resolved.repository };
        target = { project: resolved.project, repository: resolved.repository, id: locator.id };
        pr = resolved;
      } else {
        const discovered = await discoverGitRepository(
          ctx.cwd,
          ctx.signal,
          {
            run: runtime.commandRunner,
            interactive: runtime.interactive,
            prompt: runtime.prompt,
          },
          (text) => ctx.stderr.write(text),
        );
        const repository = discovered.repository;
        if (invocation.project && invocation.project !== repository.project) {
          throw new HunkExtensionUserError(
            `Selected remote belongs to project "${repository.project}", not "${invocation.project}".`,
          );
        }
        if (invocation.repository && invocation.repository !== repository.repository) {
          throw new HunkExtensionUserError(
            `Selected remote belongs to repository "${repository.repository}", not "${invocation.repository}".`,
          );
        }
        connection = resolveConnection(env, {
          url: repository.collectionUrl,
          project: repository.project,
          repository: repository.repository,
        });
        if (new URL(connection.url).protocol === "http:") {
          await ctx.stderr.write(
            "Warning: this TFS server uses HTTP; TFS_PAT and review data will be sent without transport encryption.\n",
          );
        }
        await ctx.stderr.write(
          `Finding active pull requests for ${repository.project}/${repository.repository}…\n`,
        );
        const active = await fetchActivePullRequests(
          connection,
          repository.project,
          repository.repository,
          ctx.signal,
          runtime.fetchImpl,
        );
        if (active.length === 0) {
          throw new HunkExtensionUserError(
            `No active pull requests exist for repository "${repository.repository}".`,
            { suggestions: ["Create an active PR, or supply an explicit PR locator."] },
          );
        }
        const selected = await selectPullRequest(
          active,
          discovered.sourceBranch,
          ctx.cwd,
          ctx.signal,
          {
            run: runtime.commandRunner,
            interactive: runtime.interactive,
            prompt: runtime.prompt,
          },
          (text) => ctx.stderr.write(text),
        );
        target = {
          project: repository.project,
          repository: repository.repository,
          id: String(selected.pullRequestId),
        };
        pr = await fetchPullRequest(connection, target, ctx.signal, runtime.fetchImpl);
      }

      await ctx.stderr.write(`Resolved ${target.project}/${target.repository}#${target.id}…\n`);

      const baseCommit = pr.lastMergeTargetCommit?.commitId;
      const headCommit = pr.lastMergeSourceCommit?.commitId;
      if (!baseCommit || !headCommit) {
        throw new HunkExtensionUserError(
          "This pull request is missing merge commit ids (base/head).",
          {
            suggestions: [
              "Ensure the PR has been created against a Git repository and has commits.",
            ],
          },
        );
      }

      const [changes, threads] = await Promise.all([
        fetchPullRequestChanges(
          connection,
          target,
          baseCommit,
          headCommit,
          ctx.signal,
          runtime.fetchImpl,
        ),
        fetchPullRequestThreads(connection, target, ctx.signal, runtime.fetchImpl),
      ]);

      if (ctx.signal.aborted) {
        throw new HunkExtensionUserError("TFS pull-request loading was cancelled.");
      }

      setThreads(target.id, threads);
      await ctx.stderr.write(
        `Found ${changes.length} changed file${changes.length === 1 ? "" : "s"}, ${threads.length} comment thread${threads.length === 1 ? "" : "s"}.\n`,
      );

      const built = await buildUnifiedPatch(
        changes,
        baseCommit,
        headCommit,
        (path, commitId) =>
          fetchItemText(connection, target, path, commitId, ctx.signal, runtime.fetchImpl),
        (message) => {
          void ctx.stderr.write(`${message}\n`);
        },
      );

      for (const skip of built.skipped) {
        await ctx.stderr.write(`Skipping ${skip}\n`);
      }

      if (!built.text.trim()) {
        clearThreads();
        throw new HunkExtensionUserError("Generated an empty patch for this pull request.", {
          suggestions: [
            "The PR may only contain binary files, or base/head commits could not be read.",
          ],
        });
      }

      if (ctx.signal.aborted) {
        clearThreads();
        throw new HunkExtensionUserError("TFS pull-request loading was cancelled.");
      }

      const { patchPath, directory } = await writeTemporaryPatch(
        target,
        built.text,
        runtime.temporaryRoot,
        retainedDirectories,
      );

      const discardPatch = async () => {
        retainedDirectories.delete(directory);
        await rm(directory, { recursive: true, force: true });
      };

      if (ctx.signal.aborted) {
        await discardPatch();
        clearThreads();
        throw new HunkExtensionUserError("TFS pull-request loading was cancelled.");
      }

      const agentContext = buildAgentContextFromThreads(target.id, threads);
      const agentContextPath = join(directory, `pr-${target.id}-agent-context.json`);
      await writeFile(agentContextPath, `${JSON.stringify(agentContext, null, 2)}\n`, {
        flag: "wx",
        mode: 0o600,
      });

      const author = pr.createdBy?.displayName ?? pr.createdBy?.uniqueName;
      const review = toReviewDescriptor(
        connection,
        target,
        pr.title,
        pr.status,
        pr.isDraft,
        author,
        shortRef(pr.targetRefName),
        shortRef(pr.sourceRefName),
      );

      const patchBytes = new TextEncoder().encode(built.text).byteLength;
      const noteCount = agentContext.files.reduce((sum, file) => sum + file.annotations.length, 0);
      await ctx.stderr.write(
        `Opening ${patchBytes.toLocaleString()} bytes with ${noteCount} agent note${noteCount === 1 ? "" : "s"}…\n`,
      );

      return {
        kind: "delegate",
        argv: ["patch", patchPath, "--agent-context", agentContextPath, ...invocation.patchArgs],
        review,
      };
    };

    hunk.registerCliCommand(
      {
        name: "pr-review",
        summary: "Review a TFS / Azure DevOps Server pull request (hunk-tfs)",
        usage: "[url|project/repo#id|id] [--project <name>] [--repo <name>]",
      },
      handler,
    );
    hunk.registerCliCommand(
      {
        name: "tfs",
        summary: "Compatibility alias for `hunk pr-review`",
        usage: "[url|project/repo#id|id] [--project <name>] [--repo <name>]",
      },
      handler,
    );

    hunk.registerPane({
      id: "comments",
      title: "hunk-tfs",
      defaultOpen: true,
      placement: "right",
      width: { preferred: 42, min: 28, max: 72 },
      available: ({ review }) =>
        review?.kind === "change-request" && review.provider === "hunk-tfs",
      component: CommentsPane,
    });

    hunk.registerLineHighlighter({
      id: "tfs-comments",
      highlight({ file }) {
        const marks: ExtensionLineHighlight[] = [];
        for (const thread of threadsForPath(file.path)) {
          if (!thread.position) continue;
          marks.push({
            side: thread.position.side,
            line: thread.position.line,
            range: [0, 1],
            tone: thread.status === "fixed" || thread.status === "closed" ? "dim" : "warning",
          });
        }
        return marks.length > 0 ? marks : null;
      },
    });

    hunk.registerCommand(
      { id: "toggle-comments", title: "Toggle TFS comments pane", key: "ctrl+shift+c" },
      (ctx) => {
        ctx.panes.toggle("comments");
      },
    );

    hunk.on("shutdown", () => {
      if (retired) return;
      retired = true;
      activeRegistries -= 1;
      if (activeRegistries > 0) return;
      clearThreads();
      for (const directory of retainedDirectories) {
        rmSync(directory, { recursive: true, force: true });
      }
      retainedDirectories.clear();
    });
  };
}

export default createHunkTfsExtension();
