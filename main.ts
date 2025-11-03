import {
    App,
    Notice,
    Plugin,
    PluginSettingTab,
    Setting,
    requestUrl,
    Editor,
    MarkdownView,
    Menu,
    MenuItem,
    normalizePath,
    TFile,
    TFolder,
    Hotkey,
    Modifier,
    Command,
    ButtonComponent,
    Platform,
    Scope,
    KeymapEventHandler,
} from "obsidian";
import {
    getCurrentLocale,
    translate,
    type LocaleCode,
    type TranslationKey,
    type TranslationVars,
} from "./i18n";
// import 'bigint-polyfill'; // Removed, likely unnecessary

// --- Interfaces ---
interface Note {
	title: string;
	createTime: string; // Assuming ISO string or compatible
	content: string; // Content *as received from API*, assuming template applied server-side
	noteId: string; // Unique ID from Dinox
	tags?: string[]; // Made optional as not used in core logic here
	isDel: boolean;
	isAudio?: boolean; // Made optional
	zettelBoxes?: string[]; // Made optional
}

interface DayNote {
	date: string; // e.g., "YYYY-MM-DD"
	notes: Note[];
}

interface GetNoteApiResult {
	code: string;
	msg?: string; // Capture potential error message from API
	data: DayNote[];
}

// Settings Interface - Simplified to match original state needs
interface DinoPluginSettings {
	token: string;
	isAutoSync: boolean;
	dir: string; // Sync base directory
	template: string; // Content template (sent to API)
	filenameFormat: "noteId" | "title" | "time";
	fileLayout: "flat" | "nested";
	ignoreSyncKey: string;
	preserveKeys: string; // <<< New setting: Comma-separated keys to preserve
	commandHotkeys: DinoHotkeyMap;

	// Removed lastSyncTime and noteMapping - will load/save dynamically like original
}

type DinoCommandKey = "syncAll" | "syncCurrentNote" | "createNote";

interface DinoHotkeySetting {
	modifiers: Modifier[];
	key: string;
}

type DinoHotkeyMap = Record<DinoCommandKey, DinoHotkeySetting>;

