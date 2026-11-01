import {
	App,
	Notice,
	PluginSettingTab,
	Setting,
	ButtonComponent,
} from "obsidian";
import { DEFAULT_LAST_SYNC_TIME, DEFAULT_TEMPLATE_TEXT } from "./constants";
import { validateTemplate } from "./template";
import { ConfirmModal } from "./confirm-modal";
import { sanitizeRelativeFolderSubpath } from "./type-folders";
import { fetchZettelBoxes } from "./api";
import { getErrorMessage } from "./utils";
import type { DinoCommandKey, DinoHotkeySetting, ZettelBoxNode } from "./types";
import type { DinoPluginAPI } from "./plugin-types";

/**
 * One settings row: its searchable name/description plus a function that
 * builds the row's controls onto an Obsidian `Setting`.
 *
 * The same specs drive both rendering paths:
 * - Obsidian >= 1.13 calls `getSettingDefinitions()`, which exposes them as
 *   declarative `render` items, so the rows show up in settings search.
 * - Older Obsidian calls `display()`, which renders them imperatively.
 */
interface SettingSpec {
	name: string;
	desc?: string;
	build: (setting: Setting) => void;
}

interface SectionSpec {
	heading: string;
	items: SettingSpec[];
}

// Minimal local typings for the subset of Obsidian 1.13's declarative settings
// API that we use. Declared here so the plugin still compiles against the older
// `obsidian` typings that match its minAppVersion.
interface DeclarativeRenderItem {
	name: string;
	desc?: string;
	render: (setting: Setting) => void;
}

interface DeclarativeGroup {
	type: "group";
	heading?: string;
	items: DeclarativeRenderItem[];
}

type Disableable = { setDisabled(disabled: boolean): void };

function addHeading(containerEl: HTMLElement, text: string): void {
	new Setting(containerEl)
		.setName(text)
		.setHeading();
}

export class DinoSettingTab extends PluginSettingTab {
	private readonly plugin: DinoPluginAPI;
	private readonly t: (key: Parameters<DinoPluginAPI["t"]>[0], vars?: Parameters<DinoPluginAPI["t"]>[1]) => string;
	// Cached card-box list so toggling checkboxes does not refetch each time.
	private zettelBoxCache: ZettelBoxNode[] | null = null;

	constructor(app: App, plugin: DinoPluginAPI) {
		super(app, plugin);
		this.plugin = plugin;
		this.t = (key, vars) => this.plugin.t(key, vars);
	}

	/** Obsidian >= 1.13: declarative definitions (rendered + search-indexed). */
	getSettingDefinitions(): DeclarativeGroup[] {
		this.prepareRender();
		return this.buildSections().map((section) => ({
			type: "group",
			heading: section.heading,
			items: section.items.map((item) => ({
				name: item.name,
				desc: item.desc,
				render: (setting: Setting) => {
					setting.setName(item.name);
					if (item.desc !== undefined) {
						setting.setDesc(item.desc);
					}
					item.build(setting);
				},
			})),
		}));
	}

	/** Obsidian < 1.13: imperative rendering from the same specs. */
	display(): void {
		const { containerEl } = this;
		this.prepareRender();
		containerEl.empty();
		for (const section of this.buildSections()) {
			addHeading(containerEl, section.heading);
			for (const item of section.items) {
				const setting = new Setting(containerEl).setName(item.name);
				if (item.desc !== undefined) {
					setting.setDesc(item.desc);
				}
				item.build(setting);
			}
		}
	}

	private prepareRender(): void {
		this.plugin.cancelHotkeyCapture(false);
		this.plugin.refreshLocale();
	}

	/**
	 * Build fresh specs. Rows that enable/disable each other share state through
	 * closures created here, so every render pass gets its own set.
	 */
	private buildSections(): SectionSpec[] {
		const t = this.t;
		return [
			{
				heading: t("settings.title"),
				items: this.buildGeneralItems(),
			},
			{
				heading: t("settings.filenameHeading"),
				items: this.buildFilenameItems(),
			},
			{
				heading: t("settings.section.typeFolders"),
				items: this.buildTypeFolderItems(),
			},
			{
				heading: t("settings.section.zettelBoxFolders"),
				items: [this.buildZettelBoxFoldersToggle()],
			},
			{
				heading: t("settings.section.syncScope"),
				items: [
					...this.buildSyncScopeItems(),
					...this.buildSyncBehaviourItems(),
				],
			},
			{
				heading: t("settings.section.dailyNotes"),
				items: this.buildDailyNotesItems(),
			},
			{
				heading: t("settings.section.hotkeys"),
				items: [
					this.buildHotkeyItem(
						t("settings.hotkeys.syncAll.name"),
						t("settings.hotkeys.syncAll.desc"),
						"syncAll"
					),
					this.buildHotkeyItem(
						t("settings.hotkeys.syncCurrent.name"),
						t("settings.hotkeys.syncCurrent.desc"),
						"syncCurrentNote"
					),
					this.buildHotkeyItem(
						t("settings.hotkeys.create.name"),
						t("settings.hotkeys.create.desc"),
						"createNote"
					),
				],
			},
			{
				heading: t("settings.section.advanced"),
				items: [this.buildResetItem()],
			},
		];
	}

