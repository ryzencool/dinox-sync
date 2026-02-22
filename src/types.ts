import type { Modifier } from "obsidian";

export interface ZettelBoxRef {
	id?: string;
	name?: string;
}

export interface Note {
	title: string;
	createTime: string;
	content: string;
	noteId: string;
	type?: string;
	tags?: string[];
	isDel: boolean;
	isAudio?: boolean;
	zettelBoxes?: Array<string | ZettelBoxRef>;
	zettelboxexes?: ZettelBoxRef[];
}

export interface DayNote {
	date: string;
	notes: Note[];
}

export interface GetNoteApiResult {
	code: string;
	msg?: string;
	data: DayNote[];
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

export interface DinoPluginSettings {
	token: string;
	isAutoSync: boolean;
	dir: string;
	typeFolders: TypeFoldersSettings;
	zettelBoxFolders: ZettelBoxFoldersSettings;
	template: string;
	filenameFormat: "noteId" | "title" | "time" | "titleDate" | "template";
	filenameTemplate: string;
	fileLayout: "flat" | "nested";
	ignoreSyncKey: string;
	preserveKeys: string;
	commandHotkeys: DinoHotkeyMap;
	dailyNotes: DailyNotesSettings;
}
