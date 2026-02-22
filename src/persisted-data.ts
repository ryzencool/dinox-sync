import { normalizePath } from "obsidian";
import {
	DEFAULT_DAILY_NOTES_SETTINGS,
	DEFAULT_LAST_SYNC_TIME,
	DEFAULT_SETTINGS,
	DEFAULT_TYPE_FOLDERS_SETTINGS,
	DEFAULT_ZETTEL_BOX_FOLDERS_SETTINGS,
} from "./constants";
import { cloneHotkeyMap } from "./hotkeys";
import { sanitizeRelativeFolderSubpath } from "./type-folders";
import type {
	DailyNotesSettings,
	DinoPluginSettings,
	TypeFoldersSettings,
	ZettelBoxFoldersSettings,
} from "./types";

export const PERSISTED_SCHEMA_VERSION = 2 as const;

type JsonRecord = Record<string, unknown>;

function isJsonRecord(value: unknown): value is JsonRecord {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

export interface PersistedPluginState {
	lastSyncTime: string;
	notePathById: Record<string, string>;
}

export interface PersistedPluginDataV2 {
	schemaVersion: typeof PERSISTED_SCHEMA_VERSION;
	settings: DinoPluginSettings;
	state: PersistedPluginState;
}

export type PersistedPluginData = PersistedPluginDataV2;

export function normalizeNotePathById(value: unknown): Record<string, string> {
	if (!value || typeof value !== "object") {
		return {};
	}
	const record = value as Record<string, unknown>;
	const normalized: Record<string, string> = {};
	for (const [noteId, maybePath] of Object.entries(record)) {
		if (typeof noteId !== "string" || !noteId.trim()) {
			continue;
		}
		if (typeof maybePath !== "string" || !maybePath.trim()) {
			continue;
		}
		normalized[noteId.trim()] = normalizePath(maybePath.trim());
	}
	return normalized;
}

function normalizeTypeFoldersSettings(value: unknown): TypeFoldersSettings {
	const record = isJsonRecord(value) ? value : {};
	const enabled =
		typeof record.enabled === "boolean"
			? record.enabled
			: DEFAULT_TYPE_FOLDERS_SETTINGS.enabled;
	const note =
		sanitizeRelativeFolderSubpath(record.note) ??
		DEFAULT_TYPE_FOLDERS_SETTINGS.note;
	const material =
		sanitizeRelativeFolderSubpath(record.material) ??
		DEFAULT_TYPE_FOLDERS_SETTINGS.material;
	if (note === material) {
		return { ...DEFAULT_TYPE_FOLDERS_SETTINGS, enabled };
	}
	return { enabled, note, material };
}

function normalizeZettelBoxFoldersSettings(
	value: unknown
): ZettelBoxFoldersSettings {
	const record = isJsonRecord(value) ? value : {};
	return {
		enabled:
			typeof record.enabled === "boolean"
				? record.enabled
				: DEFAULT_ZETTEL_BOX_FOLDERS_SETTINGS.enabled,
	};
}

function normalizeDailyNotesSettings(value: unknown): DailyNotesSettings {
	const record = isJsonRecord(value) ? value : {};
	const insertTo =
		record.insertTo === "top" || record.insertTo === "bottom"
			? record.insertTo
			: DEFAULT_DAILY_NOTES_SETTINGS.insertTo;
	const linkStyle =
		record.linkStyle === "wikilink" || record.linkStyle === "embed"
			? record.linkStyle
			: DEFAULT_DAILY_NOTES_SETTINGS.linkStyle;

	return {
		enabled:
			typeof record.enabled === "boolean"
				? record.enabled
				: DEFAULT_DAILY_NOTES_SETTINGS.enabled,
		heading:
			typeof record.heading === "string"
				? record.heading
				: DEFAULT_DAILY_NOTES_SETTINGS.heading,
		insertTo,
		createIfMissing:
			typeof record.createIfMissing === "boolean"
				? record.createIfMissing
				: DEFAULT_DAILY_NOTES_SETTINGS.createIfMissing,
		linkStyle,
		includePreview:
			typeof record.includePreview === "boolean"
				? record.includePreview
				: DEFAULT_DAILY_NOTES_SETTINGS.includePreview,
	};
}

export function normalizeSettings(
	value: unknown,
	defaults: DinoPluginSettings = DEFAULT_SETTINGS
): DinoPluginSettings {
	const record = isJsonRecord(value) ? value : {};
	const dir =
		typeof record.dir === "string"
			? record.dir.replace(/^\/+|\/+$/g, "").trim()
			: defaults.dir;

	const filenameFormat =
		record.filenameFormat === "noteId" ||
		record.filenameFormat === "title" ||
		record.filenameFormat === "time" ||
		record.filenameFormat === "titleDate" ||
		record.filenameFormat === "template"
			? record.filenameFormat
			: defaults.filenameFormat;

	const fileLayout =
		record.fileLayout === "flat" || record.fileLayout === "nested"
			? record.fileLayout
			: defaults.fileLayout;

	const ignoreSyncKey =
		typeof record.ignoreSyncKey === "string" &&
		record.ignoreSyncKey.trim() &&
		!/\s/.test(record.ignoreSyncKey)
			? record.ignoreSyncKey.trim()
			: defaults.ignoreSyncKey;

	const rawCommandHotkeys = isJsonRecord(record.commandHotkeys)
		? (record.commandHotkeys as Partial<DinoPluginSettings["commandHotkeys"]>)
		: undefined;

	return {
		token:
			typeof record.token === "string"
				? record.token.trim()
				: defaults.token,
		isAutoSync:
			typeof record.isAutoSync === "boolean"
				? record.isAutoSync
				: defaults.isAutoSync,
		dir: dir || defaults.dir,
		typeFolders: normalizeTypeFoldersSettings(
			record.typeFolders ?? defaults.typeFolders
		),
		zettelBoxFolders: normalizeZettelBoxFoldersSettings(
			record.zettelBoxFolders ?? defaults.zettelBoxFolders
		),
		template:
			typeof record.template === "string"
				? record.template
				: defaults.template,
		filenameFormat,
		filenameTemplate:
			typeof record.filenameTemplate === "string"
				? record.filenameTemplate
				: defaults.filenameTemplate,
		fileLayout,
		ignoreSyncKey,
		preserveKeys:
			typeof record.preserveKeys === "string"
				? record.preserveKeys
				: defaults.preserveKeys,
		commandHotkeys: cloneHotkeyMap(rawCommandHotkeys),
		dailyNotes: normalizeDailyNotesSettings(
			record.dailyNotes ?? defaults.dailyNotes
		),
	};
}

function normalizeState(value: unknown): PersistedPluginState {
	const record = isJsonRecord(value) ? value : {};
	const lastSyncTime =
		typeof record.lastSyncTime === "string" && record.lastSyncTime.trim()
			? record.lastSyncTime.trim()
			: DEFAULT_LAST_SYNC_TIME;
	return {
		lastSyncTime,
		notePathById: normalizeNotePathById(record.notePathById),
	};
}

export function normalizePersistedData(
	raw: unknown,
	defaults: DinoPluginSettings = DEFAULT_SETTINGS
): PersistedPluginDataV2 {
	const record = isJsonRecord(raw) ? raw : {};
	const schemaVersion = record.schemaVersion;

	// New schema: { schemaVersion, settings, state }
	if (
		schemaVersion === PERSISTED_SCHEMA_VERSION &&
		isJsonRecord(record.settings) &&
		isJsonRecord(record.state)
	) {
		const settings = normalizeSettings(record.settings, defaults);
		const state = normalizeState(record.state);
		return {
			schemaVersion: PERSISTED_SCHEMA_VERSION,
			settings,
			state,
		};
	}

	// Legacy schema: settings/state merged at top-level.
	const settings = normalizeSettings(record, defaults);
	const notePathById = {
		...normalizeNotePathById(record.noteMapping),
		...normalizeNotePathById(record.notePathById),
	};
	const lastSyncTime =
		typeof record.lastSyncTime === "string" && record.lastSyncTime.trim()
			? record.lastSyncTime.trim()
			: DEFAULT_LAST_SYNC_TIME;

	return {
		schemaVersion: PERSISTED_SCHEMA_VERSION,
		settings,
		state: {
			lastSyncTime,
			notePathById,
		},
	};
}

export function getNotePathByIdFromData(
	data: PersistedPluginData
): Record<string, string> {
	return data.state.notePathById;
}