	private buildGeneralItems(): SettingSpec[] {
		const t = this.t;
		return [
			{
				name: t("settings.token.name"),
				desc: t("settings.token.desc"),
				build: (setting) => {
					setting.addText((text) => {
						text
							.setPlaceholder(t("settings.token.placeholder"))
							.setValue(this.plugin.settings.token)
							.onChange(async (value) => {
								this.plugin.settings.token = value.trim();
								await this.plugin.saveSettings();
							});
						text.inputEl.type = "password";
					});
				},
			},
			{
				name: t("settings.dir.name"),
				desc: t("settings.dir.desc"),
				build: (setting) => {
					setting.addText((text) =>
						text
							.setPlaceholder(t("settings.dir.placeholder"))
							.setValue(this.plugin.settings.dir)
							.onChange(async (value) => {
								const sanitized =
									sanitizeRelativeFolderSubpath(value) ??
									this.plugin.defaults.dir;
								if (
									value.trim() !== "" &&
									sanitizeRelativeFolderSubpath(value) === null
								) {
									new Notice(t("notice.typeFoldersInvalidReverted"));
								}
								this.plugin.settings.dir = sanitized;
								await this.plugin.saveSettings();
								text.setValue(this.plugin.settings.dir);
							})
					);
				},
			},
		];
	}

	private buildFilenameItems(): SettingSpec[] {
		const t = this.t;
		const filenameControls: Disableable[] = [];
		return [
			{
				name: t("settings.filename.name"),
				desc: t("settings.filename.desc"),
				build: (setting) => {
					setting.addDropdown((dropdown) => {
						dropdown
							.addOption("noteId", t("settings.filename.optionId"))
							.addOption("title", t("settings.filename.optionTitle"))
							.addOption("time", t("settings.filename.optionTime"))
							.addOption("titleDate", t("settings.filename.optionTitleDate"))
							.addOption("template", t("settings.filename.optionTemplate"))
							.setValue(this.plugin.settings.filenameFormat)
							.onChange(async (value: "noteId" | "title" | "time" | "titleDate" | "template") => {
								this.plugin.settings.filenameFormat = value;
								await this.plugin.saveSettings();
								const enableTemplate = value === "template";
								filenameControls.forEach((c) => c.setDisabled(!enableTemplate));
							});
					});
				},
			},
			{
				name: t("settings.filename.template.name"),
				desc: t("settings.filename.template.desc"),
				build: (setting) => {
					setting.addText((text) => {
						text
							.setPlaceholder(t("settings.filename.template.placeholder"))
							.setValue(this.plugin.settings.filenameTemplate)
							.setDisabled(this.plugin.settings.filenameFormat !== "template")
							.onChange(async (value) => {
								this.plugin.settings.filenameTemplate = value.trim();
								await this.plugin.saveSettings();
							});
						filenameControls.push(text);
					});
				},
			},
			{
				name: t("settings.layout.name"),
				desc: t("settings.layout.desc"),
				build: (setting) => {
					setting.addDropdown((dropdown) => {
						dropdown
							.addOption("nested", t("settings.layout.optionNested"))
							.addOption("flat", t("settings.layout.optionFlat"))
							.setValue(this.plugin.settings.fileLayout)
							.onChange(async (value: "flat" | "nested") => {
								this.plugin.settings.fileLayout = value;
								await this.plugin.saveSettings();
							});
					});
				},
			},
		];
	}

