import type { Note } from "./types";
import {
	extractFrontmatterList,
	splitFrontmatter,
} from "./markdown";
import { sanitizeFolderSegment } from "./utils";

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function looksLikeLikelyId(value: string): boolean {
	// Dinox ids are typically UUIDs, but handle a couple of other common id shapes too.
	const trimmed = value.trim();
	if (!trimmed) return false;

	if (
		/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
			trimmed
		)
	) {
		return true;
	}

	if (/^[0-9a-f]{32}$/i.test(trimmed)) {
		return true;
	}

	// Avoid using long purely-numeric identifiers as "names".
	if (/^\d{8,}$/.test(trimmed)) {
		return true;
	}

	return false;
}

function extractPathSegmentsFromBoxEntry(entry: unknown): string[] | null {
	if (typeof entry === "string") {
		const trimmed = entry.trim();
		if (!trimmed || looksLikeLikelyId(trimmed)) {
			return null;
		}
		// A plain string is one segment; only the structured `path` field below
		// expresses hierarchy (a box name itself may contain "/").
		return [trimmed];
	}
	if (!isRecord(entry)) {
		return null;
	}

	// Prefer the explicit hierarchical path when present.
	if (typeof entry.path === "string") {
		const segments = entry.path
			.split("/")
			.map((part) => part.trim())
			.filter((part) => part.length > 0);
		if (segments.length > 0) {
			return segments;
		}
	}

	if (typeof entry.name === "string" && entry.name.trim()) {
		return [entry.name.trim()];
	}
	if (typeof entry.zettelBoxName === "string" && entry.zettelBoxName.trim()) {
		return [entry.zettelBoxName.trim()];
	}

	const nested = entry.zettelBox;
	if (isRecord(nested) && typeof nested.name === "string" && nested.name.trim()) {
		return [nested.name.trim()];
	}

	return null;
}

function extractFirstBoxSegments(value: unknown): string[] | null {
	if (!Array.isArray(value)) {
		return null;
	}

	for (const entry of value) {
		const segments = extractPathSegmentsFromBoxEntry(entry);
		if (segments && segments.length > 0) {
			return segments;
		}
	}
	return null;
}

function extractFirstZettelBoxSegments(noteData: Note): string[] | null {
	const record = noteData as unknown as UnknownRecord;
	const topLevel = extractFirstBoxSegments(record.zettelBoxes);
	if (topLevel) {
		return topLevel;
	}

	// Fallback for content that only embeds `zettelBoxes` into frontmatter.
	const split = splitFrontmatter(noteData.content ?? "");
	return extractFirstBoxSegments(
		extractFrontmatterList(split.frontmatter, "zettelBoxes")
	);
}

/**
 * Resolve the (possibly multi-level) folder path for a note's first zettel box.
 * Each hierarchy level is sanitized independently and kept as a nested folder,
 * e.g. "研究/AI/LLM".
 */
export function resolveZettelBoxFolderPath(args: {
	noteData: Note;
	enabled: boolean;
}): string | null {
	if (!args.enabled) {
		return null;
	}

	const segments = extractFirstZettelBoxSegments(args.noteData);
	if (!segments || segments.length === 0) {
		return null;
	}

	const sanitized = segments
		.map((segment) => sanitizeFolderSegment(segment))
		.filter((segment): segment is string => !!segment);

	if (sanitized.length === 0) {
		return null;
	}
	return sanitized.join("/");
}
