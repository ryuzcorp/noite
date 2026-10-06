# @noitenow/cli

Deploy a CI-built `dist` to [Noite](https://noite.now) over Git smart-HTTP — zero server build. Same auth as `git push` (Basic `git` + profile API key, `push` role suffices, never force).

```sh
bun add -g @noitenow/cli   # or: npm i -g @noitenow/cli
bunx @noitenow/cli deploy --slug <slug> --url https://git.<domain> --token $NOITE_API_KEY
```

Bun must be on the machine that runs it (ships as a Bun bundle). Full reference — flags, environment fallbacks, the GitHub Actions workflow, outputs and PR comments — lives in the docs: <https://noite.now/reference/cli>.
