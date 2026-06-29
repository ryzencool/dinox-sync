import {
	App,
	Modal,
	Notice,
	PluginSettingTab,
	Setting,
	ButtonComponent,
} from "obsidian";
import { DEFAULT_LAST_SYNC_TIME, DEFAULT_TEMPLATE_TEXT } from "./constants";
import { validateTemplate } from "./template";
import { sanitizeRelativeFolderSubpath } from "./type-folders";
import { fetchZettelBoxes } from "./api";
import { getErrorMessage } from "./utils";
import type { DinoCommandKey, DinoHotkeySetting, ZettelBoxNode } from "./types";
import type { DinoPluginAPI } from "./plugin-types";

class ConfirmModal extends Modal {
	private readonly message: string;
	private readonly onConfirm: () => void | Promise<void>;

	constructor(app: App, message: string, onConfirm: () => void | Promise<void>) {
		super(app);
		this.message = message;
		this.onConfirm = onConfirm;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl("p", { text: this.message });
		new Setting(contentEl)
			.addButton((btn) =>
				btn
					.setButtonText("Confirm")
					.setWarning()
					.onClick(() => {
						this.close();
						void this.onConfirm();
					})
			)
			.addButton((btn) =>
				btn.setButtonText("Cancel").onClick(() => this.close())
			);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

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

	private renderSyncScopeSection(containerEl: HTMLElement): void {
		const t = this.t;
		addHeading(containerEl, t("settings.section.syncScope"));

		new Setting(containerEl)
			.setName(t("settings.syncScope.enable.name"))
			.setDesc(t("settings.syncScope.enable.desc"))
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.syncScope.enabled)
					.onChange(async (value) => {
						this.plugin.settings.syncScope.enabled = value;
						await this.plugin.saveSettings();
						// Re-render so the box picker shows/hides.
						this.display();
					})
			);

		if (!this.plugin.settings.syncScope.enabled) {
			return;
		}

		const countEl = containerEl.createDiv({ cls: "dinox-zettel-count" });
		const updateCount = (): void => {
			countEl.setText(
				t("settings.syncScope.selectedCount", {
					count: this.plugin.settings.syncScope.selectedBoxIds.length,
				})
			);
		};
		updateCount();

		let treeEl: HTMLElement;

		new Setting(containerEl)
			.setName(t("settings.syncScope.refresh"))
			.addButton((btn) =>
				btn
					.setButtonText(t("settings.syncScope.refresh"))
					.onClick(async () => {
						this.zettelBoxCache = null;
						await this.loadZettelBoxesInto(treeEl, updateCount);
					})
			);

		treeEl = containerEl.createDiv();
		void this.loadZettelBoxesInto(treeEl, updateCount);
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

