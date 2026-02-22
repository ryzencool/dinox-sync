import type {
	DailyNotesSettings,
	DinoPluginSettings,
	TypeFoldersSettings,
	ZettelBoxFoldersSettings,
} from "./types";
import { createDefaultHotkeys } from "./hotkeys";

export const DEFAULT_TEMPLATE_TEXT = `---
title: {{title}}
noteId: {{noteId}}
type: {{type}}
tags:
{{#tags}}
    - {{.}}
{{/tags}}
zettelBoxes:
{{#zettelBoxes}}
    - {{.}}
{{/zettelBoxes}}
audioUrl: {{audioUrl}}
createTime: {{createTime}}
updateTime: {{updateTime}}
---
{{#audioUrl}}
![录音]({{audioUrl}})
{{/audioUrl}}

{{content}}
`;

export const API_BASE_URL = "https://dinoai.chatgo.pro";
export const API_BASE_URL_AI = "https://aisdk.chatgo.pro";
export const DEFAULT_LAST_SYNC_TIME = "1900-01-01 00:00:00";

export const DEFAULT_DAILY_NOTES_SETTINGS: DailyNotesSettings = {
	enabled: false,
	heading: "## Dinox Notes",
	insertTo: "bottom",
	createIfMissing: true,
	linkStyle: "wikilink",
	includePreview: false,
};

export const DEFAULT_TYPE_FOLDERS_SETTINGS: TypeFoldersSettings = {
	enabled: true,
	note: "note",
	material: "material",
};

export const DEFAULT_ZETTEL_BOX_FOLDERS_SETTINGS: ZettelBoxFoldersSettings = {
	enabled: false,
};

export const DEFAULT_SETTINGS: DinoPluginSettings = {
	token: "",
	isAutoSync: false,
	dir: "Dinox Sync",
	typeFolders: DEFAULT_TYPE_FOLDERS_SETTINGS,
	zettelBoxFolders: DEFAULT_ZETTEL_BOX_FOLDERS_SETTINGS,
	template: DEFAULT_TEMPLATE_TEXT,
	filenameFormat: "noteId",
	filenameTemplate: "{{title}} ({{createDate}})",
	fileLayout: "nested",
	ignoreSyncKey: "ignore_sync",
	preserveKeys: "",
	commandHotkeys: createDefaultHotkeys(),
	dailyNotes: DEFAULT_DAILY_NOTES_SETTINGS,
};
