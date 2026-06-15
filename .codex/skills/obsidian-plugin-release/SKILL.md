---
name: obsidian-plugin-release
description: Release and troubleshoot Obsidian community plugins. Use when preparing an Obsidian plugin for the Community Plugins directory, publishing GitHub releases, validating manifest/release assets, handling Obsidian Community Dashboard review errors, or explaining why a plugin does not appear in the Obsidian client store.
---

# Obsidian Plugin Release

## Overview

Use this skill to drive the current Obsidian community plugin release flow from repo audit through GitHub release and Dashboard review. Official process changes; verify current Obsidian docs or Dashboard behavior when anything conflicts with this workflow.

## Quick Checks

Run the bundled checker from the plugin repo root:

```bash
python3 .codex/skills/obsidian-plugin-release/scripts/check_release.py
```

Use `--no-network` when offline or when only local files should be checked.

## Release Workflow

1. Inspect state:
   - `git status --short`
   - `jq -r '.version' manifest.json package.json`
   - `gh release list --limit 10`

2. Verify required files:
   - `manifest.json`
   - `README.md`
   - `LICENSE`
   - `main.js` only as a release asset, not committed
   - `styles.css` if the plugin ships styles

3. Validate manifest and repo metadata:
   - `manifest.json.version` must exactly match a GitHub release tag, with no `v` prefix.
   - The matching release must not be draft or prerelease.
   - The release must contain individual assets: `main.js`, `manifest.json`, and `styles.css` when present.
   - Keep `id`, `name`, `description`, `author`, `authorUrl`, `minAppVersion`, and `isDesktopOnly` accurate.

4. Build and preflight:
   - Run `npm run build`.
   - Run `npm audit --omit=dev` and report production vulnerabilities.
   - Search for common Obsidian review scanner failures:

```bash
rg -n "eslint-disable|no-explicit-any|\\bas any\\b|createEl\\([\"']h[1-6][\"']|window as any" i18n.ts src main.ts
```

5. Bump and publish:
   - Update `package.json`, `package-lock.json`, `manifest.json`, and `versions.json`.
   - Commit with a Conventional Commit message.
   - Ask before `git push`.
   - Push `main` and the exact version tag.
   - Watch the release workflow: `gh run list`, then `gh run watch <run-id> --exit-status`.
   - Confirm `gh release view <version>` shows `isDraft: false`, `isPrerelease: false`, and required assets.

## Dashboard Review

The current official flow uses the Obsidian Community developer Dashboard, not direct PRs to `obsidianmd/obsidian-releases`. GitHub PRs may be disabled.

In Dashboard, verify:

- Ref is `main`.
- Commit is the newest pushed commit.
- Manifest version matches the newest release tag.
- Review status is `Pending` after submission.

If Dashboard says "No release matches your manifest version" while GitHub is correct, suspect stale Dashboard cache. Reconnect GitHub, refresh/rescan repository, or report the cache issue with:

```text
Repo: https://github.com/<owner>/<repo>
Manifest version on main: <version>
Release: https://github.com/<owner>/<repo>/releases/tag/<version>
Release assets: main.js, manifest.json, styles.css
The dashboard appears to show stale release/repository metadata.
```

## Client Store Troubleshooting

The Obsidian client store only shows plugins already accepted into the official index. A valid GitHub release is not enough.

Check the public index:

```bash
curl -fsSL https://raw.githubusercontent.com/obsidianmd/obsidian-releases/master/community-plugins.json \
  | jq -r '.[] | select(.id == "<plugin-id>" or .repo == "<owner>/<repo>")'
```

If the command returns nothing, the plugin is not listed yet. Explain that the user must wait for Dashboard review/acceptance.

## Manual Install For Testing

For local testing before approval, download release assets and place them in:

```text
<vault>/.obsidian/plugins/<plugin-id>/
```

Then restart Obsidian or refresh community plugins and enable the plugin.

## Push Safety

Never push without explicit user confirmation. Before pushing, summarize commits, tag, release version, and commands to run.
