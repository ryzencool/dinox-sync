import {
	App,
	TFile,
	moment,
	normalizePath,
} from "obsidian";
import type { DailyNotesSettings } from "./types";

export interface DailyNoteEntryPayload {
	notePath: string;
	title?: string;
	preview?: string;
}

export interface DailyNoteChangeSet {
	added: DailyNoteEntryPayload[];
	removed: DailyNoteEntryPayload[];
}

interface CoreDailyNotesOptions {
	format: string;
	folder: string;
	template?: string;
}

interface ManagedEntryRecord {
	target: string;
	title?: string;
	preview?: string;
}

const MANAGED_BLOCK_START = "<!-- DINOX-SYNC:START -->";
const MANAGED_BLOCK_END = "<!-- DINOX-SYNC:END -->";

export class DailyNotesUnavailableError extends Error {
	constructor() {
		super("Daily Notes core plugin is disabled or not loaded.");
		this.name = "DailyNotesUnavailableError";
	}
}

export class DailyNotesBridge {
	constructor(
		private readonly app: App,
		private readonly ensureFolderExists: (path: string) => Promise<void>
	) {}

	async applyChangesForDate(
		dateISO: string,
		changeSet: DailyNoteChangeSet,
		settings: DailyNotesSettings
	): Promise<boolean> {
		if (!settings.enabled) {
			return false;
		}
		const additions = changeSet.added ?? [];
		const removals = changeSet.removed ?? [];
		if (additions.length === 0 && removals.length === 0) {
			return false;
		}

		const options = this.getCoreOptions();
		if (!options) {
			throw new DailyNotesUnavailableError();
		}

		const targetDate = this.coerceDate(dateISO);
		if (!targetDate) {
			return false;
		}

		const dailyNoteFile = await this.resolveDailyNoteFile(
			targetDate,
			options,
			settings
		);
		if (!dailyNoteFile) {
			return false;
		}

		const originalContent = await this.app.vault.read(dailyNoteFile);
		const updatedContent = await this.renderUpdatedContent(
			originalContent,
			additions,
			removals,
			settings
		);

		if (updatedContent === null || updatedContent === originalContent) {
			return false;
		}

		await this.app.vault.modify(dailyNoteFile, updatedContent);
		return true;
	}

	async openDailyNote(
		date: Date,
		settings: DailyNotesSettings
	): Promise<TFile | null> {
		const options = this.getCoreOptions();
		if (!options) {
			throw new DailyNotesUnavailableError();
		}
		const targetDate = moment(date);
		if (!targetDate.isValid()) {
			return null;
		}
		return await this.resolveDailyNoteFile(targetDate, options, settings);
	}

	private getCoreOptions(): CoreDailyNotesOptions | null {
		const dailyNotesPlugin =
			(this.app as any)?.internalPlugins?.getPluginById?.(
				"daily-notes"
			);
		if (!dailyNotesPlugin || !dailyNotesPlugin.enabled) {
			return null;
		}
		const instance = dailyNotesPlugin.instance;
		const options = instance?.options;
		if (!options) {
			return null;
		}
		return {
			format: options.format || "YYYY-MM-DD",
			folder: options.folder || "",
			template: options.template || "",
		};
	}

	private coerceDate(dateISO: string) {
		if (!dateISO) {
			return null;
		}
		const strict = moment(dateISO, ["YYYY-MM-DD", moment.ISO_8601], true);
		if (strict.isValid()) {
			return strict;
		}
		const loose = moment(dateISO);
		return loose.isValid() ? loose : null;
	}

	private async resolveDailyNoteFile(
		date: moment.Moment,
		options: CoreDailyNotesOptions,
		settings: DailyNotesSettings
	): Promise<TFile | null> {
		const folder = options.folder?.trim();
		const format = options.format || "YYYY-MM-DD";
		const filename = `${date.format(format)}.md`;
		const folderPath = folder ? normalizePath(folder) : "";
		const notePath = folderPath
			? normalizePath(`${folderPath}/${filename}`)
			: normalizePath(filename);

		const existing = this.app.vault.getAbstractFileByPath(notePath);
		if (existing instanceof TFile) {
			return existing;
		}
		if (existing) {
			throw new Error(
				`Daily note path ${notePath} exists but is not a file.`
			);
		}
		if (!settings.createIfMissing) {
			return null;
		}

		if (folderPath) {
			await this.ensureFolderExists(folderPath);
		}

		let initialContent = "";
		if (options.template) {
			const templatePath = normalizePath(options.template);
			const templateFile =
				this.app.metadataCache.getFirstLinkpathDest(
					templatePath,
					""
				) ??
				this.app.vault.getAbstractFileByPath(templatePath);
			if (templateFile instanceof TFile) {
				initialContent = await this.app.vault.read(templateFile);
			}
		}

		return await this.app.vault.create(notePath, initialContent);
	}