// --- Constants ---
// Default template text for the settings UI
const DEFAULT_TEMPLATE_TEXT = `---
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

function createEmptyHotkey(): DinoHotkeySetting {
	return { modifiers: [], key: "" };
}

function createDefaultHotkeys(): DinoHotkeyMap {
	return {
		syncAll: createEmptyHotkey(),
		syncCurrentNote: createEmptyHotkey(),
		createNote: createEmptyHotkey(),
	};
}

const DEFAULT_SETTINGS: DinoPluginSettings = {
	token: "",
	isAutoSync: false,
	dir: "Dinox Sync",
	template: DEFAULT_TEMPLATE_TEXT,
	filenameFormat: "noteId",
	fileLayout: "nested",
	ignoreSyncKey: "ignore_sync",
	preserveKeys: "",
	commandHotkeys: createDefaultHotkeys(),
};

const API_BASE_URL = "https://dinoai.chatgo.pro";
const API_BASE_URL_AI = "https://aisdk.chatgo.pro";
const VALID_MODIFIERS: Modifier[] = ["Mod", "Ctrl", "Meta", "Shift", "Alt"];
const MODIFIER_ORDER: Modifier[] = ["Mod", "Ctrl", "Meta", "Shift", "Alt"];

function normalizeKeyValue(key: string): string {
	if (!key) return "";
	if (key === "Esc") return "Escape";
	if (key === "Space") return " ";
	if (key.length === 1) return key.toUpperCase();
	return key;
}

function sanitizeHotkeySetting(
	setting: DinoHotkeySetting | undefined
): DinoHotkeySetting {
	if (!setting) return createEmptyHotkey();
	const keyValue =
		typeof setting.key === "string" ? normalizeKeyValue(setting.key) : "";
	const rawModifiers = Array.isArray(setting.modifiers)
		? setting.modifiers
		: [];
	const deduped = new Set<Modifier>();
	for (const maybeMod of rawModifiers) {
		if (
			typeof maybeMod === "string" &&
			(VALID_MODIFIERS as string[]).includes(maybeMod) &&
			!deduped.has(maybeMod as Modifier)
		) {
			deduped.add(maybeMod as Modifier);
		}
	}
	return {
		key: keyValue,
		modifiers: Array.from(deduped).sort(
			(a, b) => MODIFIER_ORDER.indexOf(a) - MODIFIER_ORDER.indexOf(b)
		),
	};
}

function cloneHotkeyMap(map?: Partial<DinoHotkeyMap>): DinoHotkeyMap {
	return {
		syncAll: sanitizeHotkeySetting(map?.syncAll),
		syncCurrentNote: sanitizeHotkeySetting(map?.syncCurrentNote),
		createNote: sanitizeHotkeySetting(map?.createNote),
	};
}

// Ensure safe error message extraction without assuming Error type
function getErrorMessage(error: unknown): string {
    if (error instanceof Error && typeof error.message === "string") {
        return error.message;
    }
    try {
        return JSON.stringify(error);
    } catch {
        return String(error);
    }
}

// Original formatDate function
function formatDate(date: Date): string {
	const year = date.getFullYear();
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	const hours = String(date.getHours()).padStart(2, "0");
	const minutes = String(date.getMinutes()).padStart(2, "0");
	const seconds = String(date.getSeconds()).padStart(2, "0");
	return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

// Keep sanitization for robustness
function sanitizeFilename(name: string): string {
	if (!name) return "Untitled";
	let sanitized = name.replace(/[\\/:*?"<>|#^\[\]]/g, "-");
	sanitized = sanitized.replace(/[\s-]+/g, "-");
	sanitized = sanitized.trim().replace(/^-+|-+$/g, "");
	sanitized = sanitized.substring(0, 100);
	if (sanitized === "." || sanitized === "..") return "Untitled";
	return sanitized || "Untitled";
}

// --- Plugin Class ---
export default class DinoPlugin extends Plugin {
	settings: DinoPluginSettings;
	statusBarItemEl: HTMLElement;
	isSyncing = false; // Prevent concurrent syncs
	private currentLocale: LocaleCode = "en";
	private commandRefs: Partial<Record<DinoCommandKey, Command>> = {};
	private hotkeyScope: Scope | null = null;
	private hotkeyHandlers: Partial<Record<DinoCommandKey, KeymapEventHandler>> =
		{};
	private activeHotkeyCapture:
		| {
				commandKey: DinoCommandKey;
				listener: (event: KeyboardEvent) => void;
				displayEl: HTMLElement;
		  }
		| null = null;
	private autoSyncIntervalId: number | null = null;

	public refreshLocale(): void {
		this.currentLocale = getCurrentLocale(this.app);
		this.updateStatusBarLabel();
	}

	public t(key: TranslationKey, vars?: TranslationVars): string {
		return translate(this.currentLocale, key, vars);
	}

	private updateStatusBarLabel(): void {
		if (!this.statusBarItemEl) {
			return;
		}
		const label = this.t("statusBar.ariaLabel");
		this.statusBarItemEl.setAttribute("aria-label", label);
		this.statusBarItemEl.setText(
			this.isSyncing
				? this.t("statusBar.syncing")
				: this.t("statusBar.text")
		);
	}

	private setStatusBarSyncingState(isSyncing: boolean): void {
		this.isSyncing = isSyncing;
		this.updateStatusBarLabel();
	}

	getHotkeyDisplay(commandKey: DinoCommandKey): string {
		const sanitized = sanitizeHotkeySetting(
			this.settings.commandHotkeys?.[commandKey]
		);
		if (!sanitized.key) {
			return "";
		}
		return this.formatHotkey(sanitized);
	}

	private formatHotkey(setting: DinoHotkeySetting): string {
		const parts: string[] = [...setting.modifiers];
		const keyLabel = this.formatKeyLabel(setting.key);
		parts.push(keyLabel);
		return parts.join("+");
	}

	updateCommandHotkeys(commandKey: DinoCommandKey): void {
		const command = this.commandRefs[commandKey];
		if (!command) return;
		const hotkeys = this.getHotkeysForCommand(commandKey);
		command.hotkeys = hotkeys;
		this.refreshHotkeyBinding(commandKey);
	}

	private getHotkeysForCommand(commandKey: DinoCommandKey): Hotkey[] {
		const config = this.settings.commandHotkeys?.[commandKey];
		if (!config || !config.key) {
			return [];
		}
		return [
			{
				key: config.key,
				modifiers: [...config.modifiers],
			},
		];
	}

	private applyAllCommandHotkeys(): void {
		(["syncAll", "syncCurrentNote", "createNote"] as DinoCommandKey[]).forEach(
			(commandKey) => this.updateCommandHotkeys(commandKey)
		);
	}

	private formatKeyLabel(key: string): string {
		if (!key) return "";
		if (key === " ") return "Space";
		if (key === "Escape") return "Esc";
		if (key.length === 1) return key.toUpperCase();
		return key.replace(/^\w/, (char) => char.toUpperCase());
	}

	private ensureHotkeyScope(): Scope {
		if (!this.hotkeyScope) {
			const scope = new Scope(this.app.scope);
			this.hotkeyScope = scope;
			this.app.keymap.pushScope(scope);
		}
		return this.hotkeyScope;
	}

	private refreshHotkeyBinding(commandKey: DinoCommandKey): void {
		const existing = this.hotkeyHandlers[commandKey];
		if (existing && this.hotkeyScope) {
			this.hotkeyScope.unregister(existing);
		}
		delete this.hotkeyHandlers[commandKey];

		const hotkey = sanitizeHotkeySetting(
			this.settings.commandHotkeys?.[commandKey]
		);
		if (!hotkey.key) {
			return;
		}

		const scope = this.ensureHotkeyScope();
		const handler = scope.register(hotkey.modifiers, hotkey.key, (evt) => {
			this.triggerHotkeyCommand(commandKey);
			return false;
		});
		this.hotkeyHandlers[commandKey] = handler;
	}

	private triggerHotkeyCommand(commandKey: DinoCommandKey): void {
		switch (commandKey) {
			case "syncAll":
				void this.syncNotes();
				break;
			case "syncCurrentNote": {
				const view =
					this.app.workspace.getActiveViewOfType(MarkdownView);
				if (view?.file) {
					this.syncToDinox(view.editor, view.file);
				}
				break;
			}
			case "createNote": {
				const view =
					this.app.workspace.getActiveViewOfType(MarkdownView);
				if (view?.file) {
					const fileCache =
						this.app.metadataCache.getFileCache(view.file);
					const frontmatter = fileCache?.frontmatter;
					if (!frontmatter?.noteId) {
						this.createNoteToDinox(view.editor, view.file);
					}
				}
				break;
			}
		}
	}

	private isModifierKeyName(key: string): boolean {
		return (
			key === "Shift" ||
			key === "Alt" ||
			key === "Control" ||
			key === "Meta" ||
			key === "OS"
		);
	}

	private eventToHotkeySetting(
		event: KeyboardEvent
	): DinoHotkeySetting | null {
		const normalizedKey = normalizeKeyValue(event.key);
		if (!normalizedKey || this.isModifierKeyName(event.key)) {
			return null;
		}

		const modifiers: Modifier[] = [];
		const isMac = Platform.isMacOS;

		if (event.shiftKey) modifiers.push("Shift");
		if (event.altKey) modifiers.push("Alt");
		if (isMac) {
			if (event.metaKey) modifiers.push("Mod");
			if (event.ctrlKey) modifiers.push("Ctrl");
		} else {
			if (event.ctrlKey) modifiers.push("Mod");
			if (event.metaKey) modifiers.push("Meta");
		}

		return sanitizeHotkeySetting({
			key: normalizedKey,
			modifiers,
		});
	}

	beginHotkeyCapture(
		commandKey: DinoCommandKey,
		displayEl: HTMLElement,
		onResolve: (setting: DinoHotkeySetting) => void,
		onClear: () => void
	): void {
		this.cancelHotkeyCapture(true);
		displayEl.textContent = this.t("settings.hotkeys.prompt");

		const listener = (event: KeyboardEvent) => {
			event.preventDefault();
			event.stopPropagation();

			if (event.key === "Escape") {
				this.cancelHotkeyCapture(true);
				return;
			}

			if (
				event.key === "Backspace" &&
				!event.metaKey &&
				!event.ctrlKey &&
				!event.shiftKey &&
				!event.altKey
			) {
				this.cancelHotkeyCapture(false);
				void onClear();
				return;
			}

			const hotkey = this.eventToHotkeySetting(event);
			if (!hotkey) {
				return;
			}

			this.cancelHotkeyCapture(false);
			void onResolve(hotkey);
		};

		this.activeHotkeyCapture = { commandKey, listener, displayEl };
		window.addEventListener("keydown", listener, true);
	}

	cancelHotkeyCapture(restoreLabel: boolean): void {
		if (!this.activeHotkeyCapture) {
			return;
		}

		window.removeEventListener(
			"keydown",
			this.activeHotkeyCapture.listener,
			true
		);

		if (restoreLabel) {
			const label =
				this.getHotkeyDisplay(this.activeHotkeyCapture.commandKey) ||
				this.t("settings.hotkeys.notSet");
			this.activeHotkeyCapture.displayEl.textContent = label;
		}

		this.activeHotkeyCapture = null;
	}

	refreshAutoSyncSchedule(): void {
		this.stopAutoSync();
		if (!this.settings.isAutoSync) {
			return;
		}

		const intervalId = window.setInterval(async () => {
			if (!this.isSyncing) {
				await this.syncNotes();
			}
		}, 30 * 60 * 1000);

		this.autoSyncIntervalId = intervalId;
		this.registerInterval(intervalId);
	}

	private stopAutoSync(): void {
		if (this.autoSyncIntervalId !== null) {
			window.clearInterval(this.autoSyncIntervalId);
			this.autoSyncIntervalId = null;
		}
	}

	private teardownHotkeyScope(): void {
		if (!this.hotkeyScope) {
			return;
		}
		Object.values(this.hotkeyHandlers).forEach((handler) => {
			if (handler) {
				this.hotkeyScope?.unregister(handler);
			}
		});
		this.hotkeyHandlers = {};
		this.app.keymap.popScope(this.hotkeyScope);
		this.hotkeyScope = null;
	}

	private areHotkeysEqual(
		first: DinoHotkeySetting,
		second: DinoHotkeySetting
	): boolean {
		if (first.key !== second.key) {
			return false;
		}
		if (first.modifiers.length !== second.modifiers.length) {
			return false;
		}
		return first.modifiers.every(
			(modifier, index) => modifier === second.modifiers[index]
		);
	}

	async applyHotkeySetting(
		commandKey: DinoCommandKey,
		setting: DinoHotkeySetting | null
	): Promise<boolean> {
		const sanitized = sanitizeHotkeySetting(setting ?? createEmptyHotkey());
		const current = sanitizeHotkeySetting(
			this.settings.commandHotkeys?.[commandKey]
		);
		if (this.areHotkeysEqual(current, sanitized)) {
			return false;
		}
		this.settings.commandHotkeys[commandKey] = sanitized;
		await this.saveSettings();
		this.updateCommandHotkeys(commandKey);
		return true;
	}

	async onload() {
		await this.loadSettings(); // Loads settings like token, dir etc.
		this.refreshLocale();

		// Status Bar
		this.statusBarItemEl = this.addStatusBarItem();
		this.updateStatusBarLabel();
		this.registerDomEvent(this.statusBarItemEl, "click", async () => {
			if (this.isSyncing) {
				new Notice(this.t("notice.syncInProgress"));
				return;
			}
			await this.syncNotes();
		});

		// Settings Tab
		this.addSettingTab(new DinoSettingTab(this.app, this));

		// Commands
		this.commandRefs.syncAll = this.addCommand({
			id: "dinox-sync-command",
			name: this.t("command.syncAll"),
			hotkeys: this.getHotkeysForCommand("syncAll"),
			callback: async () => {
				if (!this.isSyncing) {
					await this.syncNotes();
				} else {
					new Notice(this.t("notice.syncInProgress"));
				}
			},
		});

		this.addCommand({
			id: "dinox-reset-sync-command",
			name: this.t("command.resetSync"),
			callback: async () => {
				// Reset only lastSyncTime as per original logic
				const pData = (await this.loadData()) || {};
				await this.saveData({
					...pData, // Preserve other potential saved data (like settings)
					lastSyncTime: "1900-01-01 00:00:00", // Use the original reset value
				});
				new Notice(this.t("notice.syncReset"));
			},
		});

		this.addCommand({
			id: "dinox-sync-note-to-local-command",
			name: this.t("command.syncToLocal"),
			callback: async () => {
				if (!this.isSyncing) {
					try {
						await this.syncNotes();
					} catch (error) {
						console.error("Dinox: Sync failed:", error);
						new Notice(
							this.t("notice.syncCommandFailed", {
								error: getErrorMessage(error),
							})
						);
					}
				} else {
					new Notice(this.t("notice.syncInProgress"));
				}
			},
		});

		// Add command for syncToDinox with keyboard shortcut
		this.commandRefs.syncCurrentNote = this.addCommand({
			id: "dinox-sync-current-note-command",
			name: this.t("command.syncCurrentNote"),
			hotkeys: this.getHotkeysForCommand("syncCurrentNote"),
			checkCallback: (checking: boolean) => {
				const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
				if (activeView && activeView.file) {
					if (!checking) {
						this.syncToDinox(activeView.editor, activeView.file);
					}
					return true;
				}
				return false;
			},
		});

		// Add command for createNoteToDinox with keyboard shortcut
		this.commandRefs.createNote = this.addCommand({
			id: "dinox-create-note-command",
			name: this.t("command.createNote"),
			hotkeys: this.getHotkeysForCommand("createNote"),
			checkCallback: (checking: boolean) => {
				const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
				if (activeView && activeView.file) {
					const fileCache = this.app.metadataCache.getFileCache(activeView.file);
					const frontmatter = fileCache?.frontmatter;
					const noteId = frontmatter?.noteId;
					
					// Only show if no noteId exists
					if (!noteId) {
						if (!checking) {
							this.createNoteToDinox(activeView.editor, activeView.file);
						}
						return true;
					}
				}
				return false;
			},
		});

		this.applyAllCommandHotkeys();
		this.refreshAutoSyncSchedule();

		// Editor Menu Items (Push to Dinox - Kept as potentially useful)
		this.registerEvent(
			this.app.workspace.on(
				"editor-menu",
				(menu: Menu, editor: Editor) => {
					// Send Selection
					if (editor?.getSelection()?.length > 0) {
						// ... (sendToDinox menu item code from previous version) ...
						const selectedText = editor.getSelection();
						const trimText =
							selectedText.length > 15
								? selectedText.substring(0, 7) +
								  "..." +
								  selectedText.substring(
										selectedText.length - 5
								  )
								: selectedText;

						menu.addItem((item: MenuItem) => {
							item.setTitle(
								this.t("menu.sendSelection", { selection: trimText })
							)
								.setIcon("upload") // Optional icon
								.onClick(() => this.sendToDinox(selectedText));
						});
					}
					// Create into Dinox - Only show if current note doesn't have noteId
					const file = this.app.workspace.getActiveFile();
					if (editor && file) {
						const fileCache = this.app.metadataCache.getFileCache(file);
						const frontmatter = fileCache?.frontmatter;
						const noteId = frontmatter?.noteId;
						
						if (!noteId) {
							menu.addItem((item: MenuItem) => {
								item.setTitle(this.t("menu.create"))
									.setIcon("plus") // Optional icon
									.onClick(() => this.createNoteToDinox(editor, file));
							});
						}
					}
					// Sync Current Note
					if (editor && file) {
						// ... (syncToDinox menu item code from previous version) ...
						menu.addItem((item: MenuItem) => {
							item.setTitle(this.t("menu.syncCurrent"))
								.setIcon("sync") // Optional icon
								.onClick(() => this.syncToDinox(editor, file)); // Pass file
						});
					}
				}
			)
		);
	}

	onunload() {
		this.cancelHotkeyCapture(false);
		this.stopAutoSync();
		this.teardownHotkeyScope();
	}

	async loadSettings() {
		const stored = (await this.loadData()) as
			| Partial<DinoPluginSettings>
			| undefined;
		this.settings = {
			...DEFAULT_SETTINGS,
			...stored,
			commandHotkeys: cloneHotkeyMap(stored?.commandHotkeys),
		};
		// Ensure ignoreSyncKey has a default if loading old data without it
		if (!this.settings.ignoreSyncKey) {
			this.settings.ignoreSyncKey = DEFAULT_SETTINGS.ignoreSyncKey;
		}
		if (this.settings.preserveKeys === undefined) {
			this.settings.preserveKeys = DEFAULT_SETTINGS.preserveKeys;
		}
	}

	async saveSettings() {
		// Saves only the defined settings object
		const pData = (await this.loadData()) || {};
		this.settings.commandHotkeys = cloneHotkeyMap(
			this.settings.commandHotkeys
		);
		await this.saveData({ ...pData, ...this.settings }); // Merge settings with existing data
	}

	// --- Core Sync Logic (Adhering to Original Flow) ---

	async syncNotes() {
		if (this.isSyncing) {
			new Notice(this.t("notice.syncInProgress"));
			return;
		}
		if (!this.settings.token) {
			new Notice(this.t("notice.tokenMissing"));
			return;
		}

		this.setStatusBarSyncingState(true);
		this.statusBarItemEl.addClass("is-syncing");
		const notice = new Notice(this.t("notice.syncStarting"), 0);

		const syncStartTime = new Date(); // Use this for the *next* lastSyncTime
		let processedCount = 0;
		let deletedCount = 0;
		let errorOccurred = false;
		const pData = (await this.loadData()) || {}; // Load existing data, including lastSyncTime

		try {
			// 1. Get last sync time from saved data (original logic)
			let lastSyncTime = "1900-01-01 00:00:00";
			if (pData.lastSyncTime && pData.lastSyncTime !== "") {
				try {
					// Attempt to parse and format, fallback if invalid
					const lTime = new Date(pData.lastSyncTime);
					lastSyncTime = formatDate(lTime);
				} catch (e) {
					console.warn(
						"Dinox: Invalid stored lastSyncTime, using default.",
						pData.lastSyncTime
					);
					lastSyncTime = "1900-01-01 00:00:00";
				}
			}
			// 2. Fetch data from API (using original request structure)
			const dayNotes = await this.fetchNotesFromApi(lastSyncTime);

			// 3. Ensure base sync directory exists
			await this.ensureFolderExists(
				this.settings.dir || DEFAULT_SETTINGS.dir
			);

			// 4. Process API response (using delete + create)
			const processingResults = await this.processApiResponse(dayNotes);
			processedCount = processingResults.processed;
			deletedCount = processingResults.deleted;

			// 5. Update last sync time *only on success* (original logic)
			const newLastSyncTime = formatDate(syncStartTime);
			await this.saveData({
				...pData, // Preserve existing saved data
				...this.settings, // Save current settings too
				lastSyncTime: newLastSyncTime, // Update the timestamp
			});
			notice.setMessage(
				this.t("notice.syncComplete", {
					processed: processedCount,
					deleted: deletedCount,
				})
			);
		} catch (error) {
			errorOccurred = true;
			console.error("Dinox: Sync failed:", error);
			notice.setMessage(
				this.t("notice.syncFailed", { error: getErrorMessage(error) })
			);
			// Do NOT update lastSyncTime on error
		} finally {
			this.setStatusBarSyncingState(false);
			this.statusBarItemEl.removeClass("is-syncing");
			setTimeout(() => notice.hide(), errorOccurred ? 10000 : 5000);
		}
	}

	async fetchNotesFromApi(lastSyncTime: string): Promise<DayNote[]> {
		// Strict adherence to original request body
		const requestBody = JSON.stringify({
			template: this.settings.template,
			noteId: 0, // Original fixed value
			lastSyncTime: lastSyncTime,
		});

		// Avoid logging request body/token to protect user privacy

		try {
			const resp = await requestUrl({
				url: `${API_BASE_URL}/openapi/v5/notes`,
				method: "POST",
				headers: {
					Authorization: this.settings.token,
					"Content-Type": "application/json",
				},
				body: requestBody,
			});

			// Keep improved error checking
			if (resp.status !== 200) {
				throw new Error(
					`API HTTP Error: Status ${
						resp.status
					}\n${resp.text.substring(0, 200)}`
				);
			}

			const result = resp.json as GetNoteApiResult; // Use .json directly

			if (!result || result.code !== "000000") {
				const errorMsg = result?.msg || "Unknown API error structure";
				throw new Error(
					`API Logic Error: Code ${
						result?.code || "N/A"
					}\n${errorMsg}`
				);
			}

			return result.data || [];
		} catch (error) {
			console.error("Dinox: Error fetching from API:", error);
			throw error;
		}
	}

	async processApiResponse(
		dayNotes: DayNote[]
	): Promise<{ processed: number; deleted: number }> {
		let processed = 0;
		let deleted = 0;
		const baseDir = normalizePath(
			this.settings.dir?.trim() || DEFAULT_SETTINGS.dir
		);

		for (const dayData of dayNotes.reverse()) {
			let datePath = baseDir; // Default for flat layout
			if (this.settings.fileLayout === "nested") {
				// Ensure date format is path-safe (YYYY-MM-DD is usually safe)
				const safeDate = dayData.date.replace(/[^0-9-]/g, ""); // Basic sanitization
				datePath = normalizePath(`${baseDir}/${safeDate}`);
				await this.ensureFolderExists(datePath);
			}

			for (const noteData of dayData.notes.reverse()) {
				try {
					const result = await this.handleNoteProcessing(
						noteData,
						datePath
					);
					if (result === "deleted") deleted++;
					else if (result === "processed") processed++;
				} catch (noteError) {
					console.error(
						`Dinox: Failed to process note ${noteData.noteId}:`,
						noteError
					);
					const shortId = noteData.noteId.substring(0, 8);
					new Notice(this.t("notice.processNoteFailed", { noteId: shortId }), 5000);
					// Decide whether to stop sync or continue processing other notes
					// throw noteError; // Uncomment to stop entire sync on one note failure
				}
			}
		}
		return { processed, deleted };
	}

	// Combined handling function mirroring original logic
	async handleNoteProcessing(
		noteData: Note,
		datePath: string
	): Promise<"processed" | "deleted" | "skipped"> {
		const sourceId = noteData.noteId;
		const ignoreKey = this.settings.ignoreSyncKey; // Get the configured key name
		const preserveKeysSetting = this.settings.preserveKeys || "";
		const keysToPreserve = preserveKeysSetting
			.split(",")
			.map((k) => k.trim())
			.filter((k) => k !== "");
		// --- Generate Filename (original logic + sanitization) ---
		let baseFilename = "";
		const format = this.settings.filenameFormat;

		if (format === "noteId") {
			baseFilename = sourceId.replace(/-/g, "_");
		} else if (format === "title") {
			if (noteData.title && noteData.title.trim() !== "") {
				baseFilename = sanitizeFilename(noteData.title);
			} else {
				baseFilename = sourceId.replace(/-/g, "_"); // Fallback
			}
		} else if (format === "time") {
			try {
				const createDate = new Date(noteData.createTime);
				// Use original formatDate for filename consistency if desired, but sanitize
				baseFilename = sanitizeFilename(formatDate(createDate));
			} catch (e) {
				console.warn(
					`Dinox: Invalid createTime "${noteData.createTime}" for filename, note ${sourceId}. Falling back to noteId.`
				);
				baseFilename = sourceId.replace(/-/g, "_");
			}
		} else {
			baseFilename = sourceId.replace(/-/g, "_"); // Default fallback
		}
		// Ensure filename is not empty
		baseFilename =
			baseFilename || sourceId.replace(/-/g, "_") || "Untitled";
		const filename = `${baseFilename}.md`; // Append suffix
		const notePath = normalizePath(`${datePath}/${filename}`);

		// --- Handle Deletion or Upsert (Delete + Create) ---
		const existingFile = this.app.vault.getAbstractFileByPath(notePath);
		let propertiesToPreserve: Record<string, any> = {}; // Store properties here

		// Debug logging removed



		if (
			existingFile &&
			existingFile instanceof TFile 
		) {
			try {
				const cache = this.app.metadataCache.getFileCache(existingFile);
				const existingFrontmatter = cache?.frontmatter;
				// Debug logging removed
				if (existingFrontmatter) {
					if (ignoreKey && existingFrontmatter[ignoreKey] === true) {
						return "skipped";
					}

					if (keysToPreserve.length > 0) {
					keysToPreserve.forEach((key) => {
						if (
							Object.prototype.hasOwnProperty.call(
								existingFrontmatter,
								key
							)
						) {
							propertiesToPreserve[key] =
								existingFrontmatter[key];
						}
					});
						// Intentionally avoid noisy logs here
				}
				}
			} catch (e) {
				console.warn(
					`Dinox: Failed to read frontmatter for preserving keys from ${notePath}`,
					e
				);
				propertiesToPreserve = {}; // Reset on error
			}
		}

		if (noteData.isDel) {
			if (existingFile && existingFile instanceof TFile) {
				try {
					await this.app.fileManager.trashFile(existingFile);
					return "deleted";
				} catch (deleteError) {
					console.error(
						`Dinox: Failed to delete file ${notePath}:`,
						deleteError
					);
					throw deleteError; // Propagate error
				}
			} else {
				// Note marked deleted, but not found locally. Skip.
				return "skipped";
			}
		} else {
			// *** Check for Ignore Flag ***

			if (existingFile && existingFile instanceof TFile && ignoreKey) {
				const cache = this.app.metadataCache.getFileCache(existingFile);
				const frontmatter = cache?.frontmatter;
				if (frontmatter && frontmatter[ignoreKey] === true) {
					return "skipped"; // Skip update/delete+create for this file
				}
			}
			// Check for file path conflict (e.g., folder with same name)
			if (existingFile && !(existingFile instanceof TFile)) {
				console.error(
					`Dinox: Path ${notePath} exists but is not a file. Cannot create/update note.`
				);
				throw new Error(`Path conflict: ${notePath} is not a file.`);
			}

			const finalContent = noteData.content || "";

			try {
				let targetFile: TFile;
				if (existingFile && existingFile instanceof TFile) {
					targetFile = existingFile;
					await this.app.vault.modify(targetFile, finalContent);
				} else {
					targetFile = await this.app.vault.create(notePath, finalContent);
				}

				if (Object.keys(propertiesToPreserve).length > 0) {
					try {
						await this.app.fileManager.processFrontMatter(
							targetFile,
							(frontmatter) => {
								for (const key of Object.keys(propertiesToPreserve)) {
									frontmatter[key] = propertiesToPreserve[key];
								}
							}
						);
					} catch (frontmatterError) {
						console.warn(
							`Dinox: Failed to reapply preserved properties for ${notePath}`,
							frontmatterError
						);
					}
				}

				return "processed";
			} catch (error) {
				console.error(
					`Dinox: Failed to ${existingFile ? "update" : "create"} file ${notePath}:`,
					error
				);
				throw error; // Propagate error
			}
		}
	}

	async ensureFolderExists(folderPath: string): Promise<void> {
		const normalizedPath = normalizePath(folderPath);
		try {
			const abstractFile =
				this.app.vault.getAbstractFileByPath(normalizedPath);
			if (abstractFile) {
				if (!(abstractFile instanceof TFolder)) {
					throw new Error(
						`Sync path "${normalizedPath}" exists but is not a folder.`
					);
				}
				return;
			}

			await this.app.vault.createFolder(normalizedPath);
		} catch (error) {
			if (
				error instanceof Error &&
				/error\s+exists/i.test(error.message)
			) {
				return;
			}
			console.error(
				`Dinox: Error ensuring folder "${normalizedPath}" exists:`,
				error
			);
			throw error;
		}
	}

	// --- Push to Dinox Functions (Kept from previous version, verify endpoints/payloads) ---
	async sendToDinox(content: string) {
		// ... (Implementation from the previous full refactored code) ...
		if (!this.settings.token) {
			new Notice(this.t("notice.tokenMissing"));
			return;
		}
		new Notice(this.t("notice.selectionSending"));
		try {
			const title =
				content.split("\n")[0].substring(0, 50) ||
				"New Note from Obsidian";
			const requestBody = JSON.stringify({
				content: content, // Assuming API expects 'content' for create
				tags: [],
				title: title,
			});
			const resp = await requestUrl({
				url: `${API_BASE_URL_AI}/api/openapi/createNote`, // Verify endpoint
				method: "POST",
				headers: {
					Authorization: this.settings.token,
					"Content-Type": "application/json",
				},
				body: requestBody,
			});
			const resultJson = resp.json;
			if (resultJson.code === "000000") {
				new Notice(this.t("notice.selectionSent"));
			} else {
				console.error("Dinox send failed:", resultJson);
				const message =
					resultJson.msg ?? this.t("common.unknownError");
				new Notice(
					this.t("notice.selectionSendFailed", { message })
				);
			}
		} catch (error) {
			console.error("Dinox: Error sending content:", error);
			new Notice(
				this.t("notice.selectionSendError", {
					error: getErrorMessage(error),
				})
			);
		}
	}

	async createNoteToDinox(editor: Editor, file: TFile) {
		if (!this.settings.token) {
			new Notice(this.t("notice.tokenMissing"));
			return;
		}
		
		new Notice(this.t("notice.creatingNote"));
		
		const fileContent = await this.app.vault.cachedRead(file);
		const fileCache = this.app.metadataCache.getFileCache(file);
		
		// Extract content without frontmatter
		let contentToCreate = fileContent;
		if (fileCache?.frontmatterPosition) {
			contentToCreate = fileContent
				.substring(fileCache.frontmatterPosition.end.offset)
				.trim();
		}
		
		// Use file name as title if no title in frontmatter
		const frontmatter = fileCache?.frontmatter;
		const title = frontmatter?.title || file.basename || "New Note from Obsidian";
		
		// Extract tags from both frontmatter and content
		const allTags = this.extractAllTags(fileContent, frontmatter);
		
		try {
			const requestBody = JSON.stringify({
				content: contentToCreate,
				tags: allTags,
				title: title,
			});
			
			const resp = await requestUrl({
				url: `${API_BASE_URL_AI}/api/openapi/createNote`,
				method: "POST",
				headers: {
					Authorization: this.settings.token,
					"Content-Type": "application/json",
				},
				body: requestBody,
			});
			
			const resultJson = resp.json;
			if (resultJson.code === "000000" && resultJson.data?.noteId) {
				const createdNoteId = resultJson.data.noteId;
				
				// Add noteId to frontmatter
				await this.addNoteIdToFrontmatter(file, createdNoteId);
				
				new Notice(
					this.t("notice.createSuccess", {
						noteId: createdNoteId.substring(0, 8),
					})
				);
			} else {
				console.error("Dinox create failed:", resultJson);
				const message =
					resultJson.msg ?? this.t("common.unknownError");
				new Notice(this.t("notice.createFailed", { message }));
			}
		} catch (error) {
			console.error("Dinox: Error creating note:", error);
			new Notice(
				this.t("notice.createError", { error: getErrorMessage(error) })
			);
		}
	}
	
	extractAllTags(fileContent: string, frontmatter?: Record<string, unknown>): string[] {
		const tags = new Set<string>();
		
		// 1. Get tags from frontmatter
		const fmTagsUnknown = frontmatter ? (frontmatter as Record<string, unknown>)["tags"] : undefined;
		if (Array.isArray(fmTagsUnknown)) {
			fmTagsUnknown.forEach((tag) => {
					if (tag && typeof tag === 'string') {
						tags.add(tag.trim());
					}
				});
		}
		
		// 2. Extract hashtags from content using regex
		// Match hashtags like #标签，#reading, #生活 etc.
		// Don't match hashtags inside code blocks or at the start of headers
		const hashtagRegex = /(?:^|[\s\n])#([^\s#\[\]]+)/g;
		let match;
		
		while ((match = hashtagRegex.exec(fileContent)) !== null) {
			const tag = match[1];
			// Filter out numeric hashtags or very short ones that might be false positives
			if (tag && tag.length > 1 && !/^\d+$/.test(tag)) {
				tags.add(tag);
			}
		}
		
		return Array.from(tags);
	}

	async addNoteIdToFrontmatter(file: TFile, noteId: string) {
		try {
			await this.app.fileManager.processFrontMatter(
				file,
				(frontmatter) => {
					frontmatter.noteId = noteId;
				}
			);
		} catch (error) {
			console.error("Dinox: Error adding noteId to frontmatter:", error);
			new Notice(
				this.t("notice.frontmatterError", {
					error: getErrorMessage(error),
				})
			);
		}
	}

	async syncToDinox(editor: Editor, file: TFile) {
		// ... (Implementation from the previous full refactored code, check payload key 'contentMd' vs 'content') ...
		if (!this.settings.token) {
			new Notice(this.t("notice.tokenMissing"));
			return;
		}
		new Notice(this.t("notice.syncingNote"));
		const fileContent = await this.app.vault.cachedRead(file);
		const fileCache = this.app.metadataCache.getFileCache(file);
		const frontmatter = fileCache?.frontmatter;
		const noteId = frontmatter?.noteId || frontmatter?.source_app_id;

		if (!noteId) {
			new Notice(this.t("notice.syncNoId"));
			return;
		}

		let contentToSync = fileContent;
		if (fileCache?.frontmatterPosition) {
			contentToSync = fileContent
				.substring(fileCache.frontmatterPosition.end.offset)
				.trim();
		}

		// Extract tags from both frontmatter and content
		const allTags = this.extractAllTags(fileContent, frontmatter);
		
		// Extract title from frontmatter or use filename
		const title = frontmatter?.title || file.basename || "Untitled";

		try {
			const requestBody = JSON.stringify({
				noteId: noteId,
				contentMd: contentToSync, // Verify if API expects 'contentMd' or 'content' for update
				tags: allTags,
				title: title,
			});
			const resp = await requestUrl({
				url: `${API_BASE_URL_AI}/api/openapi/updateNote`, // Verify endpoint
				method: "POST",
				headers: {
					Authorization: this.settings.token,
					"Content-Type": "application/json",
				},
				body: requestBody,
			});
			const resultJson = resp.json;
			if (resultJson.code === "000000") {
				new Notice(
					this.t("notice.syncNoteSuccess", {
						noteId: noteId.substring(0, 8),
					})
				);
			} else {
				console.error("Dinox sync update failed:", resultJson);
				const message =
					resultJson.msg ?? this.t("common.unknownError");
				new Notice(this.t("notice.syncNoteFailed", { message }));
			}
		} catch (error) {
			console.error("Dinox: Error syncing note:", error);
			new Notice(
				this.t("notice.syncNoteError", {
					error: getErrorMessage(error),
				})
			);
		}
	}
}

// --- Settings Tab Class (Adjusted for simpler state) ---
class DinoSettingTab extends PluginSettingTab {
	plugin: DinoPlugin;

	constructor(app: App, plugin: DinoPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		this.plugin.cancelHotkeyCapture(false);
		this.plugin.refreshLocale();
		const t = this.plugin.t.bind(this.plugin);
		containerEl.empty();
		containerEl.createEl("h2", { text: t("settings.title") });

		// Token
		new Setting(containerEl)
			.setName(t("settings.token.name"))
			.setDesc(t("settings.token.desc"))
			.addText((text) =>
				text
					.setPlaceholder(t("settings.token.placeholder"))
					.setValue(this.plugin.settings.token)
					.onChange(async (value) => {
						this.plugin.settings.token = value.trim();
						await this.plugin.saveSettings(); // Saves only settings object now
					})
			);

		// Sync Directory
		new Setting(containerEl)
			.setName(t("settings.dir.name"))
			.setDesc(t("settings.dir.desc"))
			.addText((text) =>
				text
					.setPlaceholder(t("settings.dir.placeholder"))
					.setValue(this.plugin.settings.dir)
					.onChange(async (value) => {
						this.plugin.settings.dir =
							value.replace(/^\/|\/$/g, "").trim() ||
							"Dinox Sync";
						await this.plugin.saveSettings();
					})
			);

		containerEl.createEl("h3", { text: t("settings.filenameHeading") });

		// Filename Format
		new Setting(containerEl)
			.setName(t("settings.filename.name"))
			.setDesc(t("settings.filename.desc"))
			.addDropdown((dropdown) => {
				dropdown
					// Keep options, ID is generally safer if titles can change often
					.addOption("noteId", t("settings.filename.optionId"))
					.addOption("title", t("settings.filename.optionTitle"))
					.addOption("time", t("settings.filename.optionTime"))
					.setValue(this.plugin.settings.filenameFormat)
					.onChange(async (value: "noteId" | "title" | "time") => {
						this.plugin.settings.filenameFormat = value;
						await this.plugin.saveSettings();
					});
			});

		// File Layout
		new Setting(containerEl)
			.setName(t("settings.layout.name"))
			.setDesc(t("settings.layout.desc"))
			.addDropdown((dropdown) => {
				dropdown
					.addOption(
						"nested",
						t("settings.layout.optionNested")
					)
					.addOption("flat", t("settings.layout.optionFlat"))
					.setValue(this.plugin.settings.fileLayout)
					.onChange(async (value: "flat" | "nested") => {
						this.plugin.settings.fileLayout = value;
						await this.plugin.saveSettings();
					});
			});
		new Setting(containerEl)
			.setName(t("settings.ignoreKey.name"))
			.setDesc(t("settings.ignoreKey.desc"))
			.addText((text) =>
				text
					.setPlaceholder(this.plugin.settings.ignoreSyncKey)
					.setValue(this.plugin.settings.ignoreSyncKey)
					.onChange(async (value) => {
						// Basic validation: trim and ensure it's a valid potential key (simple check)
						const cleanedValue = value.trim();
						if (cleanedValue && !/\s/.test(cleanedValue)) {
							// Ensure no spaces
							this.plugin.settings.ignoreSyncKey = cleanedValue;
						} else if (!cleanedValue) {
							// Allow empty to disable feature? Or enforce default?
							this.plugin.settings.ignoreSyncKey =
								DEFAULT_SETTINGS.ignoreSyncKey; // Revert to default if cleared or invalid
							// Maybe show a notice?
							new Notice(t("notice.invalidIgnoreKeyReverted"));
							text.setValue(this.plugin.settings.ignoreSyncKey); // Update UI
						} else {
							new Notice(t("notice.invalidIgnoreKeySpaces"));
							// Keep the old value or revert to default? Let's revert.
							this.plugin.settings.ignoreSyncKey =
								DEFAULT_SETTINGS.ignoreSyncKey;
							text.setValue(this.plugin.settings.ignoreSyncKey); // Update UI
						}
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName(t("settings.preserveKeys.name"))
			.setDesc(t("settings.preserveKeys.desc"))
			.addTextArea(
				(
					text // Use TextArea for potentially longer lists
				) =>
					text
						.setPlaceholder(t("settings.preserveKeys.placeholder"))
						.setValue(this.plugin.settings.preserveKeys)
						.onChange(async (value) => {
							// Store the raw comma-separated string
							this.plugin.settings.preserveKeys = value;
							await this.plugin.saveSettings();
						})
			);
		// Content Template (Sent to API)
		new Setting(containerEl)
			.setName(t("settings.template.name"))
			.setDesc(t("settings.template.desc"))
			.addTextArea((text) => {
				text.setPlaceholder(DEFAULT_TEMPLATE_TEXT)
					.setValue(this.plugin.settings.template)
					.onChange(async (value) => {
						this.plugin.settings.template = value;
						await this.plugin.saveSettings();
					});
				text.inputEl.rows = 10;
				text.inputEl.cols = 60;
				text.inputEl.classList.add("dino-sync-template-setting");
			});

		// Auto Sync Toggle
		new Setting(containerEl)
			.setName(t("settings.autoSync.name"))
			.setDesc(t("settings.autoSync.desc"))
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.isAutoSync)
					.onChange(async (value) => {
						this.plugin.settings.isAutoSync = value;
						await this.plugin.saveSettings();
						this.plugin.refreshAutoSyncSchedule();
						new Notice(
							value
								? this.plugin.t("notice.autoSyncEnabled")
								: this.plugin.t("notice.autoSyncDisabled")
						);
					})
			);

		containerEl.createEl("h3", { text: t("settings.section.hotkeys") });
		this.addHotkeySetting(
			containerEl,
			t("settings.hotkeys.syncAll.name"),
			t("settings.hotkeys.syncAll.desc"),
			"syncAll"
		);
		this.addHotkeySetting(
			containerEl,
			t("settings.hotkeys.syncCurrent.name"),
			t("settings.hotkeys.syncCurrent.desc"),
			"syncCurrentNote"
		);
		this.addHotkeySetting(
			containerEl,
			t("settings.hotkeys.create.name"),
			t("settings.hotkeys.create.desc"),
			"createNote"
		);

		// Reset Sync Button (Simplified)
		containerEl.createEl("h3", { text: t("settings.section.advanced") });
		new Setting(containerEl)
			.setName(t("settings.advanced.reset.name"))
			.setDesc(t("settings.advanced.reset.desc"))
			.addButton((button) =>
				button
					.setButtonText(t("settings.advanced.resetButton"))
					.setWarning()
					.onClick(async () => {
						const confirmed = confirm(
							t("settings.advanced.confirm")
						);
						if (confirmed) {
							// Use the reset command logic directly
							const pData = (await this.plugin.loadData()) || {};
							await this.plugin.saveData({
								...pData,
								lastSyncTime: "1900-01-01 00:00:00",
							});
							new Notice(this.plugin.t("notice.resetDone"));
						}
					})
			);
	}

	private addHotkeySetting(
		containerEl: HTMLElement,
		label: string,
		description: string,
		commandKey: DinoCommandKey
	): void {
		const t = this.plugin.t.bind(this.plugin);
		const setting = new Setting(containerEl)
			.setName(label)
			.setDesc(description);

		const displayEl = setting.controlEl.createSpan({
			cls: "dinox-hotkey-display",
		});

		const updateDisplay = () => {
			const labelText = this.plugin.getHotkeyDisplay(commandKey);
			displayEl.textContent =
				labelText || t("settings.hotkeys.notSet");
		};

		const applySetting = async (
			hotkey: DinoHotkeySetting | null
		): Promise<void> => {
			const changed = await this.plugin.applyHotkeySetting(
				commandKey,
				hotkey
			);
			updateDisplay();
			if (changed) {
				const labelText = this.plugin.getHotkeyDisplay(commandKey);
				new Notice(
					labelText
						? this.plugin.t("notice.hotkeySet", {
								hotkey: labelText,
						  })
						: this.plugin.t("notice.hotkeyCleared")
				);
			}
		};

		updateDisplay();

		const actionsEl = setting.controlEl.createDiv(
			"dinox-hotkey-actions"
		);

		new ButtonComponent(actionsEl)
			.setButtonText(t("settings.hotkeys.setButton"))
			.onClick(() => {
				this.plugin.beginHotkeyCapture(
					commandKey,
					displayEl,
					async (hotkey) => {
						await applySetting(hotkey);
					},
					async () => {
						await applySetting(null);
					}
				);
			})
			.setTooltip(t("settings.hotkeys.setTooltip"));

		new ButtonComponent(actionsEl)
			.setButtonText(t("settings.hotkeys.clearButton"))
			.onClick(async () => {
				this.plugin.cancelHotkeyCapture(false);
				await applySetting(null);
			})
			.setTooltip(t("settings.hotkeys.clearTooltip"));

		setting.settingEl.classList.add("dinox-hotkey-setting");
	}
}
