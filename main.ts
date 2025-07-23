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
	TFile, // Added
	TFolder, // Added
} from "obsidian";
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

	// Removed lastSyncTime and noteMapping - will load/save dynamically like original
}

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

const DEFAULT_SETTINGS: DinoPluginSettings = {
	token: "",
	isAutoSync: false,
	dir: "Dinox Sync",
	template: DEFAULT_TEMPLATE_TEXT,
	filenameFormat: "noteId",
	fileLayout: "nested",
	ignoreSyncKey: "ignore_sync",
	preserveKeys: "",
};

const API_BASE_URL = "https://dinoai.chatgo.pro";
const API_BASE_URL_AI = "https://aisdk.chatgo.pro";

// --- Helper Functions ---

function objectToYamlString(obj: Record<string, any>): string {
	let yaml = "";
	for (const key in obj) {
		if (Object.prototype.hasOwnProperty.call(obj, key)) {
			const value = obj[key];
			// Basic handling for different types - extend if needed
			if (typeof value === "string") {
				// Quote strings if they contain special chars or look like numbers/booleans
				if (
					/[#:!@%&*{}[\]]/.test(value) ||
					/^\d+(\.\d+)?$/.test(value) ||
					/^(true|false|null)$/i.test(value) ||
					value.includes("\n")
				) {
					yaml += `${key}: "${value.replace(/"/g, '\\"')}"\n`; // Simple quoting
				} else {
					yaml += `${key}: ${value}\n`;
				}
			} else if (
				typeof value === "number" ||
				typeof value === "boolean"
			) {
				yaml += `${key}: ${value}\n`;
			} else if (value === null || value === undefined) {
				yaml += `${key}:\n`; // Or use 'null' based on YAML spec preference
			} else if (Array.isArray(value)) {
				yaml += `${key}:\n`;
				value.forEach((item) => {
					// Basic array item handling
					if (typeof item === "string") {
						yaml += `  - "${item.replace(/"/g, '\\"')}"\n`;
					} else {
						yaml += `  - ${item}\n`;
					}
				});
			} else if (typeof value === "object") {
				// Basic object handling (no nested objects in this simple version)
				yaml += `${key}: ${JSON.stringify(value)}\n`; // Fallback to JSON string
			}
		}
	}
	return yaml;
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
	isSyncing: boolean = false; // Prevent concurrent syncs

	async onload() {
		console.log("Loading Dinox Sync plugin");
		await this.loadSettings(); // Loads settings like token, dir etc.

		// Status Bar
		this.statusBarItemEl = this.addStatusBarItem();
		this.statusBarItemEl.setText("Dinox");
		this.statusBarItemEl.onClickEvent(() => {
			if (!this.isSyncing) {
				this.syncNotes().catch((err) =>
					console.error("Dinox: Manual sync failed:", err)
				);
			} else {
				new Notice("Dinox: Sync already in progress.");
			}
		});

		// Settings Tab
		this.addSettingTab(new DinoSettingTab(this.app, this));

		// Commands
		this.addCommand({
			id: "dinox-sync-command",
			name: "Synchronize Dinox notes now",
			callback: async () => {
				if (!this.isSyncing) {
					await this.syncNotes();
				} else {
					new Notice("Dinox: Sync already in progress.");
				}
			},
		});

		this.addCommand({
			id: "dinox-reset-sync-command",
			name: "Reset Dinox Sync (fetch all next time)",
			callback: async () => {
				// Reset only lastSyncTime as per original logic
				const pData = (await this.loadData()) || {};
				await this.saveData({
					...pData, // Preserve other potential saved data (like settings)
					lastSyncTime: "1900-01-01 00:00:00", // Use the original reset value
				});
				new Notice(
					"Dinox: Sync reset. Next sync will fetch all notes."
				);
			},
		});

		this.addCommand({
			id: "dinox-sync-note-to-local-command",
			name: "Sync dinox note to local",
			hotkeys: [
				{
					modifiers: ["Mod", "Shift"],
					key: "t",
				},
			],
			callback: async () => {
				if (!this.isSyncing) {
					try {
						await this.syncNotes();
					} catch (error) {
						console.error("Dinox: Sync failed:", error);
						new Notice(`Dinox: Sync failed - ${error.message}`);
					}
				} else {
					new Notice("Dinox: Sync already in progress.");
				}
			},
		});

		// Add command for syncToDinox with keyboard shortcut
		this.addCommand({
			id: "dinox-sync-current-note-command",
			name: "Sync current note to Dinox",
			hotkeys: [
				{
					modifiers: ["Mod", "Shift"],
					key: "k",
				},
			],
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
		this.addCommand({
			id: "dinox-create-note-command",
			name: "Create current note into Dinox",
			hotkeys: [
				{
					modifiers: ["Mod", "Shift"],
					key: "c",
				},
			],
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
							item.setTitle(`Select"${trimText}" and send to Dinox`)
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
								item.setTitle("Create into Dinox")
									.setIcon("plus") // Optional icon
									.onClick(() => this.createNoteToDinox(editor, file));
							});
						}
					}
					// Sync Current Note
					if (editor && file) {
						// ... (syncToDinox menu item code from previous version) ...
						menu.addItem((item: MenuItem) => {
							item.setTitle("Sync this note to Dinox")
								.setIcon("sync") // Optional icon
								.onClick(() => this.syncToDinox(editor, file)); // Pass file
						});
					}
				}
			)
		);

		// Auto Sync Interval
		if (this.settings.isAutoSync) {
			this.registerInterval(
				window.setInterval(async () => {
					console.log("Dinox: Triggering auto sync...");
					if (!this.isSyncing) {
						await this.syncNotes();
					} else {
						console.log(
							"Dinox: Auto sync skipped, sync already in progress."
						);
					}
				}, 30 * 60 * 1000)
			);
		}
	}

	onunload() {
		console.log("Unloading Dinox Sync plugin");
	}

	async loadSettings() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS, // Includes the new default ignoreSyncKey
			await this.loadData()
		);
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
		await this.saveData({ ...pData, ...this.settings }); // Merge settings with existing data
	}

	// --- Core Sync Logic (Adhering to Original Flow) ---

	async syncNotes() {
		if (this.isSyncing) {
			new Notice("Dinox: Sync already in progress.");
			return;
		}
		if (!this.settings.token) {
			new Notice("Dinox: Token not set. Please configure the plugin.");
			return;
		}

		this.isSyncing = true;
		this.statusBarItemEl.setText("Dinox: Syncing...");
		this.statusBarItemEl.addClass("is-syncing");
		const notice = new Notice("Dinox: Starting sync...", 0);

		const syncStartTime = new Date(); // Use this for the *next* lastSyncTime
		let processedCount = 0;
		let deletedCount = 0;
		let errorOccurred = false;
		const pData = (await this.loadData()) || {}; // Load existing data, including lastSyncTime

		try {
			console.log("Dinox: Sync started.");

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
			console.log("Dinox: Last sync time for API:", lastSyncTime);

			// 2. Fetch data from API (using original request structure)
			const dayNotes = await this.fetchNotesFromApi(lastSyncTime);

			// 3. Ensure base sync directory exists
			await this.ensureFolderExists(this.settings.dir);

			// 4. Process API response (using delete + create)
			const processingResults = await this.processApiResponse(dayNotes);
			processedCount = processingResults.processed;
			deletedCount = processingResults.deleted;

			// 5. Update last sync time *only on success* (original logic)
			const newLastSyncTime = formatDate(syncStartTime);
			console.log("Dinox: Saving new lastSyncTime:", newLastSyncTime);
			await this.saveData({
				...pData, // Preserve existing saved data
				...this.settings, // Save current settings too
				lastSyncTime: newLastSyncTime, // Update the timestamp
			});

			console.log("Dinox: Sync finished successfully.");
			notice.setMessage(
				`Dinox: Sync complete!\nProcessed: ${processedCount}, Deleted: ${deletedCount}`
			);
		} catch (error) {
			errorOccurred = true;
			console.error("Dinox: Sync failed:", error);
			notice.setMessage(`Dinox: Sync failed!\n${error.message}`);
			// Do NOT update lastSyncTime on error
		} finally {
			this.isSyncing = false;
			this.statusBarItemEl.setText("Dinox");
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

		console.log("Dinox: Calling API with body:", requestBody);

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

			console.log(
				`Dinox: Received ${result.data?.length || 0} days of notes.`
			);
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

		for (const dayData of dayNotes.reverse()) {
			let datePath = this.settings.dir; // Default for flat layout
			if (this.settings.fileLayout === "nested") {
				// Ensure date format is path-safe (YYYY-MM-DD is usually safe)
				const safeDate = dayData.date.replace(/[^0-9-]/g, ""); // Basic sanitization
				datePath = `${this.settings.dir}/${safeDate}`;
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
					new Notice(
						`Failed to process Dinox note ${noteData.noteId.substring(
							0,
							8
						)}...`,
						5000
					);
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
		const notePath = `${datePath}/${filename}`;

		// --- Handle Deletion or Upsert (Delete + Create) ---
		const existingFile = this.app.vault.getAbstractFileByPath(notePath);
		let propertiesToPreserve: Record<string, any> = {}; // Store properties here

		console.log("111111111111111111", keysToPreserve)



		if (
			existingFile &&
			existingFile instanceof TFile 
		) {
			try {
				const cache = this.app.metadataCache.getFileCache(existingFile);
				const existingFrontmatter = cache?.frontmatter;
				console.log("当前存在的 frontmatter", existingFrontmatter)
				if (existingFrontmatter) {

					console.log("ignoreKey", ignoreKey, existingFrontmatter[ignoreKey])
                    if (ignoreKey && existingFrontmatter[ignoreKey] == true) {
						console.log("ignoreKey", ignoreKey, existingFrontmatter[ignoreKey])
						return "skipped"
                    }

					if (keysToPreserve.length > 0) {
					console.log("222222", keysToPreserve, existingFrontmatter)
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
					if (Object.keys(propertiesToPreserve).length > 0) {
						console.log(
							`Dinox: Preserving properties for ${notePath}:`,
							Object.keys(propertiesToPreserve)
						);
					}
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
				console.log(
					`Dinox: Deleting note marked for deletion: ${notePath}`
				);
				try {
					await this.app.vault.delete(existingFile, true); // Force delete like original
					return "deleted";
				} catch (deleteError) {
					console.error(
						`Dinox: Failed to delete file ${notePath}:`,
						deleteError
					);
					throw deleteError; // Propagate error
				}
			} else {
				// Note marked deleted, but not found locally. Log and skip.
				// console.log(`Dinox: Note ${sourceId} marked deleted, but file not found at ${notePath}. Skipping.`);
				return "skipped";
			}
		} else {
			// *** Check for Ignore Flag ***

			if (existingFile && existingFile instanceof TFile && ignoreKey) {
				const cache = this.app.metadataCache.getFileCache(existingFile);
				const frontmatter = cache?.frontmatter;
				if (frontmatter && frontmatter[ignoreKey] === true) {
					console.info(
						`Dinox: Skipping update for note ${notePath} due to '${ignoreKey}: true' property.`
					);
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

			let finalContent = noteData.content || "";
            const preservedYamlString = Object.keys(propertiesToPreserve).length > 0
                ? objectToYamlString(propertiesToPreserve)
                : "";


				console.log("4444", preservedYamlString)
            if (preservedYamlString) {
                // Strategy: Inject preserved properties into the content received from API.
                // Assumes API content might or might not have frontmatter.
                if (finalContent.startsWith('---')) {
                     // Find the end of the first line (after '---')
                     const firstNewline = finalContent.indexOf('\n');
                     if (firstNewline !== -1) {
                         // Inject preserved YAML after the first line
                         finalContent = finalContent.substring(0, firstNewline + 1)
                                       + preservedYamlString
                                       + finalContent.substring(firstNewline + 1);
                         console.log(`Dinox: Injected preserved properties into existing frontmatter for ${notePath}`);
                     } else {
                         // Malformed frontmatter? Just prepend.
                         console.warn(`Dinox: Existing frontmatter in API content for ${notePath} seems malformed. Prepending preserved properties.`);
                         finalContent = "---\n" + preservedYamlString + "---\n" + finalContent;
                     }
                } else {
                    // No frontmatter in API content, prepend the preserved properties block
                    finalContent = "---\n" + preservedYamlString + "---\n" + finalContent;
                     console.log(`Dinox: Prepended preserved properties to ${notePath}`);
                }
            }


			console.log("77777", finalContent)

			try {
				if (existingFile && existingFile instanceof TFile) {
					// Update existing file instead of deleting and recreating
					console.log(`Dinox: Updating existing note: ${notePath}`);
					await this.app.vault.modify(existingFile, finalContent);
				} else {
					// Create new file
					console.log(`Dinox: Creating new note: ${notePath}`);
					await this.app.vault.create(notePath, finalContent);
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
		// Keep robust folder checking
		try {
			const folder = this.app.vault.getAbstractFileByPath(folderPath);
			if (!folder) {
				console.log(`Dinox: Creating folder: ${folderPath}`);
				await this.app.vault.createFolder(folderPath);
			} else if (!(folder instanceof TFolder)) {
				throw new Error(
					`Sync path "${folderPath}" exists but is not a folder.`
				);
			}
		} catch (error) {
			console.error(
				`Dinox: Error ensuring folder "${folderPath}" exists:`,
				error
			);
			throw error;
		}
	}

	// --- Push to Dinox Functions (Kept from previous version, verify endpoints/payloads) ---
	async sendToDinox(content: string) {
		// ... (Implementation from the previous full refactored code) ...
		if (!this.settings.token) {
			new Notice("Dinox: Please set Dinox token first");
			return;
		}
		new Notice("Dinox: Sending selection...");
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
				new Notice("Dinox: Content sent successfully");
			} else {
				console.error("Dinox send failed:", resultJson);
				new Notice(
					`Dinox: Failed to send - ${
						resultJson.msg || "Unknown error"
					}`
				);
			}
		} catch (error) {
			console.error("Dinox: Error sending content:", error);
			new Notice(`Dinox: Error sending - ${error.message}`);
		}
	}

	async createNoteToDinox(editor: Editor, file: TFile) {
		if (!this.settings.token) {
			new Notice("Dinox: Please set Dinox token first");
			return;
		}
		
		new Notice("Dinox: Creating note in Dinox...");
		
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
					`Dinox: Note created successfully with ID: ${createdNoteId.substring(0, 8)}...`
				);
			} else {
				console.error("Dinox create failed:", resultJson);
				new Notice(
					`Dinox: Failed to create note - ${
						resultJson.msg || "Unknown error"
					}`
				);
			}
		} catch (error) {
			console.error("Dinox: Error creating note:", error);
			new Notice(`Dinox: Error creating note - ${error.message}`);
		}
	}
	
	extractAllTags(fileContent: string, frontmatter: any): string[] {
		const tags = new Set<string>();
		
		// 1. Get tags from frontmatter
		if (frontmatter?.tags) {
			if (Array.isArray(frontmatter.tags)) {
				frontmatter.tags.forEach((tag: string) => {
					if (tag && typeof tag === 'string') {
						tags.add(tag.trim());
					}
				});
			}
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
			const fileContent = await this.app.vault.cachedRead(file);
			const fileCache = this.app.metadataCache.getFileCache(file);
			
			let newContent: string;
			
			if (fileCache?.frontmatterPosition) {
				// File already has frontmatter, add noteId to it
				const beforeFrontmatter = fileContent.substring(0, fileCache.frontmatterPosition.start.offset);
				const frontmatterContent = fileContent.substring(
					fileCache.frontmatterPosition.start.offset + 3, // Skip first '---'
					fileCache.frontmatterPosition.end.offset - 3 // Skip last '---'
				).trim();
				const afterFrontmatter = fileContent.substring(fileCache.frontmatterPosition.end.offset);
				
				newContent = beforeFrontmatter + "---\n" + frontmatterContent + "\nnoteId: " + noteId + "\n---" + afterFrontmatter;
			} else {
				// File has no frontmatter, create new one with noteId
				newContent = "---\nnoteId: " + noteId + "\n---\n" + fileContent;
			}
			
			await this.app.vault.modify(file, newContent);
			console.log(`Dinox: Added noteId ${noteId} to ${file.path}`);
		} catch (error) {
			console.error("Dinox: Error adding noteId to frontmatter:", error);
			new Notice(`Dinox: Error updating frontmatter - ${error.message}`);
		}
	}

	async syncToDinox(editor: Editor, file: TFile) {
		// ... (Implementation from the previous full refactored code, check payload key 'contentMd' vs 'content') ...
		if (!this.settings.token) {
			new Notice("Dinox: Please set Dinox token first");
			return;
		}
		new Notice("Dinox: Syncing note to Dinox...");
		const fileContent = await this.app.vault.cachedRead(file);
		const fileCache = this.app.metadataCache.getFileCache(file);
		const frontmatter = fileCache?.frontmatter;
		const noteId = frontmatter?.noteId || frontmatter?.source_app_id;

		if (!noteId) {
			new Notice(
				"Dinox: Cannot sync. Note ID (noteId or source_app_id) not found in frontmatter."
			);
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
			console.log("requestBody", this.settings.token, requestBody)
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
					`Dinox: Note ${noteId.substring(
						0,
						8
					)}... synced successfully`
				);
			} else {
				console.error("Dinox sync update failed:", resultJson);
				new Notice(
					`Dinox: Failed to sync note - ${
						resultJson.msg || "Unknown error"
					}`
				);
			}
		} catch (error) {
			console.error("Dinox: Error syncing note:", error);
			new Notice(`Dinox: Error syncing note - ${error.message}`);
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
		containerEl.empty();
		containerEl.createEl("h2", { text: "Dinox Sync Settings" });

		// Token
		new Setting(containerEl)
			.setName("Dinox Token")
			.setDesc("API token generated from the Dinox application.")
			.addText((text) =>
				text
					.setPlaceholder("Enter Your Dinox Token")
					.setValue(this.plugin.settings.token)
					.onChange(async (value) => {
						this.plugin.settings.token = value.trim();
						await this.plugin.saveSettings(); // Saves only settings object now
					})
			);

		// Sync Directory
		new Setting(containerEl)
			.setName("Sync Directory")
			.setDesc("The base folder in your Obsidian vault for synced notes.")
			.addText((text) =>
				text
					.setPlaceholder("e.g., Dinox Notes")
					.setValue(this.plugin.settings.dir)
					.onChange(async (value) => {
						this.plugin.settings.dir =
							value.replace(/^\/|\/$/g, "").trim() ||
							"Dinox Sync";
						await this.plugin.saveSettings();
					})
			);

		// Filename Format
		new Setting(containerEl)
			.setName("Filename Format")
			.setDesc(
				"Choose how synced note files should be named (appends '_dinox.md')."
			)
			.addDropdown((dropdown) => {
				dropdown
					// Keep options, ID is generally safer if titles can change often
					.addOption("noteId", "Note ID (Recommended)")
					.addOption("title", "Note Title (Sanitized)")
					.addOption("time", "Creation Time (YYYY-MM-DD HHMMSS)")
					.setValue(this.plugin.settings.filenameFormat)
					.onChange(async (value: "noteId" | "title" | "time") => {
						this.plugin.settings.filenameFormat = value;
						await this.plugin.saveSettings();
					});
			});

		// File Layout
		new Setting(containerEl)
			.setName("File Layout")
			.setDesc("Organize synced notes.")
			.addDropdown((dropdown) => {
				dropdown
					.addOption(
						"nested",
						"Nested (Base Dir / YYYY-MM-DD / file.md)"
					)
					.addOption("flat", "Flat (Base Dir / file.md)")
					.setValue(this.plugin.settings.fileLayout)
					.onChange(async (value: "flat" | "nested") => {
						this.plugin.settings.fileLayout = value;
						await this.plugin.saveSettings();
					});
			});
		new Setting(containerEl)
			.setName("Ignore Sync Property Key")
			.setDesc(
				"Enter the note property (frontmatter key) used to prevent updates during sync. If this key exists in a note's frontmatter and its value is exactly 'true', the note will not be updated by the sync."
			)
			.addText((text) =>
				text
					.setPlaceholder("e.g., ignore_sync")
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
							new Notice(
								"Invalid ignore key. Reverted to default."
							);
							text.setValue(this.plugin.settings.ignoreSyncKey); // Update UI
						} else {
							new Notice(
								"Invalid ignore key: Cannot contain spaces."
							);
							// Keep the old value or revert to default? Let's revert.
							this.plugin.settings.ignoreSyncKey =
								DEFAULT_SETTINGS.ignoreSyncKey;
							text.setValue(this.plugin.settings.ignoreSyncKey); // Update UI
						}
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Preserve Properties Keys")
			.setDesc(
				"Enter a comma-separated list of property keys (frontmatter keys) whose values should be preserved from the existing note in Obsidian during an update. These values will be kept even if the incoming data from Dinox is different."
			)
			.addTextArea(
				(
					text // Use TextArea for potentially longer lists
				) =>
					text
						.setPlaceholder("e.g., tags, aliases, status, project")
						.setValue(this.plugin.settings.preserveKeys)
						.onChange(async (value) => {
							// Store the raw comma-separated string
							this.plugin.settings.preserveKeys = value;
							await this.plugin.saveSettings();
						})
			);
		// Content Template (Sent to API)
		new Setting(containerEl)
			.setName("Content Template (Sent to API)")
			.setDesc(
				"This template is sent to the Dinox API during sync requests. The API should apply it to generate the note content."
			)
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
			.setName("Enable Auto Sync")
			.setDesc(
				"Automatically sync notes every 30 minutes. Reload Obsidian after changing."
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.isAutoSync)
					.onChange(async (value) => {
						this.plugin.settings.isAutoSync = value;
						await this.plugin.saveSettings();
						new Notice(
							"Reload Obsidian for auto-sync changes to take effect."
						);
					})
			);

		// Reset Sync Button (Simplified)
		containerEl.createEl("h3", { text: "Advanced" });
		new Setting(containerEl)
			.setName("Reset Sync State")
			.setDesc(
				"Clears the last sync time. The next sync will fetch and process all notes from Dinox. Use this if you suspect sync issues."
			)
			.addButton((button) =>
				button
					.setButtonText("Reset Sync Time")
					.setWarning()
					.onClick(async () => {
						const confirmed = confirm(
							"Are you sure you want to reset the Dinox last sync time? The next sync will fetch all notes."
						);
						if (confirmed) {
							// Use the reset command logic directly
							const pData = (await this.plugin.loadData()) || {};
							await this.plugin.saveData({
								...pData,
								lastSyncTime: "1900-01-01 00:00:00",
							});
							new Notice("Dinox last sync time has been reset.");
						}
					})
			);
	}
}