	private buildTypeFolderItems(): SettingSpec[] {
		const t = this.t;
		const typeFolderControls: Disableable[] = [];
		const updateTypeFolderControls = (enabled: boolean) => {
			typeFolderControls.forEach((control) => control.setDisabled(!enabled));
		};

		const buildFolderInput = (
			setting: Setting,
			kind: "note" | "material"
		): void => {
			const otherKind = kind === "note" ? "material" : "note";
			setting.addText((text) => {
				text
					.setPlaceholder(this.plugin.defaults.typeFolders[kind])
					.setValue(this.plugin.settings.typeFolders[kind])
					.setDisabled(!this.plugin.settings.typeFolders.enabled)
					.onChange(async (value) => {
						const sanitized =
							sanitizeRelativeFolderSubpath(value) ??
							this.plugin.defaults.typeFolders[kind];
						const other =
							sanitizeRelativeFolderSubpath(
								this.plugin.settings.typeFolders[otherKind]
							) ?? this.plugin.defaults.typeFolders[otherKind];

						if (sanitized === other) {
							new Notice(t("notice.typeFoldersSame"));
							text.setValue(this.plugin.settings.typeFolders[kind]);
							return;
						}

						if (
							value.trim() !== "" &&
							sanitizeRelativeFolderSubpath(value) === null
						) {
							new Notice(t("notice.typeFoldersInvalidReverted"));
						}

						this.plugin.settings.typeFolders[kind] = sanitized;
						await this.plugin.saveSettings();
						text.setValue(this.plugin.settings.typeFolders[kind]);
					});
				typeFolderControls.push(text);
			});
		};

		return [
			{
				name: t("settings.typeFolders.enable.name"),
				desc: t("settings.typeFolders.enable.desc"),
				build: (setting) => {
					setting.addToggle((toggle) =>
						toggle
							.setValue(this.plugin.settings.typeFolders.enabled)
							.onChange(async (value) => {
								this.plugin.settings.typeFolders.enabled = value;
								updateTypeFolderControls(value);
								await this.plugin.saveSettings();
							})
					);
				},
			},
			{
				name: t("settings.typeFolders.note.name"),
				desc: t("settings.typeFolders.note.desc"),
				build: (setting) => buildFolderInput(setting, "note"),
			},
			{
				name: t("settings.typeFolders.material.name"),
				desc: t("settings.typeFolders.material.desc"),
				build: (setting) => buildFolderInput(setting, "material"),
			},
		];
	}

	private buildZettelBoxFoldersToggle(): SettingSpec {
		const t = this.t;
		return {
			name: t("settings.zettelBoxFolders.enable.name"),
			desc: t("settings.zettelBoxFolders.enable.desc"),
			build: (setting) => {
				setting.addToggle((toggle) =>
					toggle
						.setValue(this.plugin.settings.zettelBoxFolders.enabled)
						.onChange(async (value) => {
							this.plugin.settings.zettelBoxFolders.enabled = value;
							await this.plugin.saveSettings();
						})
				);
			},
		};
	}

	private buildSyncScopeItems(): SettingSpec[] {
		const t = this.t;
		// Set by the picker row once built; lets the toggle show/hide it in
		// place instead of re-rendering the whole tab.
		let showPicker: ((enabled: boolean) => void) | null = null;

		return [
			{
				name: t("settings.syncScope.enable.name"),
				desc: t("settings.syncScope.enable.desc"),
				build: (setting) => {
					setting.addToggle((toggle) =>
						toggle
							.setValue(this.plugin.settings.syncScope.enabled)
							.onChange(async (value) => {
								this.plugin.settings.syncScope.enabled = value;
								await this.plugin.saveSettings();
								showPicker?.(value);
							})
					);
				},
			},
			{
				name: t("settings.syncScope.refresh"),
				build: (setting) => {
					setting.settingEl.addClass("dinox-zettel-scope-setting");
					const updateCount = (): void => {
						setting.setDesc(
							t("settings.syncScope.selectedCount", {
								count: this.plugin.settings.syncScope.selectedBoxIds.length,
							})
						);
					};
					updateCount();

					const treeEl = setting.settingEl.createDiv({
						cls: "dinox-zettel-scope-tree",
					});
					setting.addButton((btn) =>
						btn
							.setButtonText(t("settings.syncScope.refresh"))
							.onClick(async () => {
								this.zettelBoxCache = null;
								await this.loadZettelBoxesInto(treeEl, updateCount);
							})
					);

					let loaded = false;
					showPicker = (enabled: boolean) => {
						setting.settingEl.toggle(enabled);
						if (enabled && !loaded) {
							loaded = true;
							void this.loadZettelBoxesInto(treeEl, updateCount);
						}
					};
					showPicker(this.plugin.settings.syncScope.enabled);
				},
			},
		];
	}

