import { App, TFile } from "obsidian";
import type { DinoPluginSettings, ZettelBoxNode } from "../types";
import { readLocalFrontmatter } from "./local-index";

/**
 * Fingerprint of what decides which notes sync and where each file lands.
 * When it changes, an incremental pull would leave existing files in the old
 * scope or folders, so the caller runs a full pass instead. Template edits are
 * deliberately excluded: they only change file content, not membership.
 */
export function computeLayoutSignature(
	settings: DinoPluginSettings,
	boxes: ZettelBoxNode[] | null
): string {
	return JSON.stringify({
		dir: settings.dir,
		fileLayout: settings.fileLayout,
		filenameFormat: settings.filenameFormat,
		filenameTemplate: settings.filenameTemplate,
		typeFolders: settings.typeFolders,
		zettelBoxFolders: settings.zettelBoxFolders.enabled,
		scope: settings.syncScope.enabled
			? [...settings.syncScope.selectedBoxIds].sort()
			: null,
		// Box names/paths drive folders; parent links drive scope expansion.
		boxes: boxes
			?.map((box) => [box.id, box.parentId, box.name, box.path])
			.sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
	});
}

/**
 * After a complete (non-incremental) pull, the synced files whose notes were
 * not returned have left the scope or were deleted while unseen. Only files
 * this plugin synced (tracked in notePathById) qualify, and files marked with
 * the ignore key are kept.
 */
export async function findUnreturnedSyncedFiles(args: {
	app: App;
	ignoreKey: string;
	notePathById: Record<string, string>;
	returnedIds: Set<string>;
}): Promise<Array<{ noteId: string; file: TFile }>> {
	const { app, ignoreKey, notePathById, returnedIds } = args;
	const stale: Array<{ noteId: string; file: TFile }> = [];
	for (const [noteId, path] of Object.entries(notePathById)) {
		if (returnedIds.has(noteId)) {
			continue;
		}
		const file = app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) {
			delete notePathById[noteId];
			continue;
		}
		if (ignoreKey) {
			const frontmatter = await readLocalFrontmatter(app, file);
			if (frontmatter?.[ignoreKey] === true) {
				continue;
			}
		}
		stale.push({ noteId, file });
	}
	return stale;
}
