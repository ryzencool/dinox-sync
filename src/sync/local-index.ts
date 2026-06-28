import { App, TFile, TFolder, normalizePath, parseYaml } from "obsidian";
import { getNoteIdFromFrontmatter } from "../utils";
import { splitFrontmatter } from "../markdown";

// Yield to the main thread periodically while scanning so a cold-cache index
// build (which reads files from disk) does not freeze the UI on large vaults.
const INDEX_YIELD_EVERY = 50;
function yieldToMain(): Promise<void> {
	return new Promise((resolve) => window.setTimeout(resolve, 0));
}

/**
 * Read a note's frontmatter as an object.
 *
 * Prefers the metadataCache, but falls back to parsing the file from disk when
 * the cache is not populated yet — e.g. a sync triggered right after launch
 * before Obsidian finished indexing. A single source of truth so noteId,
 * ignore_sync and preserveKeys all stay reliable even with a cold cache.
 */
export async function readLocalFrontmatter(
	app: App,
	file: TFile
): Promise<Record<string, unknown> | undefined> {
	const cached = app.metadataCache.getFileCache(file)?.frontmatter;
	if (cached) {
		return cached;
	}
	try {
		const content = await app.vault.cachedRead(file);
		const { frontmatter } = splitFrontmatter(content);
		if (!frontmatter) {
			return undefined;
		}
		const parsed: unknown = parseYaml(frontmatter);
		return parsed &&
			typeof parsed === "object" &&
			!Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: undefined;
	} catch (error) {
		console.warn(
			`Dinox: Failed to read frontmatter from ${file.path}`,
			error
		);
		return undefined;
	}
}

/**
 * Resolve a note's `noteId` (or legacy `source_app_id`) frontmatter value,
 * with the same cold-cache disk fallback as {@link readLocalFrontmatter}.
 * Without this an existing note can go undetected and get re-created as a
 * duplicate.
 */
export async function readNoteIdFromFile(
	app: App,
	file: TFile
): Promise<string | undefined> {
	return getNoteIdFromFrontmatter(await readLocalFrontmatter(app, file));
}

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
	let scannedMarkdownFiles = 0;

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
			const noteId = await readNoteIdFromFile(app, file);
			if (++scannedMarkdownFiles >= INDEX_YIELD_EVERY) {
				scannedMarkdownFiles = 0;
				await yieldToMain();
			}
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
