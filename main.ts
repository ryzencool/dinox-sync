import {
  App,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  requestUrl,
  RequestUrlParam,
} from "obsidian";

interface Note {
  title: string;
  createTime: string;
  content: string;
  noteId: string;
  tags: string[];
}

// Remember to rename these classes and interfaces!
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
}

const DEFAULT_SETTINGS: DinoPluginSettings = {
  token: "",
  isAutoSync: false,
};

export default class DinoPlugin extends Plugin {
  settings: DinoPluginSettings;
  statusBarItemEl: HTMLElement;

  async fetchData() {
    const resp = await requestUrl({
      url: `https://dinoai.chatgo.pro/openapi/notes?noteId=${0}`,
      method: "GET",
      headers: {
        Authorization: this.settings.token,
      },
    });

    const resultJson = await resp.json();

    const result = resultJson as GetNoteApiResult;
    if (result && result.code == "000000") {
      const dayNotes = result.data;
      dayNotes.forEach((it) => {
        const datePath = `${this.settings.dir}/${it.date}`;
        const date = this.app.vault.getFolderByPath(datePath);
        if (date == null) {
          this.app.vault.createFolder(datePath);
        }
        it.notes.forEach((itt) => {
          let title = "";
          if (itt.title && itt.title.trim() != "") {
            title = itt.title;
          } else {
            title = itt.createTime;
          }
          this.app.vault.create(`${datePath}/${title}.md`, itt.content);
        });
      });
    }
  }

  onStatusBarClick() {
    const dir = this.app.vault.getFolderByPath(this.settings.dir);
    if (dir == null) {
      this.app.vault.createFolder(this.settings.dir);
    }
    this.fetchData().then(() => {
      new Notice("sync success");
    });
  }

  async onload() {
    await this.loadSettings();
    this.statusBarItemEl = this.addStatusBarItem();
    this.statusBarItemEl.setText("Dinox");
    this.statusBarItemEl.addEventListener(
      "click",
      this.onStatusBarClick.bind(this),
    );

    this.addSettingTab(new DinoSettingTab(this.app, this));

    this.settings.isAutoSync &&
      this.registerInterval(
        window.setInterval(
          () => {
            this.fetchData();
          },
          30 * 60 * 1000,
        ),
      );
  }

  onunload() {}

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
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
    const { containerEl } = this;

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
          }),
      );

    new Setting(containerEl)
      .setName("Dinox token")
      .setDesc("token generated from dinox")
      .addText((text) =>
        text
          .setPlaceholder("Enter Your Dinox Token")
          .setValue(this.plugin.settings.token)
          .onChange(async (value) => {
            console.log(value);
            this.plugin.settings.token = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Allow auto synchronize")
      .setDesc("if allow, this plugin will sync every 30 min")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.isAutoSync)
          .onChange(async (value) => {
            this.plugin.settings.isAutoSync = value;
            await this.plugin.saveSettings();
          }),
      );
  }
}