	display(): void {
		const { containerEl } = this;
		this.plugin.cancelHotkeyCapture(false);
		this.plugin.refreshLocale();
		const t = this.t;
		containerEl.empty();
		addHeading(containerEl, t("settings.title"));

		new Setting(containerEl)
			.setName(t("settings.token.name"))
			.setDesc(t("settings.token.desc"))
			.addText((text) => {
				text
					.setPlaceholder(t("settings.token.placeholder"))
					.setValue(this.plugin.settings.token)
					.onChange(async (value) => {
						this.plugin.settings.token = value.trim();
						await this.plugin.saveSettings();
					});
				text.inputEl.type = "password";
			});

		new Setting(containerEl)
			.setName(t("settings.dir.name"))
			.setDesc(t("settings.dir.desc"))
			.addText((text) =>
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
						this.plugin.settings.dir =
							sanitized;
						await this.plugin.saveSettings();
						text.setValue(this.plugin.settings.dir);
					})
			);

		addHeading(containerEl, t("settings.filenameHeading"));

		const filenameControls: Array<{ setDisabled(disabled: boolean): void }> = [];

		new Setting(containerEl)
			.setName(t("settings.filename.name"))
			.setDesc(t("settings.filename.desc"))
			.addDropdown((dropdown) => {
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

		new Setting(containerEl)
			.setName(t("settings.filename.template.name"))
			.setDesc(t("settings.filename.template.desc"))
			.addText((text) => {
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

		new Setting(containerEl)
			.setName(t("settings.layout.name"))
			.setDesc(t("settings.layout.desc"))
			.addDropdown((dropdown) => {
				dropdown
					.addOption("nested", t("settings.layout.optionNested"))
					.addOption("flat", t("settings.layout.optionFlat"))
					.setValue(this.plugin.settings.fileLayout)
					.onChange(async (value: "flat" | "nested") => {
						this.plugin.settings.fileLayout = value;
						await this.plugin.saveSettings();
					});
			});

		addHeading(containerEl, t("settings.section.typeFolders"));

		const typeFolderControls: Array<{ setDisabled(disabled: boolean): void }> =
			[];
		const updateTypeFolderControls = (enabled: boolean) => {
			typeFolderControls.forEach((control) =>
				control.setDisabled(!enabled)
			);
		};

		new Setting(containerEl)
			.setName(t("settings.typeFolders.enable.name"))
			.setDesc(t("settings.typeFolders.enable.desc"))
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.typeFolders.enabled)
					.onChange(async (value) => {
						this.plugin.settings.typeFolders.enabled = value;
						updateTypeFolderControls(value);
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName(t("settings.typeFolders.note.name"))
			.setDesc(t("settings.typeFolders.note.desc"))
			.addText((text) => {
				text
					.setPlaceholder(this.plugin.defaults.typeFolders.note)
					.setValue(this.plugin.settings.typeFolders.note)
					.setDisabled(!this.plugin.settings.typeFolders.enabled)
					.onChange(async (value) => {
						const sanitized =
							sanitizeRelativeFolderSubpath(value) ??
							this.plugin.defaults.typeFolders.note;
						const other =
							sanitizeRelativeFolderSubpath(
								this.plugin.settings.typeFolders.material
							) ?? this.plugin.defaults.typeFolders.material;

						if (sanitized === other) {
							new Notice(t("notice.typeFoldersSame"));
							text.setValue(this.plugin.settings.typeFolders.note);
							return;
						}

						if (
							value.trim() !== "" &&
							sanitizeRelativeFolderSubpath(value) === null
						) {
							new Notice(t("notice.typeFoldersInvalidReverted"));
						}

						this.plugin.settings.typeFolders.note = sanitized;
						await this.plugin.saveSettings();
						text.setValue(this.plugin.settings.typeFolders.note);
					});
				typeFolderControls.push(text);
			});

		new Setting(containerEl)
			.setName(t("settings.typeFolders.material.name"))
			.setDesc(t("settings.typeFolders.material.desc"))
			.addText((text) => {
				text
					.setPlaceholder(this.plugin.defaults.typeFolders.material)
					.setValue(this.plugin.settings.typeFolders.material)
					.setDisabled(!this.plugin.settings.typeFolders.enabled)
					.onChange(async (value) => {
						const sanitized =
							sanitizeRelativeFolderSubpath(value) ??
							this.plugin.defaults.typeFolders.material;
						const other =
							sanitizeRelativeFolderSubpath(
								this.plugin.settings.typeFolders.note
							) ?? this.plugin.defaults.typeFolders.note;

						if (sanitized === other) {
							new Notice(t("notice.typeFoldersSame"));
							text.setValue(
								this.plugin.settings.typeFolders.material
							);
							return;
						}

						if (
							value.trim() !== "" &&
							sanitizeRelativeFolderSubpath(value) === null
						) {
							new Notice(t("notice.typeFoldersInvalidReverted"));
						}

						this.plugin.settings.typeFolders.material = sanitized;
						await this.plugin.saveSettings();
						text.setValue(this.plugin.settings.typeFolders.material);
					});
				typeFolderControls.push(text);
			});

		updateTypeFolderControls(this.plugin.settings.typeFolders.enabled);

		addHeading(containerEl, t("settings.section.zettelBoxFolders"));

		new Setting(containerEl)
			.setName(t("settings.zettelBoxFolders.enable.name"))
			.setDesc(t("settings.zettelBoxFolders.enable.desc"))
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.zettelBoxFolders.enabled)
					.onChange(async (value) => {
						this.plugin.settings.zettelBoxFolders.enabled = value;
						await this.plugin.saveSettings();
					})
			);

		this.renderSyncScopeSection(containerEl);

		new Setting(containerEl)
			.setName(t("settings.ignoreKey.name"))
			.setDesc(t("settings.ignoreKey.desc"))
			.addText((text) =>
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

		new Setting(containerEl)
			.setName(t("settings.preserveKeys.name"))
			.setDesc(t("settings.preserveKeys.desc"))
			.addTextArea((text) =>
				text
					.setPlaceholder(t("settings.preserveKeys.placeholder"))
					.setValue(this.plugin.settings.preserveKeys)
					.onChange(async (value) => {
						this.plugin.settings.preserveKeys = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName(t("settings.template.name"))
			.setDesc(t("settings.template.desc"))
			.addTextArea((text) => {
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

		addHeading(containerEl, t("settings.section.dailyNotes"));
		const dailyNotesControls: Array<{ setDisabled(disabled: boolean): void }> =
			[];
		const updateDailyNotesControls = (enabled: boolean) => {
			dailyNotesControls.forEach((control) =>
				control.setDisabled(!enabled)
			);
		};

		new Setting(containerEl)
			.setName(t("settings.dailyNotes.enable.name"))
			.setDesc(t("settings.dailyNotes.enable.desc"))
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.dailyNotes.enabled)
					.onChange(async (value) => {
						this.plugin.settings.dailyNotes.enabled = value;
						updateDailyNotesControls(value);
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName(t("settings.dailyNotes.heading.name"))
			.setDesc(t("settings.dailyNotes.heading.desc"))
			.addText((text) => {
				text
					.setPlaceholder("## Dinox notes")
					.setValue(this.plugin.settings.dailyNotes.heading)
					.setDisabled(!this.plugin.settings.dailyNotes.enabled)
					.onChange(async (value) => {
						this.plugin.settings.dailyNotes.heading =
						value.trim() || "## Dinox Notes";
						await this.plugin.saveSettings();
					});
				dailyNotesControls.push(text);
			});

		new Setting(containerEl)
			.setName(t("settings.dailyNotes.position.name"))
			.setDesc(t("settings.dailyNotes.position.desc"))
			.addDropdown((dropdown) => {
				dropdown
					.addOption("top", t("settings.dailyNotes.position.top"))
					.addOption("bottom", t("settings.dailyNotes.position.bottom"))
					.setValue(this.plugin.settings.dailyNotes.insertTo)
					.setDisabled(!this.plugin.settings.dailyNotes.enabled)
					.onChange(async (value: "top" | "bottom") => {
						this.plugin.settings.dailyNotes.insertTo = value;
						await this.plugin.saveSettings();
					});
				dailyNotesControls.push(dropdown);
			});

		new Setting(containerEl)
			.setName(t("settings.dailyNotes.linkStyle.name"))
			.setDesc(t("settings.dailyNotes.linkStyle.desc"))
			.addDropdown((dropdown) => {
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
					.setDisabled(!this.plugin.settings.dailyNotes.enabled)
					.onChange(async (value: "wikilink" | "embed") => {
						this.plugin.settings.dailyNotes.linkStyle = value;
						await this.plugin.saveSettings();
					});
				dailyNotesControls.push(dropdown);
			});

		new Setting(containerEl)
			.setName(t("settings.dailyNotes.preview.name"))
			.setDesc(t("settings.dailyNotes.preview.desc"))
			.addToggle((toggle) => {
				toggle
					.setValue(this.plugin.settings.dailyNotes.includePreview)
					.setDisabled(!this.plugin.settings.dailyNotes.enabled)
					.onChange(async (value) => {
						this.plugin.settings.dailyNotes.includePreview = value;
						await this.plugin.saveSettings();
					});
				dailyNotesControls.push(toggle);
			});

		new Setting(containerEl)
			.setName(t("settings.dailyNotes.create.name"))
			.setDesc(t("settings.dailyNotes.create.desc"))
			.addToggle((toggle) => {
				toggle
					.setValue(this.plugin.settings.dailyNotes.createIfMissing)
					.setDisabled(!this.plugin.settings.dailyNotes.enabled)
					.onChange(async (value) => {
						this.plugin.settings.dailyNotes.createIfMissing = value;
						await this.plugin.saveSettings();
					});
				dailyNotesControls.push(toggle);
			});
		updateDailyNotesControls(this.plugin.settings.dailyNotes.enabled);

		addHeading(containerEl, t("settings.section.hotkeys"));
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

		addHeading(containerEl, t("settings.section.advanced"));
		let selectedPreset = "start";
		new Setting(containerEl)
			.setName(t("settings.advanced.reset.name"))
			.setDesc(t("settings.advanced.reset.desc"))
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
								const pad = (n: number) => n.toString().padStart(2, "0");
								const format = (d: Date) =>
									`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
								const now = new Date();
								let targetTime = DEFAULT_LAST_SYNC_TIME;
								switch (selectedPreset) {
									case "yesterday": {
										const d = new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000);
										targetTime = format(d);
										break;
									}
									case "threeDays": {
										const d = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000);
										targetTime = format(d);
										break;
									}
									case "oneWeek": {
										const d = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
										targetTime = format(d);
										break;
									}
									case "oneMonth": {
										const d = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
										targetTime = format(d);
										break;
									}
									case "start":
									default:
										targetTime = DEFAULT_LAST_SYNC_TIME;
							}
								await this.plugin.setLastSyncTime(targetTime);
								new Notice(this.plugin.t("notice.resetDone"));
							}
						).open();
					})
			);
	}

	private addHotkeySetting(
		containerEl: HTMLElement,
		label: string,
		description: string,
		commandKey: DinoCommandKey
	): void {
		const t = this.t;
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
	}
}
