import {
	App,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	requestUrl,
	Editor, MarkdownView, Menu, MenuItem
} from "obsidian";
import 'bigint-polyfill';


interface Note {
	title: string;
	createTime: string;
	content: string;
	noteId: string;
	tags: string[];
	isDel: boolean,
	isAudio: boolean,
	zettelBoxes: string[]
}


const TEMPLATE = `---
标题：{{title}}
笔记 ID: {{noteId}}
笔记类型: {{type}}
tags:
{{#tags}}
    - {{.}}
{{/tags}}
卡片盒：
{{#zettelBoxes}}
    - {{.}}
{{/zettelBoxes}}
包含语音: {{isAudio}}
网页链接:
创建时间: {{createTime}}
更新时间: {{updateTime}}
---
{{#audioUrl}}
![录音]({{audioUrl}})
{{/audioUrl}}

{{content}}
`;

interface GetNoteApiResult {
	code: string;
	data: DayNote[];
}

interface DayNote {
	date: string;
	notes: Note[];
}

interface DinoPluginSettings {
	token: string;
	isAutoSync: boolean;
	dir: string;
	template: string;
	filenameFormat: string;
	fileLayout: string
}

const DEFAULT_SETTINGS: DinoPluginSettings = {
	token: "",
	isAutoSync: false,
	dir: "Dinox Sync",
	template: TEMPLATE,
	filenameFormat: "noteId",
	fileLayout: "nested"
};

