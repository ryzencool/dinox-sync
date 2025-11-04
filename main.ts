import {
	App,
	Notice,
	Plugin,
	requestUrl,
	Editor,
	MarkdownView,
	Menu,
	MenuItem,
	normalizePath,
	TFile,
	TFolder,
	Hotkey,
	Command,
	Platform,
	Scope,
	KeymapEventHandler,
} from "obsidian";
import type { Modifier } from "obsidian";
import {
	getCurrentLocale,
	translate,
	type LocaleCode,
	type TranslationKey,
	type TranslationVars,
} from "./i18n";
import {
	DEFAULT_SETTINGS,
	DEFAULT_DAILY_NOTES_SETTINGS,
	API_BASE_URL,
	API_BASE_URL_AI,
} from "./src/constants";
import {
	DailyNotesBridge,
	DailyNotesUnavailableError,
	type DailyNoteChangeSet,
} from "./src/daily-notes";
import {
	sanitizeHotkeySetting,
	cloneHotkeyMap,
	normalizeKeyValue,
	createEmptyHotkey,
} from "./src/hotkeys";
import {
	getErrorMessage,
	formatDate,
	sanitizeFilename,
} from "./src/utils";
import type { DinoPluginAPI } from "./src/plugin-types";
import type {
	Note,
	DayNote,
	GetNoteApiResult,
	DinoPluginSettings,
	DinoHotkeyMap,
	DinoHotkeySetting,
	DinoCommandKey,
} from "./src/types";
import { DinoSettingTab } from "./src/setting-tab";

type NoteProcessingResult =
	| {
			status: "processed";
			notePath: string;
			title: string;
			preview?: string;
	  }
	| {
			status: "deleted";
			notePath: string;
	  }
	| {
			status: "skipped";
	  };

// --- Plugin Class ---
export default class DinoPlugin extends Plugin implements DinoPluginAPI {
	settings: DinoPluginSettings;
	statusBarItemEl: HTMLElement;
	isSyncing = false; // Prevent concurrent syncs
	readonly defaults: Readonly<DinoPluginSettings> = DEFAULT_SETTINGS;
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
	private dailyNotesBridge: DailyNotesBridge | null = null;
	private hasWarnedDailyNotesUnavailable = false;

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
		this.dailyNotesBridge = new DailyNotesBridge(
			this.app,
			(path) => this.ensureFolderExists(path)
		);

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

