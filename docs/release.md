# CodeHelm Release Guide

This document describes how to publish a new CodeHelm release to both npm and GitHub while keeping the version history aligned.

CodeHelm currently supports two release modes:

- manual release from your local machine
- CI/CD release from GitHub Actions with npm trusted publishing

## Version Source Of Truth

CodeHelm uses `package.json` as the release version source of truth.

When you update `package.json`:

- `code-helm version` changes
- the Codex client metadata version changes
- the npm package version changes

Current package name:

- `code-helm`

Current GitHub repository:

- `https://github.com/humeo/code-helm`

## Release Flow

Use this order:

1. finish and commit the product changes
2. verify the release candidate locally
3. bump `package.json` and `package-lock.json`
4. publish to npm
5. commit the version bump
6. create and push the matching Git tag
7. optionally create a GitHub Release

This order is intentional.

Do not push the Git tag before npm publish succeeds. If npm publish fails after a tag is already public, GitHub and npm drift apart.

## Recommended Release Modes

### Manual Release

Use this when:

- you are bootstrapping the package
- you want full step-by-step control
- npm trusted publishing is not configured yet

Manual release means:

- you run `npm publish` yourself
- you authenticate with OTP or a publish-capable token
- you create the Git tag and optional GitHub Release yourself

### CI/CD Release

Use this once GitHub Actions and npm trusted publishing are configured.

CI/CD release means:

- you still choose the version number locally
- you still commit the version bump locally
- you still create and push the Git tag locally
- GitHub Actions runs the verification suite and publishes to npm automatically

This repository now includes:

- `.github/workflows/ci.yml`
- `.github/workflows/publish.yml`

The publish workflow is tag-driven and expects tags such as:

- `v0.1.1`
- `v0.2.0`

## Choose The Next Version

Use semantic versioning:

- `patch`: compatible bug fix, for example `0.1.0 -> 0.1.1`
- `minor`: compatible feature release, for example `0.1.0 -> 0.2.0`
- `major`: breaking change, for example `0.1.0 -> 1.0.0`

## Preconditions

Before releasing, confirm:

- you are on the intended branch, usually `main`
- the worktree is clean
- GitHub auth works through `gh`
- npm auth works through `npm`
- Bun is installed locally

Useful checks:

```bash
git status --short --branch
gh auth status
npm whoami
bun --version
```

## Step 1: Finish And Commit Product Changes

Before bumping the release version, commit the actual feature or fix work first.

Example:

```bash
git status --short --branch
git add <changed files>
git commit -m "feat(...): describe the change"
git push
```

At this point, your release version should still be the old version.

## Step 2: Verify The Release Candidate

Run the local verification suite before changing the release version:

```bash
bun test
bun run typecheck
bunx npm@latest publish --dry-run
```

Expected result:

- tests pass
- typecheck passes
- npm dry-run succeeds

If any of these fail, fix that first and do not bump the version yet.

## Step 3: Bump The Version Locally

Update the package version without creating a Git tag automatically:

```bash
npm version patch --no-git-tag-version
```

Or:

```bash
npm version minor --no-git-tag-version
npm version major --no-git-tag-version
```

This updates:

- `package.json`
- `package-lock.json`

Check the result:

```bash
git diff -- package.json package-lock.json
node -p "require('./package.json').version"
```

## Step 4: Publish To npm

Publish only after the version bump is correct.

If your npm account publishes with a one-time password:

```bash
bunx npm@latest publish --otp 123456
```

If your npm account uses a granular access token that can bypass 2FA for publish:

```bash
bunx npm@latest publish
```

If publish succeeds, the version is now permanently used on npm.

You cannot publish the same version number again.

## Step 5: Commit The Version Bump

After npm publish succeeds, commit the version files:

```bash
VERSION="$(node -p "require('./package.json').version")"
git add package.json package-lock.json
git commit -m "chore(release): v$VERSION"
```

## Step 6: Tag The GitHub Version

Create a Git tag that matches the npm version:

```bash
VERSION="$(node -p "require('./package.json').version")"
git tag -a "v$VERSION" -m "v$VERSION"
```

Push the branch and tag:

```bash
git push origin main --follow-tags
```

## Step 7: Create The GitHub Release

This step is optional.

Create a GitHub Release from the same tag:

```bash
VERSION="$(node -p "require('./package.json').version")"
gh release create "v$VERSION" --generate-notes
```

