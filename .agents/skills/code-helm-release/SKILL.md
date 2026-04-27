---
name: code-helm-release
description: Use when releasing CodeHelm, changing its package version, publishing code-helm to npm, pushing release tags, checking GitHub Actions publish status, creating or verifying GitHub Releases, or updating the CodeHelm release process.
---

# CodeHelm Release

## Overview

Use this skill for CodeHelm product release work in `/Users/koltenluca/code-github/code-helm`.

CodeHelm publishes through a tag-triggered GitHub Actions workflow. The local job is to verify the release candidate, bump `package.json`, prove the new package version is publishable, commit the bump, tag it, push `main` and the tag, then verify npm and GitHub agree.

## Hard Constraints

- Use Bun for repository verification: `bun test` and `bun run typecheck`.
- Use `package.json` as the version source of truth.
- Use `npm version <patch|minor|major> --no-git-tag-version` for version bumps.
- Use `bunx npm@latest publish --dry-run` for local package publishability checks.
- Run npm dry-run after the version bump. npm validates the package version and fails dry-run for already-published versions.
- Do not create or push a Git tag until tests, typecheck, and npm dry-run have passed.
- Do not manually publish to npm unless the user explicitly asks for the manual fallback.
- Do not release from a dirty worktree. Product changes must already be committed before the release bump.
- Do not stage or revert unrelated user changes.

## Normal Patch Release

Use this path when the user asks to "release", "发版", "发一个 patch", "再发一个版本", or similar without asking for manual npm publishing.

1. Confirm repository state:

```bash
git fetch --tags origin
git status --short --branch
node -p "require('./package.json').version"
npm view code-helm version
git tag --list 'v*' --sort=-v:refname
```

Proceed only if:

- local `main` is not behind `origin/main`
- the worktree is clean
- local package version, latest npm version, and latest release tag are aligned

If the worktree is dirty, inspect it. If the dirty files are unrelated or uncommitted product work, stop and report that the release is blocked until those changes are committed or intentionally excluded.

2. Verify the current release candidate:

```bash
bun test
bun run typecheck
```

3. Bump the version:

```bash
npm version patch --no-git-tag-version
VERSION="$(node -p "require('./package.json').version")"
git diff -- package.json
```

For minor or major releases, replace `patch` only when the user explicitly asks for `minor` or `major`.

4. Verify the new package version can publish:

```bash
bunx npm@latest publish --dry-run
```

Expected dry-run evidence:

- package name is `code-helm`
- package version matches `$VERSION`
- command exits 0

5. Commit and tag:

```bash
git add package.json
git commit -m "chore(release): v$VERSION"
git tag -a "v$VERSION" -m "v$VERSION"
```

Before pushing, check:

```bash
git status --short --branch
git log --oneline --decorate -3
git tag --list "v$VERSION" --format='%(refname:short) %(objectname:short) %(subject)'
```

6. Push the release:

```bash
git push origin main --follow-tags
```

7. Verify the publish workflow and registries:

```bash
gh run list --workflow publish.yml --limit 3 --json databaseId,status,conclusion,event,headBranch,headSha,displayTitle,createdAt,url
npm view code-helm version
git ls-remote --tags origin "v$VERSION"
gh release view "v$VERSION" --json tagName,name,url,isDraft,isPrerelease,publishedAt
```

If the workflow is still in progress, wait or poll:

```bash
gh run watch <run-id> --exit-status
```

GitHub API calls may occasionally fail with `EOF`. Treat that as a transient query failure, not a workflow failure. Retry with `gh run list`, `gh run view`, or `gh release view`.

The release is complete only when:

- publish workflow conclusion is `success`
- npm shows `$VERSION`
- `origin` has tag `v$VERSION`
- GitHub Release `v$VERSION` exists and is not a draft
- local worktree is clean

## Manual Release Fallback

Use this only when the user explicitly requests manual local publishing or GitHub trusted publishing is unavailable.

```bash
git status --short --branch
bun test
bun run typecheck
npm version patch --no-git-tag-version
VERSION="$(node -p "require('./package.json').version")"
git diff -- package.json
bunx npm@latest publish --dry-run
bunx npm@latest publish --otp <otp>
git add package.json
git commit -m "chore(release): v$VERSION"
git tag -a "v$VERSION" -m "v$VERSION"
git push origin main --follow-tags
gh release create "v$VERSION" --generate-notes
npm view code-helm version
```

Do not push the tag before manual npm publish succeeds. If npm publish succeeds but commit, tag, push, or release creation fails, finish those GitHub steps using the already-published version; do not bump or republish.

## Release Process Updates

This skill is the project-local source of truth for CodeHelm release operations. Do not recreate a separate release guide unless the user explicitly asks for a user-facing document.

When changing the release process, update this skill and keep these facts aligned with the repository:

- CI/CD is the normal release path.
- Manual release is a fallback, not the default.
- npm dry-run belongs after the version bump.
- `publish.yml` is tag-triggered and verifies the tag matches `package.json`.
- Trusted publishing means the workflow does not need `NPM_TOKEN` or OTP.

Commit release-process changes separately before any release bump:

```bash
git add .agents/skills/code-helm-release/SKILL.md
git commit -m "docs: update release process"
```

## Failure Handling

If tests or typecheck fail before the version bump, fix the failure and do not bump.

If npm dry-run fails after the version bump:

- If it says the version was already published, the dry-run likely ran before a bump or the version is stale. Inspect `package.json`, npm, and tags.
- If it is a package contents problem, fix packaging before committing the bump.
- If it is an auth/network problem, report the blocker and do not tag.

If the publish workflow fails after push:

- Check the failed step with `gh run view <run-id> --log-failed`.
- If npm publish succeeded but the Release step failed, repair or rerun the GitHub step without changing the npm version.
- If npm publish failed before upload, fix the workflow/auth problem and rerun the same tag workflow only if npm still does not show that version.

If the user asks for another release immediately after a successful release, repeat the normal patch path from the current clean state. Do not assume the previous workflow status; recheck npm, tags, local status, and GitHub Actions.