		this.addCommand({
			id: "dinox-open-daily-notes",
			name: this.t("command.openDailyNote"),
			callback: async () => {
				if (!this.settings.dailyNotes.enabled) {
					new Notice(this.t("notice.dailyNotesDisabled"));
					return;
				}
				if (!this.dailyNotesBridge) {
					new Notice(this.t("notice.dailyNotesPluginDisabled"));
					return;
				}
				try {
					const file = await this.dailyNotesBridge.openDailyNote(
						new Date(),
						this.settings.dailyNotes
					);
					if (!file) {
						new Notice(this.t("notice.dailyNotesMissingFile"));
						return;
					}
					await this.app.workspace.openLinkText(file.path, "", true);
				} catch (error) {
					if (error instanceof DailyNotesUnavailableError) {
						if (!this.hasWarnedDailyNotesUnavailable) {
							new Notice(this.t("notice.dailyNotesPluginDisabled"));
							this.hasWarnedDailyNotesUnavailable = true;
						}
					} else {
						console.error("Dinox: Failed to open daily note:", error);
						new Notice(this.t("notice.dailyNoteOpenFailed"));
					}
				}
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
			dailyNotes: {
				...DEFAULT_DAILY_NOTES_SETTINGS,
				...stored?.dailyNotes,
			},
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
		const shouldSyncDailyNotes =
			this.settings.dailyNotes.enabled && !!this.dailyNotesBridge;
		const dailyNoteChanges = new Map<string, DailyNoteChangeSet>();
		const ensureChangeSet = (date: string): DailyNoteChangeSet => {
			let changeSet = dailyNoteChanges.get(date);
			if (!changeSet) {
				changeSet = { added: [], removed: [] };
				dailyNoteChanges.set(date, changeSet);
			}
			return changeSet;
		};

		for (const dayData of dayNotes.reverse()) {
			let datePath = baseDir; // Default for flat layout
			if (this.settings.fileLayout === "nested") {
				const safeDate = dayData.date.replace(/[^0-9-]/g, "");
				datePath = normalizePath(`${baseDir}/${safeDate}`);
				await this.ensureFolderExists(datePath);
			}

			for (const noteData of dayData.notes.reverse()) {
				try {
					const result = await this.handleNoteProcessing(
						noteData,
						datePath
					);
					if (result.status === "deleted") {
						deleted++;
						if (shouldSyncDailyNotes && result.notePath) {
							const changeSet = ensureChangeSet(dayData.date);
							changeSet.removed.push({
								notePath: result.notePath,
								title: noteData.title,
							});
						}
					} else if (result.status === "processed") {
						processed++;
						if (shouldSyncDailyNotes) {
							const changeSet = ensureChangeSet(dayData.date);
							changeSet.added.push({
								notePath: result.notePath,
								title: result.title,
								preview: result.preview,
							});
						}
					}
				} catch (noteError) {
					console.error(
						`Dinox: Failed to process note ${noteData.noteId}:`,
						noteError
					);
					const shortId = noteData.noteId.substring(0, 8);
					new Notice(
						this.t("notice.processNoteFailed", { noteId: shortId }),
						5000
					);
				}
			}
		}

		if (shouldSyncDailyNotes && dailyNoteChanges.size > 0) {
			let updatedDailyNotes = 0;
			for (const [date, changeSet] of dailyNoteChanges) {
				try {
					const changed =
						await this.dailyNotesBridge!.applyChangesForDate(
							date,
							changeSet,
							this.settings.dailyNotes
						);
					if (changed) {
						updatedDailyNotes++;
					}
				} catch (error) {
					if (error instanceof DailyNotesUnavailableError) {
						if (!this.hasWarnedDailyNotesUnavailable) {
							new Notice(
								this.t("notice.dailyNotesPluginDisabled")
							);
							this.hasWarnedDailyNotesUnavailable = true;
						}
					} else {
						console.error(
							`Dinox: Failed to update daily note for ${date}:`,
							error
						);
						new Notice(
							this.t("notice.dailyNotesUpdateFailed"),
							5000
						);
					}
				}
			}
			if (updatedDailyNotes > 0) {
				new Notice(
					this.t("notice.dailyNotesUpdated", {
						count: updatedDailyNotes,
					})
				);
			}
		}

		return { processed, deleted };
	}


	// Combined handling function mirroring original logic
	async handleNoteProcessing(
		noteData: Note,
		datePath: string
	): Promise<NoteProcessingResult> {
		const sourceId = noteData.noteId;
		const ignoreKey = this.settings.ignoreSyncKey; // Get the configured key name
		const preserveKeysSetting = this.settings.preserveKeys || "";
		const keysToPreserve = preserveKeysSetting
			.split(",")
			.map((k) => k.trim())
			.filter((k) => k !== "");
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
		baseFilename =
			baseFilename || sourceId.replace(/-/g, "_") || "Untitled";
		const filename = `${baseFilename}.md`; // Append suffix
		const notePath = normalizePath(`${datePath}/${filename}`);
		const existingFile = this.app.vault.getAbstractFileByPath(notePath);
		let propertiesToPreserve: Record<string, any> = {}; // Store properties here
		if (existingFile && existingFile instanceof TFile) {
			try {
				const cache = this.app.metadataCache.getFileCache(existingFile);
				const existingFrontmatter = cache?.frontmatter;
				if (existingFrontmatter) {
					if (ignoreKey && existingFrontmatter[ignoreKey] === true) {
						return { status: "skipped" };
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
					return { status: "deleted", notePath };
				} catch (deleteError) {
					console.error(
						`Dinox: Failed to delete file ${notePath}:`,
						deleteError
					);
					throw deleteError; // Propagate error
				}
			}
			return { status: "skipped" };
		}
		if (existingFile && existingFile instanceof TFile && ignoreKey) {
			const cache = this.app.metadataCache.getFileCache(existingFile);
			const frontmatter = cache?.frontmatter;
			if (frontmatter && frontmatter[ignoreKey] === true) {
				return { status: "skipped" }; // Skip update/delete+create for this file
			}
		}
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

			return {
				status: "processed",
				notePath,
				title: this.getDailyNoteEntryTitle(noteData, baseFilename),
				preview: this.buildDailyNotePreview(finalContent),
			};
		} catch (error) {
			console.error(
				`Dinox: Failed to ${existingFile ? "update" : "create"} file ${notePath}:`,
				error
			);
			throw error; // Propagate error
		}
	}

	private getDailyNoteEntryTitle(
		noteData: Note,
		baseFilename: string
	): string {
		const rawTitle = noteData.title?.trim();
		if (rawTitle) {
			return rawTitle;
		}
		return baseFilename.replace(/_/g, " ");
	}

	private buildDailyNotePreview(content: string): string | undefined {
		const raw = content ?? "";
		if (!raw) {
			return undefined;
		}
		const lines = raw.split(/\r?\n/);
		let index = 0;
		if (lines[index]?.trim() === "---") {
			index++;
			while (index < lines.length && lines[index].trim() !== "---") {
				index++;
			}
			if (index < lines.length) {
				index++;
			}
		}
		for (; index < lines.length; index++) {
			const line = lines[index].trim();
			if (!line) {
				continue;
			}
			if (line.startsWith(">")) {
				continue;
			}
			const cleaned = line.replace(/^#+\s*/, "").replace(/[`*_]/g, "");
			if (!cleaned) {
				continue;
			}
			return cleaned.length > 120
				? `${cleaned.slice(0, 117)}...`
				: cleaned;
		}
		return undefined;
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
