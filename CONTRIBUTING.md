# Contributing

Thanks for taking a look. This project is test-first and deliberately has no runtime
dependencies.

## Development

Requirements: Node.js 20+.

```bash
git clone https://github.com/T-splines/dsh-llm-resilience.git
cd dsh-llm-resilience
npm install   # installs the public DSH peer packages used by the tests
npm test
```

The tests use `node --test` and local fakes; no DSH instance is required for the unit suite.
End-to-end smoke instructions are in [DESIGN.md](DESIGN.md).

## Pull requests

- Keep one logical change per commit. Use `feat:` / `fix:` / `test:` / `docs:` /
  `chore:` prefixes and explain *why* in the message.
- Add a regression test for every bug fix, especially for streaming, replay and breaker
  state. The tests pin contracts, not incidental implementation details.
- Do not add runtime dependencies without discussing it first.
- Update `CHANGELOG.md` for user-visible changes and keep the top version in sync with
  `package.json`.

## Releasing

npm has retired legacy (classic) tokens: since November 2025 only granular access
tokens work, and granular tokens expire (90 days by default). A local `~/.npmrc`
token silently dying is what produced the 2026-11-24 release failure, so this
repository publishes through **OIDC trusted publishing** from GitHub Actions and
keeps no token anywhere.

The whole flow is: bump `package.json` + move `CHANGELOG.md` to the same version,
commit, tag `vX.Y.Z`, push the tag. `.github/workflows/publish.yml` does the rest
(it also refuses to publish when the tag, `package.json` and the CHANGELOG top
section disagree).

```bash
# 1. version + changelog in one commit
npm version patch --no-git-tag-version   # or edit package.json by hand
$EDITOR CHANGELOG.md
git commit -am "release: v$(node -p "require('./package.json').version")"

# 2. tag and push — the tag is what triggers the publish workflow
git tag "v$(node -p "require('./package.json').version")"
git push origin main --tags
```

One-time manual setup (cannot be automated, needs 2FA on npmjs.com):

> npmjs.com → Packages → `@magic6/dsh-llm-resilience` → Settings →
> Trusted publishing → Add publisher
>
> - Provider: **GitHub Actions**
> - Organization or user: `T-splines`
> - Repository: `dsh-llm-resilience`
> - Workflow filename: `publish.yml`
> - Environment: leave empty
>
> **The first successful publish must happen within 2 days** of creating the
> configuration, otherwise it expires and has to be recreated.

Verify afterwards without guessing:

```bash
npm view @magic6/dsh-llm-resilience version            # the new version is visible
curl -s https://registry.npmjs.org/@magic6%2Fdsh-llm-resilience | \
  jq -r '.time["<version>"]'                            # publish timestamp
```

`npm whoami` is **not** a health check for this setup: trusted publishing never
issues a user-scoped token, and npm's own docs say to verify permissions with the
operation you actually intend to perform.

### Debugging a failed publish

GitHub does not let a non-admin download Actions logs over the API (`403 Must have
admin rights`), and this machine has no `gh` CLI. The workflow therefore echoes the
decisive npm line as a check-run annotation, which *is* publicly readable:

```bash
SHA=$(git rev-parse HEAD)
curl -s "https://api.github.com/repos/T-splines/dsh-llm-resilience/commits/$SHA/check-runs" \
  | jq -r '.check_runs[] | "\(.name): \(.conclusion)"'
RUN=$(curl -s "https://api.github.com/repos/T-splines/dsh-llm-resilience/actions/runs?per_page=1" | jq -r '.workflow_runs[0].id')
JOB=$(curl -s "https://api.github.com/repos/T-splines/dsh-llm-resilience/actions/runs/$RUN/jobs" | jq -r '.jobs[0].id')
curl -s "https://api.github.com/repos/T-splines/dsh-llm-resilience/check-runs/$JOB/annotations" \
  | jq -r '.[] | select(.annotation_level=="failure") | .message'
```

Reading the message: `E404`/`E403` with "not permitted" almost always means the trusted
publisher is missing `npm publish` under *Allowed actions*, or the workflow filename in
the npmjs form does not match `publish.yml` exactly.
