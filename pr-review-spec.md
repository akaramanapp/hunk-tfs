# Hunk TFS PR Review Command and Comment Mapping Specification

**Status:** Approved  
**Scope:** `hunk-tfs` extension  
**Primary command:** `hunk pr-review`

## 1. Purpose

This specification defines:

1. A new primary command, `hunk pr-review`.
2. Pull-request auto-discovery when no PR locator is supplied.
3. Interactive selection of Git remotes and active pull requests.
4. One Hunk annotation per TFS thread comment.
5. Machine-readable TFS thread identity and status in each annotation's `rationale`.

## 2. Compatibility

- Register `pr-review` as the primary CLI command.
- Retain `tfs` indefinitely as a compatibility alias.
- Both command names must invoke the same handler and support the same arguments and behavior.
- Existing explicit locator forms remain supported:
  - Bare PR ID: `94924`
  - Hash-prefixed PR ID: `#94924`
  - Shorthand: `OKF/AppManagement#94924`
  - Full TFS/Azure DevOps PR URL
- Existing `--project`, `--repo`, and `-- <patch-options...>` behavior remains supported.

Examples:

```text
hunk pr-review 94924
hunk pr-review 'OKF/AppManagement#94924'
hunk pr-review 'http://atgtfsapp01.alb.albarakatech.com:8080/tfs/DefaultCollection/OKF/_git/AppManagement/pullrequest/94924?_a=files&path=%2F.gitignore'
hunk pr-review
hunk pr-review -- --pager

hunk tfs 94924
hunk tfs
```

`--pager` is a Hunk patch option that enables reduced pager-style UI chrome. Patch options after `--` do not count as a PR locator and therefore do not disable auto-discovery.

## 3. Invocation modes

### 3.1 Explicit locator

When a URL, ID, or shorthand locator is supplied, preserve the current lookup behavior.

A full PR URL may include query parameters such as `_a=files` and `path=...`. These are browser UI parameters and must not affect API resolution.

For the example URL above, resolve:

| Value | Result |
| --- | --- |
| Collection | `http://atgtfsapp01.alb.albarakatech.com:8080/tfs/DefaultCollection` |
| Project | `OKF` |
| Repository | `AppManagement` |
| PR ID | `94924` |

### 3.2 Auto-discovery

Auto-discovery is used whenever no URL, ID, or shorthand locator is supplied. This includes invocations containing only patch passthrough arguments after `--`.

Auto-discovery must:

1. Verify that the current working directory is inside a Git repository.
2. Select a Git remote.
3. Parse the remote into collection, project, and repository values.
4. Fetch active PRs for that repository.
5. Prefer PRs sourced from the current branch.
6. Select automatically when one candidate remains or ask the user when multiple candidates remain.
7. Continue through the same PR loading and Hunk delegation path used by an explicit locator.

For auto-discovery, derive the collection, project, and repository entirely from the selected remote. Do not use `TFS_URL` to identify the repository. `TFS_PAT` remains required for authentication.

## 4. Git repository validation

Run Git discovery relative to the CLI context's current working directory.

If the directory is not inside a Git work tree, exit with a user-facing error such as:

```text
Cannot auto-discover a pull request because the current directory is not inside a Git repository.
```

The error should suggest either changing into the repository or supplying an explicit PR locator.

## 5. Remote selection

Select the remote in this order:

1. The current branch's upstream remote, when configured.
2. A remote named `origin`.
3. The sole configured remote, when exactly one exists.
4. If multiple remotes remain and none of the rules above selects one, ask the user to choose.

If no remotes exist, exit with a user-facing error suggesting that the user configure a remote or provide an explicit PR locator.

### 5.1 Ambiguous remote chooser

When remote selection is required:

1. Try `gum choose`.
2. If `gum` is unavailable, use a basic numbered terminal prompt.
3. If no interactive terminal is available, exit with an error and list the available remotes.
4. Cancellation or invalid selection must exit cleanly with a user-facing error; it must not silently choose a remote.

External commands must be invoked without constructing a shell command string from remote names or other repository-controlled values.

## 6. Supported remote URLs

Auto-discovery supports HTTP and HTTPS TFS/Azure DevOps repository remotes shaped as:

```text
{collection}/{project}/_git/{repository}
```

Example:

```text
http://atgtfsapp01.alb.albarakatech.com:8080/tfs/DefaultCollection/OKF/_git/AppManagement
```

Parse the URL by locating the `_git` path segment:

- The segment immediately before `_git` is the project.
- The segment immediately after `_git` is the repository.
- The origin and all path segments before the project form the collection URL.
- Percent-encoded path segments must be decoded safely.
- A trailing slash and browser-only query or fragment data must not alter repository identity.