	private async renderUpdatedContent(
		original: string,
		additions: DailyNoteEntryPayload[],
		removals: DailyNoteEntryPayload[],
		settings: DailyNotesSettings
	): Promise<string | null> {
		const heading = settings.heading?.trim() || "## Dinox Notes";
		const newline = original.includes("\r\n") ? "\r\n" : "\n";
		const lines = original.split(/\r?\n/);
		let managedStartIndex = lines.findIndex(
			(line) => line.trim() === MANAGED_BLOCK_START
		);
		let managedEndIndex = lines.findIndex(
			(line, idx) =>
				idx > managedStartIndex &&
				line.trim() === MANAGED_BLOCK_END
		);

		if (managedStartIndex === -1 || managedEndIndex === -1) {
			// Create managed block at the end.
			if (lines.length === 0 || lines[lines.length - 1].trim() !== "") {
				lines.push("");
			}
			if (heading) {
				lines.push(heading);
			}
			lines.push(MANAGED_BLOCK_START, MANAGED_BLOCK_END, "");
			managedStartIndex = lines.findIndex(
				(line) => line.trim() === MANAGED_BLOCK_START
			);
			managedEndIndex = lines.findIndex(
				(line, idx) =>
					idx > managedStartIndex &&
					line.trim() === MANAGED_BLOCK_END
			);
		} else {
			// Ensure heading exists directly above block
			const headingIndex = managedStartIndex - 1;
			if (
				heading &&
				(headingIndex < 0 ||
					lines[headingIndex].trim() !== heading)
			) {
				lines.splice(managedStartIndex, 0, heading);
				managedStartIndex++;
				managedEndIndex++;
			}
		}

		const managedLines = lines.slice(
			managedStartIndex + 1,
			managedEndIndex
		);
		const existingEntries = this.parseManagedEntries(managedLines);

		const removalTargets = new Set(
			(removals ?? []).map((entry) =>
				this.toLinkTarget(entry.notePath)
			)
		);

		const filteredEntries: ManagedEntryRecord[] = existingEntries.filter(
			(entry) => !removalTargets.has(entry.target)
		);

		const insertPosition = settings.insertTo ?? "bottom";
		(additions ?? []).forEach((entry) => {
			const target = this.toLinkTarget(entry.notePath);
			if (!target) {
				return;
			}
			const displayTitle =
				entry.title?.trim() || this.getDefaultTitle(target);
			const preview =
				settings.includePreview && entry.preview
					? this.normalizePreview(entry.preview)
					: undefined;

			const existingIndex = filteredEntries.findIndex(
				(existing) => existing.target === target
			);
			if (existingIndex !== -1) {
				const existing = filteredEntries[existingIndex];
				filteredEntries[existingIndex] = {
					target,
					title: displayTitle || existing.title,
					preview: preview ?? existing.preview,
				};
				return;
			}

			const prepared: ManagedEntryRecord = {
				target,
				title: displayTitle,
				preview,
			};
			if (insertPosition === "top") {
				filteredEntries.unshift(prepared);
			} else {
				filteredEntries.push(prepared);
			}
		});

		const newManagedLines = filteredEntries.flatMap((entry) =>
			this.renderManagedEntry(entry, settings.linkStyle)
		);

		lines.splice(
			managedStartIndex + 1,
			managedEndIndex - managedStartIndex - 1,
			...newManagedLines
		);

		let updated = lines.join(newline);
		if (!updated.endsWith(newline)) {
			updated += newline;
		}

		return updated === original ? null : updated;
	}

	private parseManagedEntries(lines: string[]): ManagedEntryRecord[] {
		const entries: ManagedEntryRecord[] = [];
		for (let i = 0; i < lines.length; i++) {
			const raw = lines[i];
			const trimmed = raw.trim();
			if (!trimmed) {
				continue;
			}

			const withoutBullet = trimmed.startsWith("- ")
				? trimmed.slice(2).trimStart()
				: trimmed;

			const match = withoutBullet.match(
				/!?\[\[([^\]|#^>]+)(?:\|([^\]]+))?\]\]/
			);
			if (!match) {
				continue;
			}

			const target = match[1]?.trim();
			if (!target) {
				continue;
			}

			let preview: string | undefined;
			const nextLine = lines[i + 1];
			if (nextLine && nextLine.trim().startsWith(">")) {
				preview = nextLine.trim().replace(/^>\s?/, "");
				i++;
			}

			entries.push({
				target,
				title: match[2]?.trim(),
				preview,
			});
		}
		return entries;
	}

	private renderManagedEntry(
		entry: ManagedEntryRecord,
		style: DailyNotesSettings["linkStyle"]
	): string[] {
		const target = entry.target;
		if (style === "embed") {
			return [`![[${target}]]`];
		}

		const alias = entry.title?.trim();
		const link = alias && alias !== this.getDefaultTitle(target)
			? `[[${target}|${alias}]]`
			: `[[${target}]]`;

		const lines = [`- ${link}`];
		if (entry.preview) {
			lines.push(`  > ${entry.preview}`);
		}
		return lines;
	}

	private toLinkTarget(notePath: string): string {
		if (!notePath) {
			return "";
		}
		const normalized = normalizePath(notePath);
		return normalized.replace(/\.md$/i, "");
	}

	private getDefaultTitle(target: string): string {
		const segments = target.split("/");
		return segments[segments.length - 1] || target;
	}

	private normalizePreview(preview: string): string {
		const singleLine = preview.replace(/\s+/g, " ").trim();
		const limit = 120;
		if (singleLine.length <= limit) {
			return singleLine;
		}
		return `${singleLine.slice(0, limit - 3)}...`;
	}
}