function formatDate(date: Date): string {
	const year = date.getFullYear();
	const month = String(date.getMonth() + 1).padStart(2, '0');
	const day = String(date.getDate()).padStart(2, '0');
	const hours = String(date.getHours()).padStart(2, '0');
	const minutes = String(date.getMinutes()).padStart(2, '0');
	const seconds = String(date.getSeconds()).padStart(2, '0');
	return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

export default class DinoPlugin extends Plugin {
	settings: DinoPluginSettings;
	statusBarItemEl: HTMLElement;

	async fetchData() {
		const pData = await this.loadData()
		let lastSyncTime = "1900-01-01 00:00:00";
		if (pData.lastSyncTime && pData.lastSyncTime != "") {
			const lTime = new Date(pData.lastSyncTime);
			lastSyncTime = formatDate(lTime);
		}
		console.log("上次同步时间：", lastSyncTime)
		const startSyncTime = formatDate(new Date())

		const body = JSON.stringify({
			template: this.settings.template,
			noteId: 0,
			lastSyncTime: lastSyncTime,
		})
		const resp = await requestUrl({
			url: `https://dinoai.chatgo.pro/openapi/v5/notes`,
			method: "POST",
			headers: {
				Authorization: this.settings.token,
				"Content-Type": "application/json"
			},
			body: body
		});

		const resultJson = await resp.json;


		const result = resultJson as GetNoteApiResult;
		if (result && result.code == "000000") {
			const dayNotes = result.data;

			for (const it of dayNotes) {
				let datePath = `${this.settings.dir}/${it.date}`;
				if (this.settings.fileLayout == "nested") {
					datePath = `${this.settings.dir}/${it.date}`
				} else {
					datePath = this.settings.dir
				}
				const date = this.app.vault.getFolderByPath(datePath);
				if (date == null) {
					await this.app.vault.createFolder(datePath);
				}
				try {
					for (const itt of it.notes) {

						// 判断是否删除

						if (itt.isDel) {
							// 若已经删除
							let filename = ""
							if (this.settings.filenameFormat == "noteId") {
								filename = itt.noteId.replace("-", "_")
							} else if (this.settings.filenameFormat == "title") {
								if (itt.title && itt.title != "") {
									filename = itt.title
								} else {
									filename = itt.noteId.replace("-", "_")
								}
							} else if (this.settings.filenameFormat == "time") {
								filename = formatDate(new Date(itt.createTime))
							} else {
								filename = itt.noteId.replace("-", "_")
							}
							const notePath = `${datePath}/${filename}_dinox.md`
							const note = this.app.vault.getAbstractFileByPath(notePath);
							if (note != null) {
								await this.app.vault.delete(note, true);
							}
						} else {
							// 未删除
							let filename = ""
							if (this.settings.filenameFormat == "noteId") {
								filename = itt.noteId.replace("-", "_")
							} else if (this.settings.filenameFormat == "title") {
								if (itt.title && itt.title != "") {
									filename = itt.title
								} else {
									filename = itt.noteId.replace("-", "_")
								}
							} else if (this.settings.filenameFormat == "time") {
								filename = formatDate(new Date(itt.createTime))
							} else {
								filename = itt.noteId.replace("-", "_")
							}
							const notePath = `${datePath}/${filename}_dinox.md`
							const note = this.app.vault.getAbstractFileByPath(notePath);
							if (note != null) {
								await this.app.vault.delete(note, true);
							}
							await this.app.vault.create(
								`${datePath}/${filename}_dinox.md`,
								itt.content
							);
						}
					}
				} catch (e) {
					console.log("error", e.message)
				}
			}
		}

		console.log("保存记录")
		console.log(startSyncTime)
		await this.saveData({
			...pData,
			lastSyncTime: startSyncTime,
		})
	}

	async onStatusBarClick() {
		const dir = this.app.vault.getFolderByPath(this.settings.dir);
		if (dir == null) {
			await this.app.vault.createFolder(this.settings.dir);
		}
		await this.fetchData();
		new Notice("sync success");
	}

	async onload() {

		await this.loadSettings();
		this.statusBarItemEl = this.addStatusBarItem();
		this.statusBarItemEl.setText("Dinox");
		this.statusBarItemEl.addEventListener(
			"click",
			this.onStatusBarClick.bind(this)
		);

		this.addSettingTab(new DinoSettingTab(this.app, this));

		this.addCommand({
			id: "dinox-sync-command",
			name: "Synchronize notes",
			editorCallback: async (editor: Editor, view: MarkdownView) => {
				await this.fetchData()
			}
		});

		this.addCommand({
			id: "dinox-reset-sync-command",
			name: "Reset Sync",
			editorCallback: async (editor: Editor, view: MarkdownView) => {
				const pData = await this.loadData()
				await this.saveData({
					...pData,
					lastSyncTime: "1900-01-01 00:00:00"
				})
				new Notice("Reset Sync")
			}
		});

		// 新增：添加右键菜单项
		this.registerEvent(
			this.app.workspace.on('editor-menu', (menu: Menu, editor: Editor) => {
				if (!editor || editor.getSelection().length === 0) {
					return;
				}

				const selectedText = editor.getSelection();
				const trimText = selectedText.length > 8
					? selectedText.substring(0, 3) + "..." + selectedText.substring(selectedText.length - 3)
					: selectedText;

				menu.addItem((item: MenuItem) => {
					item.setTitle('Send "' + trimText + '" to Dinox')
						.onClick(() => this.sendToDinox(selectedText));
				});
			})
		);

		this.registerEvent(
			this.app.workspace.on('editor-menu', (menu: Menu, editor: Editor) => {
				if (!editor ) {
					return;
				}


				menu.addItem((item: MenuItem) => {
					item.setTitle('Sync to Dinox')
						.onClick(() => this.syncToDinox(editor));
				});
			})
		);

		this.settings.isAutoSync &&
		this.registerInterval(
			window.setInterval(async () => {
				await this.fetchData();
			}, 30 * 60 * 1000)
		);
	}

	async syncToDinox(editor: Editor) {
		const content = editor.getValue()
		const uuidPattern = /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g;
		if (content) {
			const matches = content.match(uuidPattern);
			const noteId = matches?.[0];
			if (noteId) {
				const arr= content.split("---")
				const finalContent = arr.slice(2, arr.length).join("")
				try {
					const resp = await requestUrl({
						url: `https://dinoai.chatgo.pro/openapi/updateNote`,
						method: "POST",
						headers: {
							Authorization: this.settings.token,
							"Content-Type": "application/json"
						},
						body: JSON.stringify({
							noteId: noteId,
							contentMd: finalContent
						})
					})

					const resultJson = await resp.json;
					if (resultJson.code === "000000") {
						new Notice('Sync to Dinox successfully');
					} else {
						new Notice('Sync to Dinox failed');
					}
				}catch (e) {
					new Notice('Sync to Dinox failed');
				}
			}

			if (noteId) {
				console.log(content);
			}
		}

	}
	// 更新：发送选中文本到 Dinox 的方法
	async sendToDinox(content: string) {
		if (!this.settings.token) {
			new Notice('Please set Dinox token first');
			return;
		}

		try {
			const body = JSON.stringify({
				content: content,
				tags: [], // 可以在这里添加标签逻辑
				title: "" // 可以在这里添加标题逻辑
			});

			const resp = await requestUrl({
				url: `https://dinoai.chatgo.pro/note/create`,
				method: "POST",
				headers: {
					Authorization: this.settings.token,
					"Content-Type": "application/json"
				},
				body: body
			});

			const resultJson = await resp.json;
			if (resultJson.code === "000000") {
				new Notice('Content sent to Dinox successfully');
			} else {
				new Notice('Failed to send content to Dinox: ' + resultJson.msg);
			}
		} catch (error) {
			console.error('Error sending content to Dinox:', error);
			new Notice('Error sending content to Dinox. Please check your settings and try again.');
		}
	}

	onunload() {
	}

	async loadSettings() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			await this.loadData()
		);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

class DinoSettingTab extends PluginSettingTab {
	plugin: DinoPlugin;

	constructor(app: App, plugin: DinoPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const {containerEl} = this;

		containerEl.empty();

		new Setting(containerEl)
			.setName("Dinox directory")
			.setDesc("Notes will be synchronized in this directory")
			.addText((text) =>
				text
					.setPlaceholder("Enter your dir")
					.setValue(this.plugin.settings.dir)
					.onChange(async (value) => {
						this.plugin.settings.dir = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Dinox token")
			.setDesc("token generated from dinox")
			.addText((text) =>
				text
					.setPlaceholder("Enter Your Dinox Token")
					.setValue(this.plugin.settings.token)
					.onChange(async (value) => {
						this.plugin.settings.token = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Content template")
			.setDesc("Enter your template")
			.addTextArea((text) => {
				text.setPlaceholder(TEMPLATE)
					.setValue(this.plugin.settings.template)
					.onChange(async (value) => {
						this.plugin.settings.template = value;
						await this.plugin.saveSettings();
					});
				text.inputEl.classList.add('setting-template'); // 添加自定义类

			});

		new Setting(containerEl)
			.setName("Allow auto synchronize")
			.setDesc("if allow, this plugin will sync every 30 min")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.isAutoSync)
					.onChange(async (value) => {
						this.plugin.settings.isAutoSync = value;
						await this.plugin.saveSettings();
					})
			);
		new Setting(containerEl)
			.setName("Filename format")
			.setDesc("set note filename")
			.addDropdown((dropdown) => {
				dropdown
					.addOption("time", "time")
					.addOption("noteId", "noteId")
					.addOption("title", "title")
					.setValue(this.plugin.settings.filenameFormat)
					.onChange(async (value) => {
						this.plugin.settings.filenameFormat = value;
						await this.plugin.saveSettings()
					})
			})
		new Setting(containerEl)
			.setName("File Layout")
			.setDesc("set file layout")
			.addDropdown((dropdown) => {
				dropdown
					.addOption("flat", "flat")
					.addOption("nested", "nested")
					.setValue(this.plugin.settings.fileLayout)
					.onChange(async (value) => {
						this.plugin.settings.fileLayout = value
						await this.plugin.saveSettings()
					})
			})
	}
}
