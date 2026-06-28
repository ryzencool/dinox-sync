import type { Modifier } from "obsidian";

export interface ZettelBoxRef {
	id?: string;
	name?: string;
	/** Full hierarchical path, "/"-separated from root to leaf. */
	path?: string;
}

export interface Note {
	title: string;
	createTime: string;
	updateTime?: string;
	content: string;
	noteId: string;
	type?: string;
	tags?: string[];
	isDel: boolean;
	isAudio?: boolean;
	audioUrl?: string;
	zettelBoxes?: Array<string | ZettelBoxRef>;
}

/** A single page of incrementally-synced notes returned by the sync endpoint. */
export interface NotesSyncPage {
	notes: Note[];
	nextCursor: string | null;
	hasMore: boolean;
	serverTime?: string;
}

export type DinoCommandKey = "syncAll" | "syncCurrentNote" | "createNote";

export interface DinoHotkeySetting {
	modifiers: Modifier[];
	key: string;
}

export type DinoHotkeyMap = Record<DinoCommandKey, DinoHotkeySetting>;

export interface DailyNotesSettings {
	enabled: boolean;
	heading: string;
	insertTo: "top" | "bottom";
	createIfMissing: boolean;
	linkStyle: "wikilink" | "embed";
	includePreview: boolean;
}

export interface TypeFoldersSettings {
	enabled: boolean;
	note: string;
	material: string;
}

export interface ZettelBoxFoldersSettings {
	enabled: boolean;
}

export interface SyncScopeSettings {
	/** When true, only notes in the selected boxes (and their sub-boxes) sync. */
	enabled: boolean;
	selectedBoxIds: string[];
}

/** A card box as returned by the zettelboxes endpoint, used to build the tree. */
export interface ZettelBoxNode {
	id: string;
	name: string;
	parentId: string | null;
	path: string | null;
	priority: number;
}

export interface DinoPluginSettings {
	token: string;
	isAutoSync: boolean;
	dir: string;
	typeFolders: TypeFoldersSettings;
	zettelBoxFolders: ZettelBoxFoldersSettings;
	syncScope: SyncScopeSettings;
	template: string;
	filenameFormat: "noteId" | "title" | "time" | "titleDate" | "template";
	filenameTemplate: string;
	fileLayout: "flat" | "nested";
	ignoreSyncKey: string;
	preserveKeys: string;
	commandHotkeys: DinoHotkeyMap;
	dailyNotes: DailyNotesSettings;
}
