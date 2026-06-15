#!/usr/bin/env python3
"""Preflight an Obsidian community plugin release."""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any


REQUIRED_MANIFEST_KEYS = {
    "id",
    "name",
    "version",
    "minAppVersion",
    "description",
    "author",
    "isDesktopOnly",
}


def load_json(path: Path) -> dict[str, Any]:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        raise SystemExit(f"missing required file: {path}")
    except json.JSONDecodeError as error:
        raise SystemExit(f"invalid JSON in {path}: {error}")


def run_json(command: list[str]) -> Any | None:
    try:
        result = subprocess.run(
            command,
            check=True,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
    except (FileNotFoundError, subprocess.CalledProcessError):
        return None

    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError:
        return None


def fetch_json(url: str) -> Any | None:
    try:
        with urllib.request.urlopen(url, timeout=15) as response:
            return json.loads(response.read().decode("utf-8"))
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError):
        return None


def add(checks: list[tuple[str, bool, str]], name: str, ok: bool, detail: str = "") -> None:
    checks.append((name, ok, detail))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo", default=".", help="plugin repo root")
    parser.add_argument("--no-network", action="store_true", help="skip gh/API checks")
    args = parser.parse_args()

    root = Path(args.repo).resolve()
    manifest = load_json(root / "manifest.json")
    package_json = load_json(root / "package.json") if (root / "package.json").exists() else {}
    versions = load_json(root / "versions.json") if (root / "versions.json").exists() else {}

    checks: list[tuple[str, bool, str]] = []
    version = str(manifest.get("version", ""))
    plugin_id = str(manifest.get("id", ""))

    missing = sorted(REQUIRED_MANIFEST_KEYS - set(manifest))
    add(checks, "manifest required keys", not missing, ", ".join(missing))
    add(checks, "manifest version has no v prefix", bool(version) and not version.startswith("v"), version)
    add(checks, "package version matches manifest", package_json.get("version") in (None, version), str(package_json.get("version")))
    add(checks, "versions.json includes manifest version", versions.get(version) == manifest.get("minAppVersion"), str(versions.get(version)))
    add(checks, "README.md exists", (root / "README.md").exists())
    add(checks, "LICENSE exists", (root / "LICENSE").exists())

    readme = (root / "README.md").read_text(encoding="utf-8") if (root / "README.md").exists() else ""
    readme_lower = readme.lower()
    add(checks, "README mentions token/account", "token" in readme_lower or "account" in readme_lower)
    add(checks, "README mentions network/privacy", "privacy" in readme_lower or "network" in readme_lower)

    if not args.no_network:
        repo = run_json(["gh", "repo", "view", "--json", "nameWithOwner"])
        name_with_owner = repo.get("nameWithOwner") if isinstance(repo, dict) else None
        add(checks, "gh repo detected", isinstance(name_with_owner, str) and "/" in name_with_owner, str(name_with_owner))

        release = run_json([
            "gh",
            "release",
            "view",
            version,
            "--json",
            "tagName,isDraft,isPrerelease,assets,url",
        ])
        if isinstance(release, dict):
            assets = {asset.get("name") for asset in release.get("assets", []) if isinstance(asset, dict)}
            expected_assets = {"main.js", "manifest.json"}
            if (root / "styles.css").exists():
                expected_assets.add("styles.css")
            add(checks, "matching GitHub release exists", release.get("tagName") == version, str(release.get("url")))
            add(checks, "release is published", not release.get("isDraft") and not release.get("isPrerelease"))
            add(checks, "release has required assets", expected_assets <= assets, f"expected {sorted(expected_assets)}, got {sorted(assets)}")
        else:
            add(checks, "matching GitHub release exists", False, version)

        if isinstance(name_with_owner, str):
            index = fetch_json("https://raw.githubusercontent.com/obsidianmd/obsidian-releases/master/community-plugins.json")
            if isinstance(index, list):
                listed = any(
                    isinstance(item, dict)
                    and (item.get("id") == plugin_id or item.get("repo") == name_with_owner)
                    for item in index
                )
                add(checks, "official index listing", True, "listed" if listed else "not listed yet")

    failed = False
    for name, ok, detail in checks:
        status = "OK" if ok else "FAIL"
        suffix = f" - {detail}" if detail else ""
        print(f"[{status}] {name}{suffix}")
        failed = failed or not ok

    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
