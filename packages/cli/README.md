# @noitenow/cli

Deploy CI-built `dist` to Noite over Git smart-HTTP. Same auth as `git push` (Basic `git` + profile API key, `push`-gated), zero server build: the tree carries `dist/*` + `wrangler.jsonc` with no `package.json`, so the runner skips straight to release command → `celld deploy`.

```sh
bunx @noitenow/cli deploy --slug myapp --url https://git.noite.now --token $NOITE_API_KEY
```

Flags fall back to env, then to GitHub Actions context:

| Flag | Env | Actions default |
| --- | --- | --- |
| `--dist` | — | `dist` |
| `--slug` | `NOITE_SLUG` | repo name, slugified |
| `--url` | `GIT_PUBLIC_BASE` / `NOITE_BASE` | — |
| `--token` | `NOITE_API_KEY` / `NOITE_GIT_TOKEN` | — |
| `--wrangler` | — | `wrangler.jsonc` |
| `--message` | — | `deploy <sha12>` |
| `--comment` | — | `update` (`create` / `off`) |

In Actions it writes `url=` + `sha=` to `$GITHUB_OUTPUT` and posts (or updates, via marker) a PR comment with `gh` — no GitHub App needed.

## Workflow example

```yaml
- run: bun run build
- run: bunx @noitenow/cli deploy --comment update
  env:
    NOITE_API_KEY: ${{ secrets.NOITE_API_KEY }}
    NOITE_BASE: https://git.noite.now
```

Commits are parented on the remote tip, so pushes stay fast-forward (`push` role suffices — never force). Values are never logged; the token travels in the remote URL exactly like `deploy.sh`.