## Step 8: Verify The Published Version

Check both registries:

```bash
VERSION="$(node -p "require('./package.json').version")"
npm view code-helm version
git ls-remote --tags origin "v$VERSION"
```

Expected result:

- npm shows the same version as `package.json`
- GitHub has the matching tag

If you also create a GitHub Release, verify it too:

```bash
gh release view "v$VERSION"
```

## CI/CD Setup

To enable automatic npm publishing from GitHub Actions, configure npm trusted publishing for this repository.

Required repository/workflow identity:

- repository: `humeo/code-helm`
- workflow file: `.github/workflows/publish.yml`
- package: `code-helm`

Current workflow behavior:

- `ci.yml` runs on pushes to `main` and on pull requests
- `publish.yml` runs when a tag matching `v*` is pushed
- both workflows invoke `bunx npm@latest ...` instead of self-upgrading the runner npm in place
- `publish.yml` verifies that `package.json` matches the pushed tag version before publishing

### Option A: Configure Trusted Publishing In npm UI

In npm:

1. open package settings for `code-helm`
2. open trusted publishing / publishing access settings
3. add a GitHub trusted publisher for `humeo/code-helm`
4. set the workflow file to `publish.yml`

After trusted publishing is configured, `publish.yml` can publish without storing a long-lived `NPM_TOKEN` in GitHub secrets.

### Option B: Configure Trusted Publishing With npm CLI

If your npm CLI and account permissions support it, you can configure the same trust relationship from the command line:

```bash
npm trust github code-helm --repo humeo/code-helm --file publish.yml
```

If you later decide to protect publishing behind a GitHub Actions environment, include that environment name in the trusted publisher configuration too.

## CI/CD Release Flow

Once trusted publishing is enabled, the release flow becomes:

1. commit product changes to `main`
2. run local preflight checks if you want an early signal
3. bump the version locally with `npm version ... --no-git-tag-version`
4. commit `package.json` and `package-lock.json`
5. create a matching tag such as `v0.1.1`
6. push `main` and the tag
7. GitHub Actions publishes the npm package automatically

Example:

```bash
bun test
bun run typecheck
bunx npm@latest publish --dry-run
npm version patch --no-git-tag-version
VERSION="$(node -p "require('./package.json').version")"
git add package.json package-lock.json
git commit -m "chore(release): v$VERSION"
git tag -a "v$VERSION" -m "v$VERSION"
git push origin main --follow-tags
```

After the tag push:

- GitHub Actions runs `publish.yml`
- npm publishes `code-helm@$VERSION`
- GitHub records the release version through the pushed tag
- users can upgrade with `code-helm update`

## Recommended Command Sequence

For a manual patch release:

```bash
git status --short --branch
bun test
bun run typecheck
bunx npm@latest publish --dry-run
npm version patch --no-git-tag-version
bunx npm@latest publish --otp 123456
VERSION="$(node -p "require('./package.json').version")"
git add package.json package-lock.json
git commit -m "chore(release): v$VERSION"
git tag -a "v$VERSION" -m "v$VERSION"
git push origin main --follow-tags
gh release create "v$VERSION" --generate-notes
npm view code-helm version
```

For a CI/CD patch release after trusted publishing is configured:

```bash
git status --short --branch
bun test
bun run typecheck
bunx npm@latest publish --dry-run
npm version patch --no-git-tag-version
VERSION="$(node -p "require('./package.json').version")"
git add package.json package-lock.json
git commit -m "chore(release): v$VERSION"
git tag -a "v$VERSION" -m "v$VERSION"
git push origin main --follow-tags
```

Optional after the workflow succeeds:

```bash
gh release create "v$VERSION" --generate-notes
```

## Failure Handling

### If Verification Fails Before Publish

If tests, typecheck, or dry-run fail before the publish step:

- fix the issue
- keep working on the same version bump if you want
- do not tag or create a GitHub Release yet

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

### If You Need To Ship A Fix After A Broken Public Release

If `0.1.1` was published and you found a bug afterward:

- fix the bug in code
- release `0.1.2`

Do not try to overwrite `0.1.1`.

## Updating Users

After a new npm release is live, users can upgrade with:

```bash
code-helm update
```

That command runs:

```bash
npm install -g code-helm@latest
```

It updates the installed npm package for future invocations and future restarts.

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