	private buildSyncBehaviourItems(): SettingSpec[] {
		const t = this.t;
		return [
			{
				name: t("settings.ignoreKey.name"),
				desc: t("settings.ignoreKey.desc"),
				build: (setting) => {
					setting.addText((text) =>
						text
							.setPlaceholder(this.plugin.settings.ignoreSyncKey)
							.setValue(this.plugin.settings.ignoreSyncKey)
							.onChange(async (value) => {
								const cleanedValue = value.trim();
								if (cleanedValue && !/\s/.test(cleanedValue)) {
									this.plugin.settings.ignoreSyncKey = cleanedValue;
								} else if (!cleanedValue) {
									this.plugin.settings.ignoreSyncKey =
										this.plugin.defaults.ignoreSyncKey;
									new Notice(t("notice.invalidIgnoreKeyReverted"));
									text.setValue(this.plugin.settings.ignoreSyncKey);
								} else {
									new Notice(t("notice.invalidIgnoreKeySpaces"));
									this.plugin.settings.ignoreSyncKey =
										this.plugin.defaults.ignoreSyncKey;
									text.setValue(this.plugin.settings.ignoreSyncKey);
								}
								await this.plugin.saveSettings();
							})
					);
				},
			},
			{
				name: t("settings.preserveKeys.name"),
				desc: t("settings.preserveKeys.desc"),
				build: (setting) => {
					setting.addTextArea((text) =>
						text
							.setPlaceholder(t("settings.preserveKeys.placeholder"))
							.setValue(this.plugin.settings.preserveKeys)
							.onChange(async (value) => {
								this.plugin.settings.preserveKeys = value;
								await this.plugin.saveSettings();
							})
					);
				},
			},
			{
				name: t("settings.template.name"),
				desc: t("settings.template.desc"),
				build: (setting) => {
					setting.addTextArea((text) => {
						text
							.setPlaceholder(DEFAULT_TEMPLATE_TEXT)
							.setValue(this.plugin.settings.template)
							.onChange(async (value) => {
								// Live, non-intrusive feedback: turn the field red while
								// the template is malformed. onChange fires on every
								// keystroke, so a toast here would spam during normal
								// typing — the loud, actionable warning is raised once at
								// sync time instead (see syncNotes).
								const isInvalid = validateTemplate(value) !== null;
								text.inputEl.toggleClass(
									"dino-sync-template-invalid",
									isInvalid
								);
								if (isInvalid) {
									// Don't persist a broken template — it would silently
									// drop frontmatter from every note on the next sync.
									return;
								}
								this.plugin.settings.template = value;
								await this.plugin.saveSettings();
							});
						text.inputEl.rows = 10;
						text.inputEl.cols = 60;
						text.inputEl.classList.add("dino-sync-template-setting");
					});
				},
			},
			{
				name: t("settings.autoSync.name"),
				desc: t("settings.autoSync.desc"),
				build: (setting) => {
					setting.addToggle((toggle) =>
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
				},
			},
		];
	}

	private buildDailyNotesItems(): SettingSpec[] {
		const t = this.t;
		const dailyNotesControls: Disableable[] = [];
		const updateDailyNotesControls = (enabled: boolean) => {
			dailyNotesControls.forEach((control) => control.setDisabled(!enabled));
		};
		const isEnabled = () => this.plugin.settings.dailyNotes.enabled;

		return [
			{
				name: t("settings.dailyNotes.enable.name"),
				desc: t("settings.dailyNotes.enable.desc"),
				build: (setting) => {
					setting.addToggle((toggle) =>
						toggle
							.setValue(isEnabled())
							.onChange(async (value) => {
								this.plugin.settings.dailyNotes.enabled = value;
								updateDailyNotesControls(value);
								await this.plugin.saveSettings();
							})
					);
				},
			},
			{
				name: t("settings.dailyNotes.heading.name"),
				desc: t("settings.dailyNotes.heading.desc"),
				build: (setting) => {
					setting.addText((text) => {
						text
							.setPlaceholder("## Dinox notes")
							.setValue(this.plugin.settings.dailyNotes.heading)
							.setDisabled(!isEnabled())
							.onChange(async (value) => {
								this.plugin.settings.dailyNotes.heading =
									value.trim() || "## Dinox Notes";
								await this.plugin.saveSettings();
							});
						dailyNotesControls.push(text);
					});
				},
			},
			{
				name: t("settings.dailyNotes.position.name"),
				desc: t("settings.dailyNotes.position.desc"),
				build: (setting) => {
					setting.addDropdown((dropdown) => {
						dropdown
							.addOption("top", t("settings.dailyNotes.position.top"))
							.addOption("bottom", t("settings.dailyNotes.position.bottom"))
							.setValue(this.plugin.settings.dailyNotes.insertTo)
							.setDisabled(!isEnabled())
							.onChange(async (value: "top" | "bottom") => {
								this.plugin.settings.dailyNotes.insertTo = value;
								await this.plugin.saveSettings();
							});
						dailyNotesControls.push(dropdown);
					});
				},
			},
			{
				name: t("settings.dailyNotes.linkStyle.name"),
				desc: t("settings.dailyNotes.linkStyle.desc"),
				build: (setting) => {
					setting.addDropdown((dropdown) => {
						dropdown
							.addOption(
								"wikilink",
								t("settings.dailyNotes.linkStyle.wikilink")
							)
							.addOption(
								"embed",
								t("settings.dailyNotes.linkStyle.embed")
							)
							.setValue(this.plugin.settings.dailyNotes.linkStyle)
							.setDisabled(!isEnabled())
							.onChange(async (value: "wikilink" | "embed") => {
								this.plugin.settings.dailyNotes.linkStyle = value;
								await this.plugin.saveSettings();
							});
						dailyNotesControls.push(dropdown);
					});
				},
			},
			{
				name: t("settings.dailyNotes.preview.name"),
				desc: t("settings.dailyNotes.preview.desc"),
				build: (setting) => {
					setting.addToggle((toggle) => {
						toggle
							.setValue(this.plugin.settings.dailyNotes.includePreview)
							.setDisabled(!isEnabled())
							.onChange(async (value) => {
								this.plugin.settings.dailyNotes.includePreview = value;
								await this.plugin.saveSettings();
							});
						dailyNotesControls.push(toggle);
					});
				},
			},
			{
				name: t("settings.dailyNotes.create.name"),
				desc: t("settings.dailyNotes.create.desc"),
				build: (setting) => {
					setting.addToggle((toggle) => {
						toggle
							.setValue(this.plugin.settings.dailyNotes.createIfMissing)
							.setDisabled(!isEnabled())
							.onChange(async (value) => {
								this.plugin.settings.dailyNotes.createIfMissing = value;
								await this.plugin.saveSettings();
							});
						dailyNotesControls.push(toggle);
					});
				},
			},
		];
	}

	private async loadZettelBoxesInto(
		treeEl: HTMLElement,
		updateCount: () => void
	): Promise<void> {
		const t = this.t;
		treeEl.empty();

		const token = this.plugin.settings.token;
		if (!token) {
			treeEl.createDiv({
				cls: "dinox-zettel-note",
				text: t("settings.syncScope.tokenRequired"),
			});
			return;
		}

		if (this.zettelBoxCache) {
			this.renderZettelBoxTree(treeEl, this.zettelBoxCache, updateCount);
			return;
		}

		treeEl.createDiv({
			cls: "dinox-zettel-note",
			text: t("settings.syncScope.loading"),
		});
		try {
			const boxes = await fetchZettelBoxes(token);
			this.zettelBoxCache = boxes;
			this.renderZettelBoxTree(treeEl, boxes, updateCount);
		} catch (error) {
			treeEl.empty();
			treeEl.createDiv({
				cls: "dinox-zettel-note",
				text: t("settings.syncScope.loadFailed", {
					error: getErrorMessage(error),
				}),
			});
		}
	}

	private renderZettelBoxTree(
		treeEl: HTMLElement,
		boxes: ZettelBoxNode[],
		updateCount: () => void
	): void {
		const t = this.t;
		treeEl.empty();

		if (boxes.length === 0) {
			treeEl.createDiv({
				cls: "dinox-zettel-note",
				text: t("settings.syncScope.empty"),
			});
			return;
		}

		const byId = new Map(boxes.map((box) => [box.id, box]));
		const childrenByParent = new Map<string, ZettelBoxNode[]>();
		const roots: ZettelBoxNode[] = [];
		for (const box of boxes) {
			if (box.parentId && byId.has(box.parentId)) {
				const list = childrenByParent.get(box.parentId) ?? [];
				list.push(box);
				childrenByParent.set(box.parentId, list);
			} else {
				roots.push(box);
			}
		}

		const sortNodes = (list: ZettelBoxNode[]): ZettelBoxNode[] =>
			list.sort(
				(a, b) => a.priority - b.priority || a.name.localeCompare(b.name)
			);

		const selected = new Set(
			this.plugin.settings.syncScope.selectedBoxIds
		);
		const hasSelectedAncestor = (box: ZettelBoxNode): boolean => {
			const guard = new Set<string>();
			let current = box.parentId ? byId.get(box.parentId) : undefined;
			while (current && !guard.has(current.id)) {
				if (selected.has(current.id)) {
					return true;
				}
				guard.add(current.id);
				current = current.parentId
					? byId.get(current.parentId)
					: undefined;
			}
			return false;
		};

		const tree = treeEl.createDiv({ cls: "dinox-zettel-tree" });
		const renderNode = (
			node: ZettelBoxNode,
			parentEl: HTMLElement
		): void => {
			const implied = hasSelectedAncestor(node);
			const row = parentEl.createDiv({
				cls: implied
					? "dinox-zettel-row is-implied"
					: "dinox-zettel-row",
			});
			const checkbox = row.createEl("input");
			checkbox.type = "checkbox";
			checkbox.checked = implied || selected.has(node.id);
			checkbox.disabled = implied;
			row.createSpan({ text: node.name });

			if (!implied) {
				checkbox.addEventListener("change", () => {
					if (checkbox.checked) {
						selected.add(node.id);
					} else {
						selected.delete(node.id);
					}
					this.plugin.settings.syncScope.selectedBoxIds = [
						...selected,
					];
					updateCount();
					void (async () => {
						await this.plugin.saveSettings();
						// Re-render so implied (descendant) rows update.
						this.renderZettelBoxTree(treeEl, boxes, updateCount);
					})();
				});
			}

			const kids = childrenByParent.get(node.id);
			if (kids && kids.length > 0) {
				const childrenEl = parentEl.createDiv({
					cls: "dinox-zettel-children",
				});
				for (const kid of sortNodes([...kids])) {
					renderNode(kid, childrenEl);
				}
			}
		};

		for (const root of sortNodes([...roots])) {
			renderNode(root, tree);
		}
	}

	private buildResetItem(): SettingSpec {
		const t = this.t;
		return {
			name: t("settings.advanced.reset.name"),
			desc: t("settings.advanced.reset.desc"),
			build: (setting) => {
				let selectedPreset = "start";
				setting
					.addDropdown((dropdown) => {
						dropdown
							.addOption("yesterday", t("settings.advanced.preset.yesterday"))
							.addOption("threeDays", t("settings.advanced.preset.threeDays"))
							.addOption("oneWeek", t("settings.advanced.preset.oneWeek"))
							.addOption("oneMonth", t("settings.advanced.preset.oneMonth"))
							.addOption("start", t("settings.advanced.preset.start"))
							.setValue("start")
							.onChange((value) => {
								selectedPreset = value;
							});
					})
					.addButton((button) =>
						button
							.setButtonText(t("settings.advanced.resetButton"))
							.setWarning()
							.onClick(() => {
								new ConfirmModal(
									this.app,
									t("settings.advanced.confirm"),
									async () => {
										await this.plugin.setLastSyncTime(
											resetPresetToSyncTime(selectedPreset, new Date())
										);
										new Notice(this.plugin.t("notice.resetDone"));
									}
								).open();
							})
					);
			},
		};
	}

	private buildHotkeyItem(
		label: string,
		description: string,
		commandKey: DinoCommandKey
	): SettingSpec {
		const t = this.t;
		return {
			name: label,
			desc: description,
			build: (setting) => {
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
						const message = labelText
							? this.plugin.t("notice.hotkeySet", { hotkey: labelText })
							: this.plugin.t("notice.hotkeyCleared");
						new Notice(message);
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
			},
		};
	}
}

const DAY_MS = 24 * 60 * 60 * 1000;
const RESET_PRESET_DAYS: Record<string, number> = {
	yesterday: 1,
	threeDays: 3,
	oneWeek: 7,
	oneMonth: 30,
};

/** Map a "reset sync cursor" preset to the `lastSyncTime` string to store. */
function resetPresetToSyncTime(preset: string, now: Date): string {
	const days = RESET_PRESET_DAYS[preset];
	if (days === undefined) {
		return DEFAULT_LAST_SYNC_TIME;
	}
	const d = new Date(now.getTime() - days * DAY_MS);
	const pad = (n: number) => n.toString().padStart(2, "0");
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