Reject:

- Non-HTTP(S) remotes, including SSH remotes.
- URLs without an unambiguous project and repository around `_git`.
- URLs containing embedded passwords.

Errors must identify the unsupported remote and suggest using an HTTP(S) TFS remote or an explicit PR locator.

## 7. Authentication and HTTP warning

- Continue using PAT authentication only.
- Require `TFS_PAT` for API requests.
- Do not add Windows Integrated Authentication, SPNEGO, NTLM, Kerberos, or `curl.exe --negotiate` support.
- Never print the PAT or include it in chooser labels, URLs, diagnostics, or error messages.

When the resolved collection URL uses plain HTTP:

- Emit one warning per command launch before making authenticated API requests.
- Do not block the request.
- Warn that credentials and TFS data are being sent without transport encryption.

Example:

```text
Warning: this TFS server uses HTTP; TFS_PAT and review data will be sent without transport encryption.
```

## 8. Active PR lookup

Query active pull requests for the derived project and repository using the configured TFS API version. The request is repository-scoped and equivalent to:

```http
GET {collection}/{project}/_apis/git/repositories/{repository}/pullRequests?searchCriteria.status=active&api-version={version}
```

Validate the response and retain only PR records whose normalized status is `active`.

Active draft PRs must be included.

If there are no active PRs, exit with a user-facing error naming the repository.

## 9. Current-branch preference

When attached to a branch:

1. Determine the source branch name to match. Prefer the branch name from its configured upstream; otherwise use the local branch name.
2. Compare it with each PR's `sourceRefName` after removing `refs/heads/`.
3. If one or more active PRs match, use only those PRs as selection candidates.
4. If none match, fall back to all active repository PRs.

When HEAD is detached or no current branch can be determined, skip branch filtering and use all active repository PRs.

## 10. PR selection

### 10.1 Zero candidates

Exit with an error. Do not launch an empty review.

### 10.2 One candidate

Select it automatically without prompting.

### 10.3 Multiple candidates

1. Try `gum choose`.
2. If `gum` is unavailable, use a basic numbered terminal prompt.
3. If no interactive terminal is available, exit with an error and print the candidates.
4. Cancellation or invalid selection must exit cleanly without selecting a PR.

Display each candidate as:

```text
[draft] #94924 — Fix application management — feature/example → main — Jane Doe
```

Omit `[draft]` for non-draft PRs.

Display rules:

- Include PR ID, title, short source branch, short target branch, and author.
- Current-branch matches appear before fallback candidates when both groups are represented.
- Sort newest PRs first within each group, using the PR creation date.
- Preserve the PR ID as an unambiguous selection key even when labels otherwise duplicate.

## 11. TFS thread-to-Hunk annotation mapping

### 11.1 One annotation per comment

Do not combine a TFS thread into one Hunk annotation.

For every non-deleted, non-system comment in a positioned TFS thread:

- Create one separate Hunk annotation.
- Preserve TFS comment order.
- Give the annotation a stable unique ID containing both thread ID and comment ID, for example:

```text
tfs-thread-1234-comment-7
```

- Anchor every comment in the thread to the thread's shared file side and line range.
- The Hunk UI must therefore show all comments in the thread vertically stacked at the same anchor.
- Set the annotation author and creation timestamp from the individual TFS comment.
- Keep annotations non-editable.

### 11.2 Summary

Store the complete individual TFS comment text in the annotation's `summary` field. Do not truncate it to the first 120 characters and do not concatenate replies into another comment's summary.

### 11.3 Rationale

The annotation's `rationale` must contain only the thread ID and normalized TFS thread status:

```text
threadId: {threadId} ({status})
```

Examples:

```text
threadId: 1234 (active)
threadId: 1234 (fixed)
threadId: 1234 (closed)
threadId: 1234 (wontfix)
threadId: 1234 (bydesign)
threadId: 1234 (pending)
threadId: 1234 (unknown)
```

Requirements:

- Use the actual normalized TFS status; do not map statuses to a generic `resolved` value.
- Include `(active)` for active threads.
- Every annotation belonging to the same thread receives the same rationale value.
- Do not store authors, timestamps, comment bodies, replies, or other prose in `rationale`.

### 11.4 Unpositioned threads

Threads without a file position remain visible in the existing comments pane only.

Do not:

- Create an unanchored or artificial Hunk annotation.
- Attach the thread to the first changed file.
- Remove the thread from the comments pane.

## 12. Comments pane and highlighting

