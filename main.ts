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
import {
	DEFAULT_LAST_SYNC_TIME,
	DEFAULT_SETTINGS,
	SYNC_PAGE_SIZE,
} from "./src/constants";
import { DailyNotesBridge, DailyNotesUnavailableError } from "./src/daily-notes";
import {
	getNotePathByIdFromData,
	normalizePersistedData,
} from "./src/persisted-data";
import { fetchNotesPage } from "./src/api";
import { validateTemplate } from "./src/template";
import {
	createNoteToDinox,
	sendSelectionToDinox,
	syncNoteToDinox,
} from "./src/push";
import {
	buildLocalNoteIdIndex,
	createSyncSession,
	ensureBaseDir,
	flushDailyNoteChanges,
	processNotesPage,
} from "./src/sync";
import { ensureFolderExists } from "./src/vault";
import {
	cloneHotkeyMap,
	createEmptyHotkey,
	normalizeKeyValue,
	sanitizeHotkeySetting,
} from "./src/hotkeys";
import {
	getErrorMessage,
	getNoteIdFromFrontmatter,
	parseDate,
} from "./src/utils";
import type { DinoPluginAPI } from "./src/plugin-types";
import type {
	DinoCommandKey,
	DinoHotkeySetting,
	DinoPluginSettings,
	NotesSyncPage,
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

	private boundT = (key: TranslationKey, vars?: TranslationVars): string =>
		this.t(key, vars);

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
					void this.syncToDinox(view.editor, view.file);
				}
				break;
			}
				case "createNote": {
					const view =
						this.app.workspace.getActiveViewOfType(MarkdownView);
					if (view?.file) {
						const fileCache =
							this.app.metadataCache.getFileCache(view.file);
						const existingId = getNoteIdFromFrontmatter(
							fileCache?.frontmatter
						);
						if (!existingId) {
							void this.createNoteToDinox(view.editor, view.file);
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

		const intervalId = window.setInterval(() => {
			if (!this.isSyncing) {
				void this.syncNotes();
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

	onload(): void {
		void this.initializePlugin();
	}

	private async initializePlugin(): Promise<void> {
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
			checkCallback: (checking: boolean) => {
				const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
				if (activeView && activeView.file) {
					if (!checking) {
						void this.syncToDinox(activeView.editor, activeView.file);
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
			checkCallback: (checking: boolean) => {
				const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
				if (!activeView || !activeView.file) {
					return false;
				}

				const fileCache = this.app.metadataCache.getFileCache(activeView.file);
				const noteId = getNoteIdFromFrontmatter(fileCache?.frontmatter);

				// Only show if no noteId or source_app_id exists.
				if (noteId) {
					return false;
				}

				if (!checking) {
					void this.createNoteToDinox(activeView.editor, activeView.file);
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
							.onClick(() => {
								void this.sendToDinox(selection);
							});
					});
				}

				const file = this.app.workspace.getActiveFile();
				if (!file) {
					return;
				}

				const fileCache = this.app.metadataCache.getFileCache(file);
				const noteId = getNoteIdFromFrontmatter(fileCache?.frontmatter);
				if (!noteId) {
					menu.addItem((item: MenuItem) => {
						item.setTitle(this.t("menu.create"))
							.setIcon("plus")
							.onClick(() => {
								void this.createNoteToDinox(editor, file);
							});
					});
				}

				menu.addItem((item: MenuItem) => {
					item.setTitle(this.t("menu.syncCurrent"))
						.setIcon("sync")
						.onClick(() => {
							void this.syncToDinox(editor, file);
						});
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

	// --- Core Sync Logic ---

	// Convert the stored sync cursor into an unambiguous ISO timestamp the
	// server can compare with `::timestamptz`. Returns null for a first/full
	// sync so older stored formats can never cause a timezone-shifted query.
	private resolveSince(stored: string | undefined): string | null {
		if (!stored || stored === DEFAULT_LAST_SYNC_TIME) {
			return null;
		}
		const parsed = parseDate(stored);
		if (!parsed) {
			return null;
		}
		return parsed.toISOString();
	}

	async syncNotes() {
		if (this.isSyncing) {
			new Notice(this.t("notice.syncInProgress"));
			return;
		}
		if (!this.settings.token) {
			new Notice(this.t("notice.tokenMissing"));
			return;
		}

		const templateError = validateTemplate(this.settings.template);
		if (templateError) {
			// Abort rather than render: a broken template would silently
			// strip frontmatter from every note this sync touches.
			new Notice(
				this.t("notice.templateInvalidAbort", { error: templateError })
			);
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

		let errorOccurred = false;
		const persisted = normalizePersistedData(
			await this.loadData(),
			DEFAULT_SETTINGS
		);

		try {
			// 1. Resolve the incremental cursor. `since` is an unambiguous ISO
			//    timestamp; null means a first/full sync (also skips deletions,
			//    since there is nothing local to remove yet).
			const since = this.resolveSince(persisted.state.lastSyncTime);
			const includeDeleted = since !== null;
			// null => sync everything; array => only the selected boxes + sub-boxes.
			const boxIds = this.settings.syncScope.enabled
				? this.settings.syncScope.selectedBoxIds
				: null;

			// 2. Resolve base dir and build stable noteId -> path mapping.
			const baseDir = await ensureBaseDir(this.app, this.settings.dir);
			const localIndex = await buildLocalNoteIdIndex(this.app, baseDir);
			const notePathById = getNotePathByIdFromData(persisted);
			for (const [noteId, path] of Object.entries(localIndex)) {
				if (!notePathById[noteId]) {
					notePathById[noteId] = path;
				}
			}

			// 3. Stream pages: fetch -> process -> release, so memory stays
			//    bounded regardless of how many notes changed.
			const session = createSyncSession();
			let cursor: string | null = null;
			let highWaterMark: string | null = null;
			const seenCursors = new Set<string>();

			do {
				const page: NotesSyncPage = await fetchNotesPage({
					token: this.settings.token,
					since,
					cursor,
					limit: SYNC_PAGE_SIZE,
					includeDeleted,
					boxIds,
				});

				// Notes are ordered newest-first, so the very first note of the
				// first page carries the high-water mark for the next sync.
				if (highWaterMark === null && page.notes.length > 0) {
					highWaterMark = page.notes[0].updateTime ?? null;
				}

				await processNotesPage({
					app: this.app,
					settings: this.settings,
					t: this.boundT,
					notes: page.notes,
					baseDir,
					notePathById,
					localIndex,
					session,
				});

				const nextCursor = page.nextCursor;
				if (page.hasMore && !nextCursor) {
					throw new Error(
						"Dinox: Sync response indicated more pages but did not include nextCursor."
					);
				}
				if (nextCursor) {
					if (seenCursors.has(nextCursor)) {
						throw new Error(
							"Dinox: Sync pagination returned a repeated cursor."
						);
					}
					seenCursors.add(nextCursor);
				}
				if (!page.hasMore && nextCursor) {
					console.warn(
						"Dinox: Sync response included nextCursor while hasMore was false; stopping at this page."
					);
				}
				cursor = page.hasMore ? nextCursor : null;
				if (cursor) {
					notice.setMessage(
						`${this.t("notice.syncStarting")} (${session.processed})`
					);
					// Breathe between pages so the UI stays responsive.
					await new Promise((resolve) =>
						window.setTimeout(resolve, 0)
					);
				}
			} while (cursor);

			// 4. Apply accumulated daily-note edits once.
			await flushDailyNoteChanges({
				session,
				settings: this.settings,
				t: this.boundT,
				dailyNotesBridge: this.dailyNotesBridge,
				onDailyNotesUnavailable: () => {
					if (!this.hasWarnedDailyNotesUnavailable) {
						new Notice(this.t("notice.dailyNotesPluginDisabled"));
						this.hasWarnedDailyNotesUnavailable = true;
					}
				},
			});

			// 5. Persist *only on success*. Advance the cursor only if we saw
			//    notes; otherwise keep the previous high-water mark.
			persisted.settings = this.settings;
			if (highWaterMark) {
				persisted.state.lastSyncTime = highWaterMark;
			}
			persisted.state.notePathById = notePathById;
			await this.saveData(persisted);

			notice.setMessage(
				this.t("notice.syncComplete", {
					processed: session.processed,
					deleted: session.deleted,
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
			window.setTimeout(() => notice.hide(), errorOccurred ? 10000 : 5000);
		}
	}

	async sendToDinox(content: string): Promise<void> {
		await sendSelectionToDinox({
			token: this.settings.token,
			t: this.boundT,
			content,
		});
	}

	async createNoteToDinox(editor: Editor, file: TFile): Promise<void> {
		await createNoteToDinox({
			app: this.app,
			token: this.settings.token,
			t: this.boundT,
			editor,
			file,
		});
	}

	async syncToDinox(editor: Editor, file: TFile): Promise<void> {
		await syncNoteToDinox({
			app: this.app,
			token: this.settings.token,
			t: this.boundT,
			editor,
			file,
		});
	}

}
