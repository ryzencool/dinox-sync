import {
	App,
	Notice,
	PluginSettingTab,
	Setting,
	ButtonComponent,
} from "obsidian";
import { DEFAULT_TEMPLATE_TEXT } from "./constants";
import type { DinoCommandKey, DinoHotkeySetting } from "./types";
import type { DinoPluginAPI } from "./plugin-types";

export class DinoSettingTab extends PluginSettingTab {
	private readonly plugin: DinoPluginAPI;
	private readonly t: DinoPluginAPI["t"];

	constructor(app: App, plugin: DinoPluginAPI) {
		super(app, plugin);
		this.plugin = plugin;
		this.t = this.plugin.t.bind(this.plugin);
	}

	display(): void {
		const { containerEl } = this;
		this.plugin.cancelHotkeyCapture(false);
		this.plugin.refreshLocale();
		const t = this.t;
		containerEl.empty();
		containerEl.createEl("h2", { text: t("settings.title") });

		new Setting(containerEl)
			.setName(t("settings.token.name"))
			.setDesc(t("settings.token.desc"))
			.addText((text) =>
				text
					.setPlaceholder(t("settings.token.placeholder"))
					.setValue(this.plugin.settings.token)
					.onChange(async (value) => {
						this.plugin.settings.token = value.trim();
						await this.plugin.saveSettings();
					})
			);

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
							this.plugin.defaults.dir;
						await this.plugin.saveSettings();
					})
			);

		containerEl.createEl("h3", { text: t("settings.filenameHeading") });

		new Setting(containerEl)
			.setName(t("settings.filename.name"))
			.setDesc(t("settings.filename.desc"))
			.addDropdown((dropdown) => {
				dropdown
					.addOption("noteId", t("settings.filename.optionId"))
					.addOption("title", t("settings.filename.optionTitle"))
					.addOption("time", t("settings.filename.optionTime"))
					.setValue(this.plugin.settings.filenameFormat)
					.onChange(async (value: "noteId" | "title" | "time") => {
						this.plugin.settings.filenameFormat = value;
						await this.plugin.saveSettings();
					});
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
							const data = (await this.plugin.loadData()) || {};
							await this.plugin.saveData({
								...data,
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
