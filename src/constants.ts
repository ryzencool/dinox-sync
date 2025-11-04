import type { DailyNotesSettings, DinoPluginSettings } from "./types";
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

export const DEFAULT_DAILY_NOTES_SETTINGS: DailyNotesSettings = {
	enabled: false,
	heading: "## Dinox Notes",
	insertTo: "bottom",
	createIfMissing: true,
	linkStyle: "wikilink",
	includePreview: false,
};

export const DEFAULT_SETTINGS: DinoPluginSettings = {
	token: "",
	isAutoSync: false,
	dir: "Dinox Sync",
	template: DEFAULT_TEMPLATE_TEXT,
	filenameFormat: "noteId",
	filenameTemplate: "{{title}} ({{createDate}})",
	fileLayout: "nested",
	ignoreSyncKey: "ignore_sync",
	preserveKeys: "",
	commandHotkeys: createDefaultHotkeys(),
	dailyNotes: DEFAULT_DAILY_NOTES_SETTINGS,
};
