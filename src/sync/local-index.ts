import { App, TFile, TFolder, normalizePath } from "obsidian";
import { getNoteIdFromFrontmatter } from "../utils";

export async function buildLocalNoteIdIndex(
	app: App,
	baseDir: string
): Promise<Record<string, string>> {
	const normalizedBaseDir = normalizePath(baseDir);
	const baseFolder = app.vault.getAbstractFileByPath(normalizedBaseDir);
	if (!(baseFolder instanceof TFolder)) {
		return {};
	}

	const index: Record<string, string> = {};
	const duplicates = new Map<string, string[]>();

	// Avoid scanning the entire vault on every sync (large vaults can be slow).
	const stack: TFolder[] = [baseFolder];
	while (stack.length > 0) {
		const folder = stack.pop();
		if (!folder) {
			continue;
		}
		for (const child of folder.children) {
			if (child instanceof TFolder) {
				stack.push(child);
				continue;
			}
			if (!(child instanceof TFile)) {
				continue;
			}
			if (child.extension.toLowerCase() !== "md") {
				continue;
			}

			const file = child;
			const cache = app.metadataCache.getFileCache(file);
			const noteId = getNoteIdFromFrontmatter(cache?.frontmatter);
			if (!noteId) {
				continue;
			}
			const existingPath = index[noteId];
			if (existingPath && existingPath !== file.path) {
				const list = duplicates.get(noteId) ?? [existingPath];
				list.push(file.path);
				duplicates.set(noteId, list);
				continue;
			}

			index[noteId] = file.path;
		}
	}

	if (duplicates.size > 0) {
		const sample = Array.from(duplicates.entries()).slice(0, 5);
		console.warn(
			"Dinox: Duplicate local files detected for some noteIds:",
			sample
		);
	}

	return index;
}