- Preserve the existing comments pane and its full-thread display.
- Preserve thread navigation behavior.
- Preserve status-aware line highlighting.
- Annotation count and loading messages should count generated annotations/comments accurately rather than assuming one annotation per positioned thread.

## 13. Help and documentation

Update CLI help and the README so that:

- `hunk pr-review` is the primary documented command.
- `hunk tfs` is documented as a compatibility alias.
- The locator is optional.
- Auto-discovery behavior, supported remote format, remote priority, branch preference, chooser behavior, PAT requirement, and HTTP warning are described.
- Explicit locator examples include the supported on-prem HTTP TFS URL form.
- Passthrough-only discovery is demonstrated, for example `hunk pr-review -- --pager`.

Suggested synopsis:

```text
Usage: hunk pr-review [url|project/repo#id|id] [--project <name>] [--repo <name>] [-- <patch-options...>]
```

## 14. Error handling

All expected failures must use user-facing extension errors without stack traces and should include actionable suggestions.

Required failure cases include:

- Current directory is not a Git repository.
- No Git remotes are configured.
- The selected remote is unsupported or malformed.
- `TFS_PAT` is missing.
- TFS authentication or authorization fails.
- Active PR lookup fails or returns malformed data.
- No active PRs exist.
- Multiple choices exist in a non-interactive environment.
- Remote or PR selection is cancelled or invalid.
- The selected PR lacks required metadata or commit IDs.

Cancellation through Hunk's abort signal must stop Git/API/discovery work where practical and must not launch a partial review.

## 15. Security requirements

- Never expose `TFS_PAT` in process arguments, logs, errors, temporary files, or remote chooser input.
- Continue refusing credential-forwarding redirects.
- Treat Git remote names, URLs, PR titles, branch names, and author names as untrusted text.
- Do not execute chooser input through a shell.
- Preserve restrictive permissions and cleanup behavior for temporary patch and agent-context files.
- Plain HTTP is permitted but must produce the warning specified above.

## 16. Out of scope

- Removing the `hunk tfs` alias.
- SSH remote parsing.
- Windows Integrated Authentication or `curl.exe --negotiate`.
- Posting, editing, resolving, or deleting TFS comments.
- Creating artificial annotations for general/unpositioned threads.
- Changing Hunk itself to expose startup dialogs.

## 17. Acceptance criteria

1. `hunk pr-review <locator>` opens the same review that `hunk tfs <locator>` opens.
2. `hunk pr-review` outside a Git repository exits with an actionable error.
3. `hunk pr-review` inside a supported TFS Git repository derives collection, project, and repository from the chosen remote.
4. The provided on-prem URL structure is parsed correctly over HTTP.
5. An HTTP collection emits exactly one non-blocking security warning per launch.
6. A repository with no active PRs exits with an actionable error.
7. A sole active current-branch PR is selected automatically.
8. When no PR matches the current branch, discovery falls back to all active repository PRs.
9. Detached HEAD considers all active repository PRs.
10. Active drafts are included and labelled `[draft]`.
11. Multiple remotes or PRs use `gum choose`, with a numbered terminal fallback.
12. Non-interactive ambiguity exits with an error and prints available choices.
13. `hunk pr-review -- --pager` auto-discovers a PR and forwards `--pager` to `hunk patch`.
14. A positioned thread with three comments creates three distinct annotations at the same range in original comment order.
15. Each annotation summary contains only that individual comment's complete text.
16. Each annotation rationale exactly matches `threadId: {id} ({normalizedStatus})`.
17. Active and terminal thread statuses are preserved rather than converted to `(resolved)`.
18. Unpositioned threads remain available in the comments pane and produce no annotations.
19. Existing explicit ID, shorthand, full-URL, project/repository hint, patch delegation, pane, and cleanup behavior continue to work.

## 18. Verification plan

Add unit coverage for:

- Optional-locator CLI parsing and passthrough-only invocations.
- HTTP/HTTPS repository remote parsing.
- Full PR URLs with query parameters.
- Remote selection priority.
- Current branch, upstream branch, and detached HEAD candidate filtering.
- Draft inclusion, candidate formatting, and newest-first ordering.
- Zero, one, and multiple PR selection paths.
- `gum` success, cancellation, absence, numbered fallback, and non-interactive failure.
- HTTP warning cardinality.
- One-annotation-per-comment conversion, unique IDs, order, ranges, summaries, rationale statuses, and unpositioned threads.
- Existing explicit locator behavior as regression coverage.

Run the TypeScript typecheck and perform a manual PTY smoke test for both command names, auto-discovery, chooser interaction, stacked comments, and HTTP warning display.
