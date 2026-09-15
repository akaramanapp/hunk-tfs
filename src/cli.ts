import { HunkExtensionUserError } from "hunkdiff/extension";

export const TFS_PR_HELP = `Usage: hunk tfs <url|project/repo#id|id> [--project] [--repo] [-- <patch-options...>]

hunk-tfs — review an Azure DevOps Server / TFS Git pull request.

Required environment (shell export or .env file):
  TFS_PAT       Personal Access Token (Code Read)
  TFS_URL       Collection URL — optional when you pass a full PR URL

Optional:
  TFS_API_VERSION   REST api-version (default: 6.0)

Project and repository are resolved automatically via:
  GET {collection}/_apis/git/pullrequests/{id}
So a bare id is enough when TFS_URL + TFS_PAT are set.

.env lookup (does not override existing shell vars):
  1. <extension>/.env
  2. <cwd>/.env

Pull request forms:
  94655                                                   preferred with .env TFS_URL + TFS_PAT
  https://…/Project/_git/repo/pullrequest/123             also fills collection from the link
  'Project/repo#123'                                      optional hint; verified against the API

Examples:
  hunk tfs 94655
  hunk tfs 'http://host:8080/tfs/DefaultCollection/MyProject/_git/my-repo/pullrequest/94655'
  hunk tfs 'MyProject/my-repo#94655'
`;

export interface TfsPullRequestLocator {
  readonly id: string;
  readonly project?: string;
  readonly repository?: string;
  /** Collection root derived from a full PR URL, when present. */
  readonly collectionUrl?: string;
}

export interface TfsPrInvocation {
  readonly locator: TfsPullRequestLocator;
  readonly project?: string;
  readonly repository?: string;
  readonly patchArgs: readonly string[];
  readonly help: boolean;
}

function invocationError(message: string): HunkExtensionUserError {
  return new HunkExtensionUserError(message, {
    suggestions: [
      "Run `hunk tfs --help` for accepted forms.",
      "With TFS_URL + TFS_PAT set, a bare id is enough: hunk tfs 94655",
      "Or pass a full PR URL.",
    ],
  });
}

function parsePullRequestId(value: string): string {
  const normalized = value.replace(/^#/, "");
  if (!/^[1-9]\d*$/.test(normalized)) {
    throw invocationError(`Invalid pull-request id: ${value}`);
  }
  const number = Number(normalized);
  if (!Number.isSafeInteger(number)) {
    throw invocationError(`Pull-request id is too large: ${value}`);
  }
  return String(number);
}

function decodePathSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw invocationError(`Invalid URL path segment: ${value}`);
  }
}

/** Parse a bare id, project/repo#id, or Azure DevOps / TFS pull-request URL. */
export function parseTfsPullRequestLocator(value: string): TfsPullRequestLocator {
  if (/^#?\d+$/.test(value)) {
    return { id: parsePullRequestId(value) };
  }

  const shorthand = /^([^/#]+)\/([^/#]+)#([^#]+)$/.exec(value);
  if (shorthand) {
    return {
      project: shorthand[1]!,
      repository: shorthand[2]!,
      id: parsePullRequestId(shorthand[3]!),
    };
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invocationError(`Invalid pull-request locator: ${value}`);
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw invocationError("Pull-request URLs must be http(s).");
  }
  if (url.username || url.password) {
    throw invocationError("Pull-request URLs must not embed credentials.");
  }

  const parts = url.pathname.split("/").filter(Boolean).map(decodePathSegment);
  const gitIndex = parts.findIndex((part) => part.toLowerCase() === "_git");
  if (gitIndex < 1 || gitIndex + 3 >= parts.length) {
    throw invocationError(
      "TFS PR URLs must look like …/{project}/_git/{repo}/pullrequest/{id}.",
    );
  }

  const project = parts[gitIndex - 1]!;
  const repository = parts[gitIndex + 1]!;
  const marker = parts[gitIndex + 2]!.toLowerCase();
  if (marker !== "pullrequest" && marker !== "pullrequests") {
    throw invocationError(
      "TFS PR URLs must contain /pullrequest/{id} after the repository.",
    );
  }
  const id = parsePullRequestId(parts[gitIndex + 3]!);
  const collectionParts = parts.slice(0, gitIndex - 1);
  if (collectionParts.length === 0) {
    throw invocationError("Could not derive the collection URL from the PR link.");
  }
  const collectionUrl = `${url.origin}/${collectionParts.join("/")}`;

  return { id, project, repository, collectionUrl };
}

/** Parse extension-owned tokens; options after `--` pass through to `hunk patch`. */
export function parseTfsPrInvocation(args: readonly string[]): TfsPrInvocation {
  const separator = args.indexOf("--");
  const ownedArgs = separator < 0 ? args : args.slice(0, separator);
  const patchArgs = separator < 0 ? [] : args.slice(separator + 1);

  if (ownedArgs.includes("--help") || ownedArgs.includes("-h")) {
    return {
      locator: { id: "1" },
      patchArgs: Object.freeze([...patchArgs]),
      help: true,
    };
  }

  let target: string | undefined;
  let project: string | undefined;
  let repository: string | undefined;

  for (let index = 0; index < ownedArgs.length; index += 1) {
    const token = ownedArgs[index]!;

    const takeValue = (flag: string): string => {
      const inline = token.startsWith(`${flag}=`) ? token.slice(flag.length + 1) : undefined;
      if (inline !== undefined) {
        if (!inline) throw invocationError(`\`${flag}\` requires a value.`);
        return inline;
      }
      const value = ownedArgs[index + 1];
      if (!value || value.startsWith("-")) {
        throw invocationError(`\`${flag}\` requires a value.`);
      }
      index += 1;
      return value;
    };

    if (token === "--project" || token.startsWith("--project=")) {
      if (project !== undefined) throw invocationError("Specify --project only once.");
      project = takeValue("--project");
      continue;
    }
    if (token === "--repo" || token.startsWith("--repo=")) {
      if (repository !== undefined) throw invocationError("Specify --repo only once.");
      repository = takeValue("--repo");
      continue;
    }
    if (token.startsWith("-")) {
      throw invocationError(`Unknown tfs option: ${token}`);
    }
    if (target !== undefined) {
      throw invocationError("Specify exactly one pull request.");
    }
    target = token;
  }

  if (!target) {
    throw invocationError("Specify one pull request (URL, project/repo#id, or id).");
  }

  const locator = parseTfsPullRequestLocator(target);
  if (project !== undefined && locator.project && project !== locator.project) {
    throw invocationError("Do not combine --project with a locator that already names a project.");
  }
  if (repository !== undefined && locator.repository && repository !== locator.repository) {
    throw invocationError("Do not combine --repo with a locator that already names a repository.");
  }

  return {
    locator,
    project,
    repository,
    patchArgs: Object.freeze([...patchArgs]),
    help: false,
  };
}
