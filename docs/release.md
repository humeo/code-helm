# CodeHelm Release Guide

This document describes how to publish a new CodeHelm release to npm and GitHub while keeping package, tag, and release history aligned.

## Version Source Of Truth

CodeHelm uses `package.json` as the release version source of truth.

When `package.json` changes:

- `code-helm version` changes
- the Codex client metadata version changes
- the npm package version changes

Current package name:

- `code-helm`

Current GitHub repository:

- `https://github.com/humeo/code-helm`

## Release Modes

Use CI/CD release for normal releases.

CI/CD release means:

- you choose and commit the version locally
- you create and push the matching Git tag locally
- GitHub Actions verifies, publishes to npm through trusted publishing, and creates or updates the matching GitHub Release

Manual release is only for bootstrapping, trusted-publishing outages, or cases where you intentionally need full local control.

## Choose The Next Version

Use semantic versioning:

- `patch`: compatible bug fix, for example `0.2.7 -> 0.2.8`
- `minor`: compatible feature release, for example `0.2.7 -> 0.3.0`
- `major`: breaking change, for example `0.2.7 -> 1.0.0`

## Preconditions

Before releasing, confirm:

- you are on the intended branch, usually `main`
- the worktree is clean before the version bump
- product changes are already committed
- Bun is installed locally
- GitHub auth works through `gh`
- npm trusted publishing is configured for the publish workflow, or you are intentionally using the manual fallback

Useful checks:

```bash
git status --short --branch
gh auth status
bun --version
```

For manual publishing, also check:

```bash
npm whoami
```

## CI/CD Patch Release

Use this for the normal patch-release path:

```bash
git status --short --branch
bun test
bun run typecheck
npm version patch --no-git-tag-version
VERSION="$(node -p "require('./package.json').version")"
git diff -- package.json
bunx npm@latest publish --dry-run
git add package.json
git commit -m "chore(release): v$VERSION"
git tag -a "v$VERSION" -m "v$VERSION"
git push origin main --follow-tags
```

After the tag push:

- GitHub Actions runs `.github/workflows/publish.yml`
- the workflow verifies that `package.json` matches the pushed tag
- the workflow publishes `code-helm@$VERSION` to npm
- the workflow creates or updates the matching GitHub Release with generated notes
- users can upgrade with `code-helm update`

Do not push the Git tag until tests, typecheck, and the npm dry-run have passed.
Run the dry-run after the version bump because npm validates that the package version has not already been published.

## Manual Patch Release Fallback

Use this only when CI/CD publishing is not available.

```bash
git status --short --branch
bun test
bun run typecheck
npm version patch --no-git-tag-version
VERSION="$(node -p "require('./package.json').version")"
git diff -- package.json
bunx npm@latest publish --dry-run
bunx npm@latest publish --otp 123456
git add package.json
git commit -m "chore(release): v$VERSION"
git tag -a "v$VERSION" -m "v$VERSION"
git push origin main --follow-tags
gh release create "v$VERSION" --generate-notes
npm view code-helm version
```

Do not push the Git tag before npm publish succeeds. If npm publish fails after a tag is already public, GitHub and npm drift apart.

## Verify The Published Version

Check both registries after publish:

```bash
VERSION="$(node -p "require('./package.json').version")"
npm view code-helm version
git ls-remote --tags origin "v$VERSION"
gh release view "v$VERSION"
```

Expected result:

- npm shows the same version as `package.json`
- GitHub has the matching tag
- GitHub has the matching release

## CI/CD Setup

The publish workflow expects npm trusted publishing.

Required trusted-publisher identity:

- repository: `humeo/code-helm`
- workflow file: `.github/workflows/publish.yml`
- package: `code-helm`

Current workflow behavior:

- `.github/workflows/ci.yml` runs on pushes to `main` and on pull requests
- `.github/workflows/publish.yml` runs when a tag matching `v*` is pushed
- both workflows invoke `bunx npm@latest ...` instead of self-upgrading the runner npm in place
- `publish.yml` verifies that `package.json` matches the pushed tag version before publishing
- after npm publish succeeds, `publish.yml` creates or updates the matching GitHub Release with generated notes

To configure trusted publishing in npm:

1. open package settings for `code-helm`
2. open trusted publishing / publishing access settings
3. add a GitHub trusted publisher for `humeo/code-helm`
4. set the workflow file to `publish.yml`

After trusted publishing is configured, `publish.yml` can publish without storing a long-lived `NPM_TOKEN` in GitHub secrets.

## Failure Handling

### If Verification Fails Before Publish

If tests, typecheck, or dry-run fail before the publish step:

- fix the issue
- keep working on the same version bump if you want
- do not tag or create a manual GitHub Release yet

### If npm Publish Fails

If the publish step fails before upload is accepted:

- fix the auth or package issue
- retry the same version if npm did not publish it

Useful checks:

```bash
npm whoami
npm profile get --json
npm view code-helm version
```

### If npm Publish Already Succeeded But Something Later Fails

If npm publish succeeded but Git commit, tag push, or GitHub Release creation failed:

- do not republish the same version
- finish the Git commit, tag, and release work using that same published version
- if the automated GitHub Release step failed, repair the workflow or rerun it without changing the npm version

### If You Need To Ship A Fix After A Broken Public Release

If `0.2.8` was published and you found a bug afterward:

- fix the bug in code
- release `0.2.9`

Do not try to overwrite `0.2.8`.

## Updating Users

After a new npm release is live, users can upgrade with:

```bash
code-helm update
```

That command updates the installed npm package for future invocations and future restarts.

## Notes On Auth

The publish command may require stronger auth than `npm whoami`.

Common cases:

- `npm whoami` works, but publish still fails because the account needs publish-time 2FA
- publish requires `--otp <code>`
- publish requires a granular access token with bypass-2FA capability

When this repository publishes through npm trusted publishing from GitHub Actions:

- you do not need to store a long-lived `NPM_TOKEN` in GitHub secrets
- you do not need `--otp` inside the workflow
- npm uses short-lived OIDC-based credentials for the publish step

If you see a publish-time `E403` mentioning 2FA or bypass-2FA tokens, fix the npm auth policy first, then retry publish.
