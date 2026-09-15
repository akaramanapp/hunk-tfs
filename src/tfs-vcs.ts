import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import {
  HunkExtensionUserError,
  type ExtensionChangeRequestReviewDescriptor,
  type ExtensionVcsAdapter,
  type ExtensionVcsPatchResult,
} from "hunkdiff/extension";
import type { CommandRunner } from "./discovery.ts";

export const TFS_VCS_ID = "tfs";

export const TFS_SESSION_MANIFEST_NAME = "hunk-tfs-session.json";

export interface TfsSessionManifest {
  readonly version: 1;
  readonly title: string;
  readonly patchPath: string;
  readonly repoRoot: string;
  readonly review: ExtensionChangeRequestReviewDescriptor;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isReviewDescriptor(value: unknown): value is ExtensionChangeRequestReviewDescriptor {
  if (!isRecord(value)) return false;
  return (
    value.kind === "change-request" &&
    typeof value.provider === "string" &&
    typeof value.title === "string" &&
    typeof value.id === "string"
  );
}

/** Resolve the enclosing Git work-tree root, or `undefined` when cwd is not in one. */
export async function resolveGitRepoRoot(
  cwd: string,
  signal: AbortSignal,
  run: CommandRunner,
): Promise<string | undefined> {
  const result = await run("git", ["rev-parse", "--show-toplevel"], { cwd, signal });
  if (result.notFound || result.code !== 0) return undefined;
  const root = result.stdout.trim();
  return root.length > 0 ? root : undefined;
}

export function buildSessionManifest(input: {
  title: string;
  patchPath: string;
  repoRoot: string;
  review: ExtensionChangeRequestReviewDescriptor;
}): TfsSessionManifest {
  return {
    version: 1,
    title: input.title,
    patchPath: input.patchPath,
    repoRoot: input.repoRoot,
    review: input.review,
  };
}

async function readSessionManifest(ref: string, cwd: string): Promise<TfsSessionManifest> {
  const manifestPath = isAbsolute(ref) ? ref : resolve(cwd, ref);
  let raw: string;
  try {
    raw = await readFile(manifestPath, "utf8");
  } catch {
    throw new HunkExtensionUserError(
      `hunk-tfs session payload is missing or unreadable: ${manifestPath}`,
      {
        suggestions: [
          "Open a PR with `hunk pr-review` instead of calling `hunk show --vcs tfs` directly.",
        ],
      },
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new HunkExtensionUserError(`Invalid hunk-tfs session payload at ${manifestPath}.`);
  }

  if (!isRecord(parsed) || parsed.version !== 1) {
    throw new HunkExtensionUserError(`Unsupported hunk-tfs session payload at ${manifestPath}.`);
  }
  if (
    typeof parsed.title !== "string" ||
    typeof parsed.patchPath !== "string" ||
    typeof parsed.repoRoot !== "string" ||
    !isReviewDescriptor(parsed.review)
  ) {
    throw new HunkExtensionUserError(`Incomplete hunk-tfs session payload at ${manifestPath}.`);
  }

  return {
    version: 1,
    title: parsed.title,
    patchPath: parsed.patchPath,
    repoRoot: parsed.repoRoot,
    review: parsed.review,
  };
}

async function loadPreparedReview(
  ref: string | undefined,
  cwd: string,
): Promise<ExtensionVcsPatchResult> {
  if (!ref || ref.trim().length === 0) {
    throw new HunkExtensionUserError("hunk-tfs requires a prepared session payload path.", {
      suggestions: ["Run `hunk pr-review <locator>` to open a TFS pull request."],
    });
  }

  const manifest = await readSessionManifest(ref, cwd);
  let patchText: string;
  try {
    patchText = await readFile(manifest.patchPath, "utf8");
  } catch {
    throw new HunkExtensionUserError(
      `Prepared patch is missing or unreadable: ${manifest.patchPath}`,
    );
  }

  // sourceLabel becomes session repoRoot via Hunk's inferRepoRoot for VCS inputs.
  return {
    repoRoot: manifest.repoRoot,
    sourceLabel: manifest.repoRoot,
    title: manifest.title,
    patchText,
    review: manifest.review,
  };
}

/** VCS adapter used only via `hunk show <payload> --vcs tfs` after `pr-review` prepares a session. */
export function createTfsVcsAdapter(): ExtensionVcsAdapter {
  return {
    id: TFS_VCS_ID,
    name: "Azure DevOps Server / TFS",
    // Never auto-detect: Git (or another real VCS) owns the working copy.
    detect: () => null,
    operations: {
      "revision-show": {
        async load(input, context) {
          return loadPreparedReview(input.ref, context.cwd);
        },
      },
    },
  };
}
