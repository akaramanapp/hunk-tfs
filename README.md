# hunk-tfs

Review **Azure DevOps Server / TFS** Git pull requests inside [Hunk](https://hunk.dev). It opens the PR diff, maps every positioned TFS comment to a separate read-only Hunk annotation, and keeps full threads (including unpositioned threads) in a comments pane.

## Requirements

- [Hunk](https://hunk.dev) ≥ 0.22 (extension API ≥ 17)
- `TFS_PAT`: Personal Access Token with the minimal permissions listed below

## Install

```bash
hunk extension install akaramanapp/hunk-tfs
```

For a one-off run: `hunk --extension /path/to/hunk-tfs pr-review 123`.

## Configure

Environment values are loaded without overriding existing shell values, first from the extension's `.env`, then from `<cwd>/.env`.

```env
TFS_PAT=your-personal-access-token
TFS_URL=http://host:8080/tfs/DefaultCollection
# TFS_API_VERSION=6.0
```

### Create the PAT

In Azure DevOps/TFS, open your user security settings, create a Personal Access Token, select the appropriate organization/collection, and grant only:

- **Code: Read**
- **Pull Request Threads: Read & write**

Copy the token when it is shown and store it as `TFS_PAT`; Azure DevOps will not display it again. Although the extension currently reads reviews, the Pull Request Threads API exposes this permission as **Read & write**.

`TFS_PAT` is always required. `TFS_URL` is required for an explicit bare ID or shorthand, but not for a full URL or auto-discovery. Auto-discovery always derives the collection, project, and repository from the selected Git remote and ignores `TFS_URL` for repository identity. Plain HTTP is allowed, but emits a warning because the PAT and review data are sent without transport encryption.

A typical installed-extension secret file is `~/.config/hunk/extensions/installed/hunk-tfs/.env`. Never commit PATs.

## Usage

```bash
# Auto-discover from the current Git repository
hunk pr-review

# Explicit locators
hunk pr-review 94655
hunk pr-review '#94655'
hunk pr-review 'MyProject/my-repo#94655'
hunk pr-review 'http://host:8080/tfs/DefaultCollection/MyProject/_git/my-repo/pullrequest/94655?_a=files&path=%2FREADME.md'

# Include non-active comment threads (active threads are loaded by default)
hunk pr-review 94655 --all-comments

# Auto-discover and pass an option through to the review UI
hunk pr-review -- --pager

# Indefinitely supported compatibility alias
hunk tfs 94655
hunk tfs
```

Synopsis:

```text
hunk pr-review [url|project/repo#id|id] [--project <name>] [--repo <name>] [--all-comments] [-- <review-options...>]
```

When the command runs inside a Git work tree, the review session is bound to that
repository root, so helpers like `hunk session review --repo .` resolve it.

### Auto-discovery

The command must run inside a Git work tree. It chooses the current branch's upstream remote, then `origin`, then the sole configured remote; otherwise it asks with `gum choose` or a numbered terminal prompt. Non-interactive ambiguity exits and lists choices.

Supported remotes are HTTP(S) URLs shaped as `{collection}/{project}/_git/{repository}`; SSH remotes and embedded passwords are rejected. The extension fetches active repository PRs, including drafts, and prefers PRs whose source matches the current upstream branch (or local branch). With no match or detached HEAD it considers all active PRs. One candidate is automatic; multiple candidates use the same chooser, newest first.

### Review UI

Only active comment threads are loaded by default. Pass `--all-comments` to include all non-active threads too.

- Every non-system, non-deleted positioned comment is stacked as its own annotation at the thread range.
- The **hunk-tfs** pane shows complete threads; `j`/`k` move and Enter jumps to a positioned thread.
- `ctrl+shift+c` toggles the comments pane.
- Unpositioned threads remain in the pane and do not create artificial annotations.

## How it works

The extension loads PR metadata, changed blobs, and threads through the TFS REST API, builds a restrictive-permission temporary unified patch plus agent-context and session sidecars, then delegates to Hunk's built-in `show --vcs tfs` path so the session is bound to the local Git root (required for `--repo` session commands). Authentication redirects are refused and the PAT is never passed in process arguments.

## Development

```bash
npm install
npx tsc --noEmit
hunk --extension . pr-review --help
```
