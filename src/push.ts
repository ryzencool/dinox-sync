import { App, Editor, Notice, TFile } from "obsidian";
import { createDinoxNote, DinoxLogicError, updateDinoxNote } from "./api";
import {
	extractAllTagsFromMarkdown,
	extractFrontmatterScalar,
	splitFrontmatter,
} from "./markdown";
import { getErrorMessage } from "./utils";
import type { TranslationKey, TranslationVars } from "../i18n";

type TFunction = (key: TranslationKey, vars?: TranslationVars) => string;

export async function sendSelectionToDinox(args: {
	token: string;
	t: TFunction;
	content: string;
}): Promise<void> {
	if (!args.token) {
		new Notice(args.t("notice.tokenMissing"));
		return;
	}

	new Notice(args.t("notice.selectionSending"));
	try {
		const title =
			args.content.split("\n")[0].substring(0, 50) ||
			"New Note from Obsidian";
		await createDinoxNote({
			token: args.token,
			content: args.content,
			tags: [],
			title,
		});
		new Notice(args.t("notice.selectionSent"));
	} catch (error) {
		if (error instanceof DinoxLogicError) {
			new Notice(
				args.t("notice.selectionSendFailed", {
					message: error.apiMessage || args.t("common.unknownError"),
				})
			);
			return;
		}

		console.error("Dinox: Error sending content:", error);
		new Notice(args.t("notice.selectionSendError", { error: getErrorMessage(error) }));
	}
}

export async function addNoteIdToFrontmatter(args: {
	app: App;
	t: TFunction;
	file: TFile;
	noteId: string;
}): Promise<void> {
	try {
		await args.app.fileManager.processFrontMatter(args.file, (frontmatter) => {
			frontmatter.noteId = args.noteId;
		});
	} catch (error) {
		console.error("Dinox: Error adding noteId to frontmatter:", error);
		new Notice(
			args.t("notice.frontmatterError", {
				error: getErrorMessage(error),
			})
		);
	}
}

export async function createNoteToDinox(args: {
	app: App;
	token: string;
	t: TFunction;
	editor: Editor;
	file: TFile;
}): Promise<void> {
	if (!args.token) {
		new Notice(args.t("notice.tokenMissing"));
		return;
	}

	new Notice(args.t("notice.creatingNote"));

	const editorContent = args.editor.getValue();
	const split = splitFrontmatter(editorContent);
	const existingNoteId =
		extractFrontmatterScalar(split.frontmatter, "noteId") ??
		extractFrontmatterScalar(split.frontmatter, "source_app_id");

	if (existingNoteId) {
		new Notice(args.t("notice.createAlreadyHasId"));
		return;
	}

	const contentToCreate = split.body;
	const title =
		extractFrontmatterScalar(split.frontmatter, "title") ||
		args.file.basename ||
		"New Note from Obsidian";
	const allTags = extractAllTagsFromMarkdown(editorContent);

	try {
		const createdNoteId = await createDinoxNote({
			token: args.token,
			content: contentToCreate,
			tags: allTags,
			title,
		});

		await addNoteIdToFrontmatter({
			app: args.app,
			t: args.t,
			file: args.file,
			noteId: createdNoteId,
		});

		new Notice(
			args.t("notice.createSuccess", {
				noteId: createdNoteId.substring(0, 8),
			})
		);
	} catch (error) {
		if (error instanceof DinoxLogicError) {
			new Notice(
				args.t("notice.createFailed", {
					message: error.apiMessage || args.t("common.unknownError"),
				})
			);
			return;
		}

		console.error("Dinox: Error creating note:", error);
		new Notice(args.t("notice.createError", { error: getErrorMessage(error) }));
	}
}

export async function syncNoteToDinox(args: {
	app: App;
	token: string;
	t: TFunction;
	editor: Editor;
	file: TFile;
}): Promise<void> {
	if (!args.token) {
		new Notice(args.t("notice.tokenMissing"));
		return;
	}

	new Notice(args.t("notice.syncingNote"));

	const editorContent = args.editor.getValue();
	const split = splitFrontmatter(editorContent);
	const noteId =
		extractFrontmatterScalar(split.frontmatter, "noteId") ??
		extractFrontmatterScalar(split.frontmatter, "source_app_id") ??
		(() => {
			const cache = args.app.metadataCache.getFileCache(args.file);
			const fm = cache?.frontmatter;
			const raw = fm?.noteId ?? fm?.source_app_id;
			return typeof raw === "string" ? raw : null;
		})();

	if (!noteId) {
		new Notice(args.t("notice.syncNoId"));
		return;
	}

	const contentToSync = split.body;
	const allTags = extractAllTagsFromMarkdown(editorContent);
	const title =
		extractFrontmatterScalar(split.frontmatter, "title") ||
		args.file.basename ||
		"Untitled";

	try {
		await updateDinoxNote({
			token: args.token,
			noteId,
			contentMd: contentToSync,
			tags: allTags,
			title,
		});

		new Notice(
			args.t("notice.syncNoteSuccess", {
				noteId: noteId.substring(0, 8),
			})
		);
	} catch (error) {
		if (error instanceof DinoxLogicError) {
			new Notice(
				args.t("notice.syncNoteFailed", {
					message: error.apiMessage || args.t("common.unknownError"),
				})
			);
			return;
		}

		console.error("Dinox: Error syncing note:", error);
		new Notice(args.t("notice.syncNoteError", { error: getErrorMessage(error) }));
	}
}
