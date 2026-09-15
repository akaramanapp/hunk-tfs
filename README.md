# hunk-tfs

Review **Azure DevOps Server / TFS** (and Azure DevOps) Git pull requests inside [Hunk](https://hunk.dev).

Fetches the PR diff and discussion threads, opens them in Hunk, shows inline review comments as agent notes, and lists threads in a side pane.

## Requirements

- [Hunk](https://hunk.dev) ≥ 0.22 (extension API ≥ 17)
- A Personal Access Token with **Code (Read)** scope

## Install

```bash
hunk extension install akaramanapp/hunk-tfs
```

Pin a release:

```bash
hunk extension install akaramanapp/hunk-tfs@v0.1.0
```

One-off run without installing:

```bash
hunk --extension /path/to/hunk-tfs tfs 123
```

## Configure

Credentials are read in this order (first non-empty wins):

1. **Shell environment** (`export TFS_PAT=…`)
2. **Extension directory** `.env` (recommended for `hunk extension install`)
3. **Current working directory** `.env`

### Recommended (installed extension)

After `hunk extension install akaramanapp/hunk-tfs`, put secrets next to the installed package — **not** in the git repo:

```bash
# typical managed install path (XDG)
~/.config/hunk/extensions/installed/hunk-tfs/.env
```

```env
TFS_URL=http://host:8080/tfs/DefaultCollection
TFS_PAT=your-personal-access-token
# TFS_API_VERSION=6.0
```

Copy from the shipped example:

```bash
cp ~/.config/hunk/extensions/installed/hunk-tfs/.env.example \
   ~/.config/hunk/extensions/installed/hunk-tfs/.env
```

Then edit `.env`. Never commit real PATs.

### Alternatives

| Approach | When to use |
| -------- | ----------- |
| Shell `export` / direnv / 1Password CLI | Shared machines, CI, or you don’t want files on disk |
| `cwd/.env` | Per-project override while you `cd` into a repo |
| Full PR URL only | `TFS_URL` can be omitted; `TFS_PAT` is still required |

| Variable | Required | Description |
| -------- | -------- | ----------- |
| `TFS_PAT` | yes | PAT (Code Read) |
| `TFS_URL` | usually | Collection / org URL. Optional if you pass a full PR URL |
| `TFS_API_VERSION` | no | Defaults to `6.0` (good for on-prem Server) |

Project and repository are resolved automatically:

```http
GET {TFS_URL}/_apis/git/pullrequests/{id}
```

## Usage

```bash
# Bare id (needs TFS_URL + TFS_PAT)
hunk tfs 94655

# Full PR URL (collection taken from the link)
hunk tfs 'http://host:8080/tfs/DefaultCollection/MyProject/_git/my-repo/pullrequest/94655'

# Shorthand
hunk tfs 'MyProject/my-repo#94655'

# Pass options through to hunk patch
hunk tfs 94655 -- --pager
```

Help:

```bash
hunk tfs --help
```

### In the review UI

- **Diff** — unified patch built from the PR’s base/head commits
- **Agent notes** — file-anchored PR comments (author, body, status)
- **hunk-tfs pane** (right) — all threads; `j`/`k` move, Enter jumps to the line
- **`ctrl+shift+c`** — toggle the comments pane

## How it works

1. Looks up the PR (metadata, project, repo)
2. Lists changed files and fetches old/new blob contents
3. Builds a temporary unified patch + `--agent-context` sidecar
4. Delegates to Hunk’s built-in `patch` command

## Development

```bash
npm install
npx tsc --noEmit
hunk --extension . tfs --help
```

## License

Use and distribute as you like within your organization. Add a `LICENSE` file if you publish publicly.
