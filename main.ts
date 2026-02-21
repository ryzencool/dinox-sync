import {
	Command,
	Editor,
	Hotkey,
	KeymapEventHandler,
	MarkdownView,
	Menu,
	MenuItem,
	Notice,
	Platform,
	Plugin,
	Scope,
	TFile,
	type Modifier,
} from "obsidian";
import {
	getCurrentLocale,
	translate,
	type LocaleCode,
	type TranslationKey,
	type TranslationVars,
} from "./i18n";
import { DEFAULT_LAST_SYNC_TIME, DEFAULT_SETTINGS } from "./src/constants";
import { DailyNotesBridge, DailyNotesUnavailableError } from "./src/daily-notes";
import {
	getNotePathByIdFromData,
	normalizePersistedData,
} from "./src/persisted-data";
import { fetchNotesFromApi } from "./src/api";
import {
	createNoteToDinox,
	sendSelectionToDinox,
	syncNoteToDinox,
} from "./src/push";
import {
	buildLocalNoteIdIndex,
	ensureBaseDir,
	processApiResponse,
} from "./src/sync";
import { ensureFolderExists } from "./src/vault";
import {
	cloneHotkeyMap,
	createEmptyHotkey,
	normalizeKeyValue,
	sanitizeHotkeySetting,
} from "./src/hotkeys";
import {
	formatDate,
	getErrorMessage,
	normalizeDinoxDateTime,
} from "./src/utils";
import type { DinoPluginAPI } from "./src/plugin-types";
import type {
	DinoCommandKey,
	DinoHotkeySetting,
	DinoPluginSettings,
} from "./src/types";
import { DinoSettingTab } from "./src/setting-tab";

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
	private activeHotkeyCapture: {
		commandKey: DinoCommandKey;
		listener: (event: KeyboardEvent) => void;
		displayEl: HTMLElement;
	} | null = null;
	private autoSyncIntervalId: number | null = null;
	private dailyNotesBridge: DailyNotesBridge | null = null;
	private hasWarnedDailyNotesUnavailable = false;
	private hasWarnedTypeFoldersTemplateMissing = false;

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
						const existingId =
							frontmatter?.noteId ??
							frontmatter?.source_app_id;
						if (!existingId) {
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
			(path) => ensureFolderExists(this.app, path)
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
			id: "sync-all",
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
			id: "reset-sync",
			name: this.t("command.resetSync"),
			callback: async () => {
				await this.setLastSyncTime(DEFAULT_LAST_SYNC_TIME);
				new Notice(this.t("notice.syncReset"));
			},
		});

		this.addCommand({
			id: "sync-to-local",
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
			id: "sync-current-note",
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
			id: "create-note",
			name: this.t("command.createNote"),
			hotkeys: this.getHotkeysForCommand("createNote"),
			checkCallback: (checking: boolean) => {
				const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
				if (!activeView || !activeView.file) {
					return false;
				}

				const fileCache = this.app.metadataCache.getFileCache(activeView.file);
				const frontmatter = fileCache?.frontmatter;
				const noteId = frontmatter?.noteId ?? frontmatter?.source_app_id;

				// Only show if no noteId or source_app_id exists.
				if (noteId) {
					return false;
				}

				if (!checking) {
					this.createNoteToDinox(activeView.editor, activeView.file);
				}
				return true;
			},
		});

		this.addCommand({
			id: "open-daily-note",
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
			this.app.workspace.on("editor-menu", (menu: Menu, editor: Editor) => {
				const selection = editor?.getSelection();
				if (selection && selection.length > 0) {
					const trimText =
						selection.length > 15
							? `${selection.substring(0, 7)}...${selection.substring(selection.length - 5)}`
							: selection;

					menu.addItem((item: MenuItem) => {
						item.setTitle(
							this.t("menu.sendSelection", {
								selection: trimText,
							})
						)
							.setIcon("upload")
							.onClick(() => this.sendToDinox(selection));
					});
				}

				const file = this.app.workspace.getActiveFile();
				if (!file) {
					return;
				}

				const fileCache = this.app.metadataCache.getFileCache(file);
				const frontmatter = fileCache?.frontmatter;
				const noteId = frontmatter?.noteId ?? frontmatter?.source_app_id;
				if (!noteId) {
					menu.addItem((item: MenuItem) => {
						item.setTitle(this.t("menu.create"))
							.setIcon("plus")
							.onClick(() => this.createNoteToDinox(editor, file));
					});
				}

				menu.addItem((item: MenuItem) => {
					item.setTitle(this.t("menu.syncCurrent"))
						.setIcon("sync")
						.onClick(() => this.syncToDinox(editor, file));
				});
			})
		);
	}

	onunload() {
		this.cancelHotkeyCapture(false);
		this.stopAutoSync();
		this.teardownHotkeyScope();
	}

	async loadSettings() {
		const persisted = normalizePersistedData(
			await this.loadData(),
			DEFAULT_SETTINGS
		);
		this.settings = persisted.settings;
	}

	async saveSettings() {
		// Keep sync state intact while persisting user-facing settings.
		const persisted = normalizePersistedData(
			await this.loadData(),
			DEFAULT_SETTINGS
		);
		this.settings.commandHotkeys = cloneHotkeyMap(
			this.settings.commandHotkeys
		);
		persisted.settings = this.settings;
		await this.saveData(persisted);
	}

	async setLastSyncTime(lastSyncTime: string): Promise<void> {
		const persisted = normalizePersistedData(
			await this.loadData(),
			DEFAULT_SETTINGS
		);
		// Preserve current in-memory settings; do not overwrite them with stale disk data.
		persisted.settings = this.settings;
		persisted.state.lastSyncTime = lastSyncTime;
		await this.saveData(persisted);
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

		if (
			this.settings.typeFolders.enabled &&
			!/\{\{\s*type\s*\}\}/.test(this.settings.template)
		) {
			if (!this.hasWarnedTypeFoldersTemplateMissing) {
				this.hasWarnedTypeFoldersTemplateMissing = true;
				console.warn(
					"Dinox: Type-based folders is enabled, but template does not include {{type}}. Crawl notes may be stored under note."
				);
				new Notice(this.t("notice.typeFoldersTemplateMissing"));
			}
		}

		this.setStatusBarSyncingState(true);
		this.statusBarItemEl.addClass("is-syncing");
		const notice = new Notice(this.t("notice.syncStarting"), 0);

		const syncStartTime = new Date(); // Use this for the *next* lastSyncTime
		let processedCount = 0;
		let deletedCount = 0;
		let errorOccurred = false;
		const persisted = normalizePersistedData(
			await this.loadData(),
			DEFAULT_SETTINGS
		);

		try {
			// 1. Get last sync time from saved data (original logic)
			let lastSyncTime = DEFAULT_LAST_SYNC_TIME;
			const normalizedLastSyncTime = normalizeDinoxDateTime(
				persisted.state.lastSyncTime
			);
			if (normalizedLastSyncTime) {
				lastSyncTime = normalizedLastSyncTime;
			} else if (persisted.state.lastSyncTime) {
				console.warn(
					"Dinox: Invalid stored lastSyncTime, using default.",
					persisted.state.lastSyncTime
				);
			}

			// 2. Fetch data from API (using original request structure)
			const dayNotes = await fetchNotesFromApi({
				token: this.settings.token,
				template: this.settings.template,
				lastSyncTime,
			});

			// 3. Resolve base dir and build stable noteId -> path mapping.
			const baseDir = await ensureBaseDir(this.app, this.settings.dir);

			const localIndex = await buildLocalNoteIdIndex(this.app, baseDir);
			const notePathById = getNotePathByIdFromData(persisted);
			for (const [noteId, path] of Object.entries(localIndex)) {
				if (!notePathById[noteId]) {
					notePathById[noteId] = path;
				}
			}

			// 4. Process API response (using delete + create)
			const processingResults = await processApiResponse({
				app: this.app,
				settings: this.settings,
				t: this.t.bind(this),
				dayNotes,
				baseDir,
				notePathById,
				localIndex,
				dailyNotesBridge: this.dailyNotesBridge,
				onDailyNotesUnavailable: () => {
					if (!this.hasWarnedDailyNotesUnavailable) {
						new Notice(this.t("notice.dailyNotesPluginDisabled"));
						this.hasWarnedDailyNotesUnavailable = true;
					}
				},
			});
			processedCount = processingResults.processed;
			deletedCount = processingResults.deleted;

			// 5. Update last sync time *only on success* (original logic)
			const newLastSyncTime = formatDate(syncStartTime);
			persisted.settings = this.settings;
			persisted.state.lastSyncTime = newLastSyncTime;
			persisted.state.notePathById = notePathById;
			await this.saveData(persisted);

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

	async sendToDinox(content: string): Promise<void> {
		await sendSelectionToDinox({
			token: this.settings.token,
			t: this.t.bind(this),
			content,
		});
	}

	async createNoteToDinox(editor: Editor, file: TFile): Promise<void> {
		await createNoteToDinox({
			app: this.app,
			token: this.settings.token,
			t: this.t.bind(this),
			editor,
			file,
		});
	}

	async syncToDinox(editor: Editor, file: TFile): Promise<void> {
		await syncNoteToDinox({
			app: this.app,
			token: this.settings.token,
			t: this.t.bind(this),
			editor,
			file,
		});
	}

}
