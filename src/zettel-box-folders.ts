import type { Note } from "./types";
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

function extractNameFromBoxEntry(entry: unknown): string | null {
	if (typeof entry === "string") {
		const trimmed = entry.trim();
		if (!trimmed) {
			return null;
		}
		// A raw string might be an id; only treat it as a name when it's not id-looking.
		return looksLikeLikelyId(trimmed) ? null : trimmed;
	}
	if (!isRecord(entry)) {
		return null;
	}

	if (typeof entry.name === "string" && entry.name.trim()) {
		return entry.name.trim();
	}
	if (typeof entry.zettelBoxName === "string" && entry.zettelBoxName.trim()) {
		return entry.zettelBoxName.trim();
	}

	const nested = entry.zettelBox;
	if (isRecord(nested) && typeof nested.name === "string" && nested.name.trim()) {
		return nested.name.trim();
	}

	return null;
}

function extractFirstBoxName(value: unknown): string | null {
	if (!Array.isArray(value)) {
		return null;
	}

	for (const entry of value) {
		const name = extractNameFromBoxEntry(entry);
		if (name) {
			return name;
		}
	}
	return null;
}

function extractFirstZettelBoxName(noteData: Note): string | null {
	const record = noteData as unknown as UnknownRecord;

	const fromExes =
		extractFirstBoxName(record.zettelboxexes) ??
		extractFirstBoxName(record.zettelBoxexes) ??
		extractFirstBoxName(record.zettelBoxExes);
	if (fromExes) {
		return fromExes;
	}

	// Avoid using raw ids (string arrays) as folder names; only accept objects that include `name`.
	if (Array.isArray(record.zettelBoxes)) {
		for (const entry of record.zettelBoxes) {
			if (typeof entry === "string") continue;
			const name = extractNameFromBoxEntry(entry);
			if (name) return name;
		}
	}

	return null;
}

export function resolveZettelBoxFolderSegment(args: {
	noteData: Note;
	enabled: boolean;
}): string | null {
	if (!args.enabled) {
		return null;
	}

	const rawName = extractFirstZettelBoxName(args.noteData);
	if (!rawName) {
		return null;
	}

	return sanitizeFolderSegment(rawName);
}
