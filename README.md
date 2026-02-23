# Dinox Sync Plugin

[中文文档](#中文文档) | [English](#english)

---

# 中文文档

将 [Dinox](https://dinoai.chatgo.pro) 笔记同步到 Obsidian，也可以将 Obsidian 笔记推送到 Dinox。

## 快速开始

1. 在 Obsidian 的 **设置 > 第三方插件** 中安装并启用本插件
2. 打开插件设置，填入你在 Dinox 应用中获取的 **Token**
3. 点击底部状态栏的 **Dinox** 按钮，即可开始同步

就这么简单！笔记会被保存到 `Dinox Sync` 文件夹中。

---

## 核心功能

### 从 Dinox 同步到 Obsidian（拉取）

每次同步只会拉取**上次同步之后有变动的笔记**，不会重复下载全部内容。

**触发方式：**

- 点击底部状态栏的 `Dinox` 按钮
- 打开命令面板（`Ctrl/Cmd + P`），搜索「Synchronize Dinox notes now」
- 开启自动同步后，每 30 分钟自动拉取一次

### 从 Obsidian 推送到 Dinox（推送）

你也可以把本地笔记推送到 Dinox：

| 操作 | 说明 |
|---|---|
| **推送当前笔记** | 将当前打开的笔记更新到 Dinox（需要笔记 frontmatter 中有 `noteId`） |
| **创建为 Dinox 笔记** | 将当前笔记作为新笔记创建到 Dinox（适用于没有 `noteId` 的笔记） |
| **发送选中文字** | 在编辑器中选中一段文字，右键选择「Send to Dinox」，会以选中内容创建一条新笔记 |

推送和创建也可以通过**右键菜单**或**命令面板**操作。

---

## 文件夹结构

同步后的笔记会按照你的设置，放入不同层级的文件夹中。每一层都是可选的：

```
Dinox Sync/                        ← 同步目录（可自定义）
 └── note/                         ← 按类型分组（可关闭）
      └── 我的卡片盒/                ← ��卡片盒分组（可关闭）
           └── 2024-03-15/          ← 按日期嵌套（可选择平铺）
                └── 我的笔记.md
```

下面分别介绍每一层的设置。

### 同步目录

所有同步的笔记存放在这个文件夹下。

- **设置项：** 同步目录
- **默认值：** `Dinox Sync`
- 你可以改成任何你喜欢的名字，比如 `笔记/Dinox`

### 按类型分组

Dinox 中的笔记分为两种类型：**笔记**（自己写的）和**素材**（网页剪藏的）。开启后，两种类型会分到不同的子文件夹。

- **设置项：** 启用按类型分组
- **默认：** 开启
- **笔记文件夹：** 默认名为 `note`，可自定义
- **素材文件夹：** 默认名为 `material`，可自定义

> **注意：** 如果你开启了按类型分组，请确保内容模板中包含 `{{type}}`，否则插件无法区分笔记和素材。

### 按卡片盒分组

如果你在 Dinox 中使用了「卡片盒」来整理笔记，开启此选项后，笔记会按卡片盒名称再分到对应的子文件夹中。没有分配卡片盒的笔记不受影响，直接留在上一级目录。

- **设置项：** 按卡片盒分组
- **默认：** 关闭

### 文件布局

控制笔记是否按日期再分一层子文件夹。

| 选项 | 效果 |
|---|---|
| **嵌套（默认）** | 笔记按创建日期分到 `YYYY-MM-DD` 子文件夹中 |
| **平铺** | 所有笔记直接放在同一文件夹下，不按日期分层 |

---

## 文件命名

你可以选择文件名的生成方式：

| 选项 | 文件名示例 |
|---|---|
| **Note ID（默认）** | `550e8400_e29b_41d4_a716.md` |
| **笔记标题** | `我的读书笔记.md` |
| **创建时间** | `2024-03-15 143022.md` |
| **标题 + 日期** | `我的读书笔记 (2024-03-15).md` |
| **自定义模板** | 按你定义的模板生成（见下方） |

### 自定义文件名模板

选择「自定义模板」后，你可以用以下变量拼出想要的文件名：

| 变量 | 含义 |
|---|---|
| `{{title}}` | 笔记标题 |
| `{{createDate}}` | 创建日期，格式为 `YYYY-MM-DD` |
| `{{createTime}}` | 创建时间，格式为 `HHmmss` |
| `{{noteId}}` | Dinox 笔记 ID |

**示例：** 模板 `{{title}} ({{createDate}})` 生成 `我的笔记 (2024-03-15).md`

---

## 内容模板

内容模板决定了从 Dinox 拉取的笔记最终在 Obsidian 中呈现的格式，包括 frontmatter 和正文内容。

默认模板：

```yaml
---
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
```

你可以根据需要自由修改这个模板。模板采用 Mustache 语法，`{{#tags}}...{{/tags}}` 表示循环渲染每个标签。

---

## 日记集成

开启后，每次同步会自动在对应日期的**日记**中添加当天同步笔记的链接。需要 Obsidian 核心插件「日记」处于启用状态。

| 设置项 | 说明 | 默认值 |
|---|---|---|
| 启用日记集成 | 总开关 | 关闭 |
| 标题 | Dinox 区块使用的 Markdown 标题 | `## Dinox Notes` |
| 插入位置 | 新条目插入到顶部还是底部 | 底部 |
| 链接样式 | 使用 Wiki 链接 `[[笔记]]` 还是嵌入 `![[笔记]]` | Wiki 链接 |
| 显示预览 | 在链接下方显示笔记正文的第一行摘要 | 关闭 |
| 自动创建日记 | 当日期对应的日记不存在时，是否自动创建 | 开启 |

---

## 保护本地修改

### 忽略同步

如果你在本地修改了某篇同步笔记，不希望它被下次同步覆盖，可以在该笔记的 frontmatter 中添加：

```yaml
ignore_sync: true
```

这样插件在同步时会跳过这篇笔记。属性名可以在设置中自定义（默认为 `ignore_sync`）。

### 保留属性

如果你在同步笔记上手动添加了一些 frontmatter 属性（比如 `status`、`aliases`、`project`），希望同步更新时保留这些属性不被覆盖，可以在设置中的「保留属性」填入这些属性名，用逗号或换行分隔。

**示例：** 填入 `status, aliases, project`，这三个属性在同步更新时会从旧文件中保留。

---

## 快捷键

你可以在插件设置的「快捷键」区域为以下操作设置自定义快捷键：

| 操作 | 说明 |
|---|---|
| 手动同步 | 触发一次完整同步 |
| 推送当前笔记 | 将当前笔记更新到 Dinox |
| 创建笔记到 Dinox | 将当前笔记作为新笔记创建到 Dinox |

点击「设置」按钮后按下你想要的快捷键组合即可绑定。

---

## 重置同步

如果你想重新拉取所有笔记（比如修改了模板或文件夹设置），可以在设置最下方的「重置同步状态」区域选择时间范围后点击重置。下次同步时会重新拉取该时间段之后的所有笔记。

| 选项 | 效果 |
|---|---|
| 昨天 | 重新拉取最近 1 天的笔记 |
| 3 天前 | 重新拉取最近 3 天的笔记 |
| 1 周前 | 重新拉取最近 1 周的笔记 |
| 1 个月前 | 重新拉取最近 1 个月的笔记 |
| 全部 | 重新拉取所有笔记 |

---

## 自动同步

开启后，插件会每 30 分钟自动同步一次，不需要手动操作。

- **设置项：** 启用自动同步
- **默认：** 关闭

---

## 命令一览

在 Obsidian 命令面板（`Ctrl/Cmd + P`）中可以找到以下命令：

| 命令 | 说明 |
|---|---|
| Synchronize Dinox notes now | 立即拉取最新笔记 |
| Sync current note to Dinox | 将当前笔记推送到 Dinox |
| Create current note in Dinox | 在 Dinox 中创建当前笔记 |
| Reset Dinox sync | 重置同步时间 |
| Open today's Dinox daily note | 打开今天的日记 |

---

## 支持

如果遇到问题或有建议，请到 [GitHub Issues](https://github.com/nicepkg/dinox-sync/issues) 反馈，或发送邮件到 zmyjust@gmail.com。

---

# English

Sync notes between [Dinox](https://dinoai.chatgo.pro) and your Obsidian vault. Pull notes from Dinox into Obsidian, and push local notes back to Dinox.

## Getting Started

1. Install and enable this plugin from **Settings > Community plugins**
2. Open the plugin settings and enter the **Token** from the Dinox app
3. Click the **Dinox** button in the status bar to start syncing

That's it! Notes will be saved to the `Dinox Sync` folder by default.

---

## Core Features

### Pull from Dinox to Obsidian

Each sync only fetches **notes that changed since the last sync** — no redundant downloads.

**How to trigger:**

- Click the `Dinox` button in the bottom status bar
- Open the command palette (`Ctrl/Cmd + P`) and search for "Synchronize Dinox notes now"
- Enable auto sync to pull automatically every 30 minutes

### Push from Obsidian to Dinox

You can also push local notes to Dinox:

| Action | Description |
|---|---|
| **Sync current note** | Update the current note in Dinox (requires `noteId` in frontmatter) |
| **Create in Dinox** | Create a new Dinox note from the current file (for notes without `noteId`) |
| **Send selection** | Select text in the editor, right-click "Send to Dinox" to create a note from the selection |

All actions are also available via the **right-click menu** and **command palette**.

---

## Folder Structure

Synced notes are organized into folders based on your settings. Each layer is optional:

```
Dinox Sync/                        ← Sync directory (customizable)
 └── note/                         ← Type-based grouping (can be disabled)
      └── My Zettel Box/           ← Zettel box grouping (can be disabled)
           └── 2024-03-15/          ← Date nesting (can use flat layout)
                └── My Note.md
```

### Sync Directory

The root folder for all synced notes.

- **Setting:** Sync directory
- **Default:** `Dinox Sync`
- You can change it to any name you like, e.g. `Notes/Dinox`

### Type-Based Folders

Dinox notes come in two types: **notes** (written by you) and **materials** (web clippings). When enabled, each type gets its own subfolder.

- **Setting:** Split by type
- **Default:** Enabled
- **Note folder:** Default `note`, customizable
- **Material folder:** Default `material`, customizable

> **Note:** If you enable type-based folders, make sure your content template includes `{{type}}`. Otherwise the plugin cannot distinguish notes from materials.

### Zettel Box Folders

If you use zettel boxes in Dinox to organize notes, enabling this option creates subfolders named after each zettel box. Notes without a zettel box stay in the parent folder.

- **Setting:** Group by zettel box
- **Default:** Disabled

### File Layout

Controls whether notes are further grouped by date.

| Option | Result |
|---|---|
| **Nested (default)** | Notes go into `YYYY-MM-DD` subfolders by creation date |
| **Flat** | All notes stay in the same folder, no date grouping |

---

## File Naming

Choose how filenames are generated:

| Option | Example |
|---|---|
| **Note ID (default)** | `550e8400_e29b_41d4_a716.md` |
| **Note title** | `My Reading Notes.md` |
| **Creation time** | `2024-03-15 143022.md` |
| **Title + date** | `My Reading Notes (2024-03-15).md` |
| **Custom template** | Build your own format (see below) |

### Custom Filename Template

When using "Custom template", these variables are available:

| Variable | Meaning |
|---|---|
| `{{title}}` | Note title |
| `{{createDate}}` | Creation date (`YYYY-MM-DD`) |
| `{{createTime}}` | Creation time (`HHmmss`) |
| `{{noteId}}` | Dinox note ID |

**Example:** Template `{{title}} ({{createDate}})` produces `My Note (2024-03-15).md`

---

## Content Template

The content template controls how notes from Dinox are formatted in Obsidian, including frontmatter and body content.

Default template:

```yaml
---
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
```

You can customize this template freely. It uses Mustache syntax — `{{#tags}}...{{/tags}}` loops over each tag.

---

## Daily Notes Integration

When enabled, each sync automatically adds links to synced notes in the corresponding **daily note**. Requires the Obsidian core "Daily notes" plugin to be active.

| Setting | Description | Default |
|---|---|---|
| Enable daily note integration | Master switch | Disabled |
| Section heading | Markdown heading for the Dinox section | `## Dinox Notes` |
| Insert position | Add new entries to top or bottom | Bottom |
| Link style | Use wiki links `[[Note]]` or embeds `![[Note]]` | Wiki links |
| Show preview | Display a one-line summary under each link | Disabled |
| Create note if missing | Auto-create the daily note if it doesn't exist | Enabled |

---

## Protecting Local Changes

### Ignore Sync

If you've edited a synced note locally and want to prevent the next sync from overwriting it, add this to the note's frontmatter:

```yaml
ignore_sync: true
```

The plugin will skip this note during sync. The property name is customizable in settings (default: `ignore_sync`).

### Preserve Properties

If you've added custom frontmatter properties to synced notes (like `status`, `aliases`, `project`) and want them to survive sync updates, list them in the "Preserve property keys" setting, separated by commas or newlines.

**Example:** Enter `status, aliases, project` — these three properties will be carried over when the note is updated by sync.

---

## Hotkeys

You can set custom hotkeys for the following actions in the plugin settings under "Hotkeys":

| Action | Description |
|---|---|
| Manual sync | Trigger a full sync |
| Sync current note | Push the current note to Dinox |
| Create note in Dinox | Create the current note in Dinox |

Click "Set", then press your desired key combination to bind it.

---

## Reset Sync

If you want to re-fetch notes (e.g., after changing the template or folder settings), use the "Reset sync state" option at the bottom of the settings. Choose a time range and click reset. The next sync will re-fetch all notes from that point onward.

| Option | Effect |
|---|---|
| Yesterday | Re-fetch the last 1 day |
| 3 days ago | Re-fetch the last 3 days |
| 1 week ago | Re-fetch the last 7 days |
| 1 month ago | Re-fetch the last 30 days |
| Beginning of time | Re-fetch all notes |

---

## Auto Sync

When enabled, the plugin automatically syncs every 30 minutes.

- **Setting:** Enable auto sync
- **Default:** Disabled

---

## Commands

Available in the Obsidian command palette (`Ctrl/Cmd + P`):

| Command | Description |
|---|---|
| Synchronize Dinox notes now | Pull the latest notes from Dinox |
| Sync current note to Dinox | Push the current note to Dinox |
| Create current note in Dinox | Create the current note in Dinox |
| Reset Dinox sync | Reset the sync timestamp |
| Open today's Dinox daily note | Open today's daily note |

---

## Support

If you encounter issues or have suggestions, please open an issue on [GitHub](https://github.com/nicepkg/dinox-sync/issues) or email zmyjust@gmail.com.

## License

This plugin is licensed under the [MIT License](LICENSE).
