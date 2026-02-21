import { normalizePath } from "obsidian";
import { DEFAULT_TYPE_FOLDERS_SETTINGS } from "./constants";
import type { TypeFoldersSettings } from "./types";

export type DinoxFolderCategory = "note" | "material";

export interface CategorizeTypeResult {
	category: DinoxFolderCategory;
	normalizedType: string;
	isKnown: boolean;
}

export function normalizeTypeValue(value: unknown): string {
	return typeof value === "string" ? value.trim().toLowerCase() : "";
}

export function categorizeDinoxType(value: unknown): CategorizeTypeResult {
	const normalizedType = normalizeTypeValue(value);
	if (!normalizedType || normalizedType === "note") {
		return { category: "note", normalizedType, isKnown: true };
	}
	if (normalizedType === "crawl") {
		return { category: "material", normalizedType, isKnown: true };
	}
	return { category: "note", normalizedType, isKnown: false };
}

export function sanitizeRelativeFolderSubpath(value: unknown): string | null {
	if (typeof value !== "string") {
		return null;
	}
	const trimmed = value.trim();
	if (!trimmed) {
		return null;
	}

	// Normalize to Obsidian's forward-slash paths and trim leading/trailing slashes.
	const cleaned = trimmed.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
	const normalized = normalizePath(cleaned);
	if (!normalized) {
		return null;
	}
	if (normalized.startsWith("/")) {
		return null;
	}

	// Disallow traversal segments.
	const segments = normalized.split("/").filter((segment) => segment.length > 0);
	if (segments.length === 0) {
		return null;
	}
	if (segments.some((segment) => segment === "." || segment === "..")) {
		return null;
	}

	return normalized;
}

function getSanitizedTypeFolderNames(typeFolders: TypeFoldersSettings): {
	note: string;
	material: string;
} {
	let note =
		sanitizeRelativeFolderSubpath(typeFolders.note) ??
		DEFAULT_TYPE_FOLDERS_SETTINGS.note;
	let material =
		sanitizeRelativeFolderSubpath(typeFolders.material) ??
		DEFAULT_TYPE_FOLDERS_SETTINGS.material;

	if (note === material) {
		// Keep behavior deterministic and avoid mixing categories by accident.
		note = DEFAULT_TYPE_FOLDERS_SETTINGS.note;
		material = DEFAULT_TYPE_FOLDERS_SETTINGS.material;
	}

	return { note, material };
}

export function resolveCategoryBaseDir(args: {
	baseDir: string;
	typeFolders: TypeFoldersSettings;
	category: DinoxFolderCategory;
}): string {
	const baseDir = normalizePath(args.baseDir);
	if (!args.typeFolders?.enabled) {
		return baseDir;
	}
	const names = getSanitizedTypeFolderNames(args.typeFolders);
	const subdir = args.category === "material" ? names.material : names.note;
	return normalizePath(`${baseDir}/${subdir}`);
}

