#!/bin/bash
set -euo pipefail

# ─── Usage ───────────────────────────────────────────────────────
# ./publish.sh [patch|minor|major]   (default: patch)
#
# Examples:
#   ./publish.sh           # 1.1.2 → 1.1.3
#   ./publish.sh minor     # 1.1.2 → 1.2.0
#   ./publish.sh major     # 1.1.2 → 2.0.0
# ─────────────────────────────────────────────────────────────────

BUMP_TYPE="${1:-patch}"

if [[ "$BUMP_TYPE" != "patch" && "$BUMP_TYPE" != "minor" && "$BUMP_TYPE" != "major" ]]; then
  echo "Error: argument must be patch, minor, or major"
  exit 1
fi

# Read current version from manifest.json
CURRENT_VERSION=$(node -p "require('./manifest.json').version")
echo "Current version: $CURRENT_VERSION"

# Calculate next version
IFS='.' read -r MAJOR MINOR PATCH <<< "$CURRENT_VERSION"
case "$BUMP_TYPE" in
  major) MAJOR=$((MAJOR + 1)); MINOR=0; PATCH=0 ;;
  minor) MINOR=$((MINOR + 1)); PATCH=0 ;;
  patch) PATCH=$((PATCH + 1)) ;;
esac
NEW_VERSION="${MAJOR}.${MINOR}.${PATCH}"
echo "New version:     $NEW_VERSION"

# Check for uncommitted changes (besides what we're about to change)
if ! git diff --quiet HEAD 2>/dev/null; then
  echo ""
  echo "Warning: you have uncommitted changes."
  read -rp "Continue anyway? [y/N] " confirm
  if [[ "$confirm" != "y" && "$confirm" != "Y" ]]; then
    echo "Aborted."
    exit 1
  fi
fi

# Update version in package.json, manifest.json, versions.json
node -e "
const fs = require('fs');

const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
pkg.version = '${NEW_VERSION}';
fs.writeFileSync('package.json', JSON.stringify(pkg, null, '\t') + '\n');

const manifest = JSON.parse(fs.readFileSync('manifest.json', 'utf8'));
manifest.version = '${NEW_VERSION}';
fs.writeFileSync('manifest.json', JSON.stringify(manifest, null, '\t') + '\n');

const versions = JSON.parse(fs.readFileSync('versions.json', 'utf8'));
versions['${NEW_VERSION}'] = manifest.minAppVersion;
fs.writeFileSync('versions.json', JSON.stringify(versions, null, '\t') + '\n');
"

echo "Updated package.json, manifest.json, versions.json"

# Build
echo "Building..."
npm run build

# Commit, tag, push
git add package.json manifest.json versions.json
git commit -m "Release ${NEW_VERSION}"
git tag "$NEW_VERSION"

echo "Pushing to origin..."
git push origin main
git push origin "$NEW_VERSION"

echo ""
echo "Done! Version ${NEW_VERSION} published."
echo "GitHub Actions will create the release draft automatically."
