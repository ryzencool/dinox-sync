import {
	App,
	Notice,
	TFile,
	normalizePath,
} from "obsidian";
import { DEFAULT_SETTINGS } from "./constants";
import type { DayNote, DinoPluginSettings, Note } from "./types";
import {
	DailyNotesUnavailableError,
	type DailyNotesBridge,
	type DailyNoteChangeSet,
} from "./daily-notes";
import {
	extractFrontmatterScalar,
	splitFrontmatter,
} from "./markdown";
import { stripQueryParamsFromImageUrls } from "./markdown-images";
import {
	categorizeDinoxType,
	resolveCategoryBaseDir,
} from "./type-folders";
import { resolveZettelBoxFolderSegment } from "./zettel-box-folders";
import { ensureFolderExists } from "./vault";
import {
	formatDate,
	parseDate,
	sanitizeFilename,
} from "./utils";
import type { TranslationKey, TranslationVars } from "../i18n";

export { buildLocalNoteIdIndex } from "./sync/local-index";

type TFunction = (key: TranslationKey, vars?: TranslationVars) => string;

type NoteProcessingResult =
	| { status: "processed"; notePath: string; title: string; preview?: string }
	| { status: "deleted"; notePath: string }
	| { status: "skipped" };

function getNoteTypeForRouting(noteData: Note): string | null {
	if (typeof noteData.type === "string") {
		return noteData.type;
	}

	// Fallback for API responses that only embed `type` into markdown content via template.
	const split = splitFrontmatter(noteData.content ?? "");
	return extractFrontmatterScalar(split.frontmatter, "type");
}

function addSuffixToMarkdownPath(path: string, suffix: string): string {
	const normalized = normalizePath(path);
	const slashIndex = normalized.lastIndexOf("/");
	const dir = slashIndex === -1 ? "" : normalized.slice(0, slashIndex);
	const filename =
		slashIndex === -1 ? normalized : normalized.slice(slashIndex + 1);

	const lower = filename.toLowerCase();
	const isMarkdown = lower.endsWith(".md");
	const base = isMarkdown ? filename.slice(0, -3) : filename;
	const ext = isMarkdown ? ".md" : "";

	const next = `${base}${suffix}${ext}`;
	return dir ? normalizePath(`${dir}/${next}`) : normalizePath(next);
}

function resolveUniqueNotePath(
	app: App,
	preferredPath: string,
	noteId: string,
	currentPath?: string
): string {
	const normalizedPreferred = normalizePath(preferredPath);
	const normalizedCurrent = currentPath ? normalizePath(currentPath) : null;

	if (normalizedCurrent && normalizedCurrent === normalizedPreferred) {
		return normalizedPreferred;
	}

	const existing = app.vault.getAbstractFileByPath(normalizedPreferred);
	if (
		!existing ||
		(normalizedCurrent &&
			existing instanceof TFile &&
			existing.path === normalizedCurrent)
	) {
		return normalizedPreferred;
	}

	const compactId = noteId.replace(/-/g, "");
	const shortId = (compactId || noteId).slice(0, 8);
	const baseSuffix = shortId ? ` (${shortId})` : " (note)";

	for (let attempt = 0; attempt < 50; attempt++) {
		const suffix =
			attempt === 0 ? baseSuffix : `${baseSuffix}-${attempt + 1}`;
		const candidate = addSuffixToMarkdownPath(normalizedPreferred, suffix);
		const taken = app.vault.getAbstractFileByPath(candidate);
		if (
			!taken ||
			(normalizedCurrent &&
				taken instanceof TFile &&
				taken.path === normalizedCurrent)
		) {
			return candidate;
		}
	}

	return normalizedPreferred;
}

function getDailyNoteEntryTitle(noteData: Note, baseFilename: string): string {
	const rawTitle = noteData.title?.trim();
	if (rawTitle) {
		return rawTitle;
	}
	return baseFilename.replace(/_/g, " ");
}

function buildDailyNotePreview(content: string): string | undefined {
	const raw = content ?? "";
	if (!raw) {
		return undefined;
	}
	const lines = raw.split(/\r?\n/);
	let index = 0;
	if (lines[index]?.trim() === "---") {
		index++;
		while (index < lines.length && lines[index].trim() !== "---") {
			index++;
		}
		if (index < lines.length) {
			index++;
		}
	}
	for (; index < lines.length; index++) {
		const line = lines[index].trim();
		if (!line) {
			continue;
		}
		if (line.startsWith(">")) {
			continue;
		}
		const cleaned = line.replace(/^#+\s*/, "").replace(/[`*_]/g, "");
		if (!cleaned) {
			continue;
		}
		return cleaned.length > 120 ? `${cleaned.slice(0, 117)}...` : cleaned;
	}
	return undefined;
}

async function handleNoteProcessing(args: {
	app: App;
	settings: DinoPluginSettings;
	noteData: Note;
	datePath: string;
	notePathById: Record<string, string>;
	localIndex: Record<string, string>;
}): Promise<NoteProcessingResult> {
	const { app, settings, noteData, datePath, notePathById, localIndex } = args;

	const sourceId = (noteData.noteId ?? "").trim();
	if (!sourceId) {
		throw new Error("Dinox: noteId is missing in API response.");
	}

	const ignoreKey = settings.ignoreSyncKey;

	const preserveKeysSetting = settings.preserveKeys || "";
	const keysToPreserve = preserveKeysSetting
		.split(/[,\n\r]+/)
		.map((k) => k.trim())
		.filter((k) => k !== "" && k !== "noteId" && k !== "source_app_id");

	let baseFilename = "";
	const format = settings.filenameFormat;
	if (format === "noteId") {
		baseFilename = sourceId.replace(/-/g, "_");
	} else if (format === "title") {
		baseFilename =
			noteData.title && noteData.title.trim() !== ""
				? sanitizeFilename(noteData.title)
				: sourceId.replace(/-/g, "_");
	} else if (format === "time") {
		const createDate = parseDate(noteData.createTime);
		if (createDate) {
			baseFilename = sanitizeFilename(formatDate(createDate));
		} else {
			console.warn(
				`Dinox: Invalid createTime "${noteData.createTime}" for filename, note ${sourceId}. Falling back to noteId.`
			);
			baseFilename = sourceId.replace(/-/g, "_");
		}
	} else if (format === "titleDate") {
		const createDate = parseDate(noteData.createTime);
		if (createDate) {
			const titlePart =
				noteData.title && noteData.title.trim() !== ""
					? sanitizeFilename(noteData.title)
					: sourceId.replace(/-/g, "_");
			const year = createDate.getFullYear();
			const month = String(createDate.getMonth() + 1).padStart(2, "0");
			const day = String(createDate.getDate()).padStart(2, "0");
			const dateOnly = `${year}-${month}-${day}`;
			baseFilename = sanitizeFilename(`${titlePart} (${dateOnly})`);
		} else {
			console.warn(
				`Dinox: Invalid createTime "${noteData.createTime}" for filename (titleDate), note ${sourceId}. Falling back to title or noteId.`
			);
			baseFilename =
				noteData.title && noteData.title.trim() !== ""
					? sanitizeFilename(noteData.title)
					: sourceId.replace(/-/g, "_");
		}
	} else if (format === "template") {
		const createDateObj = parseDate(noteData.createTime);
		if (createDateObj) {
			const year = createDateObj.getFullYear();
			const month = String(createDateObj.getMonth() + 1).padStart(2, "0");
			const day = String(createDateObj.getDate()).padStart(2, "0");
			const hours = String(createDateObj.getHours()).padStart(2, "0");
			const minutes = String(createDateObj.getMinutes()).padStart(2, "0");
			const seconds = String(createDateObj.getSeconds()).padStart(2, "0");
			const dateOnly = `${year}-${month}-${day}`;
			const timeShort = `${hours}${minutes}${seconds}`;
			const titlePart =
				noteData.title && noteData.title.trim() !== ""
					? noteData.title
					: sourceId.replace(/-/g, "_");
			const template = settings.filenameTemplate || "{{title}} ({{createDate}})";
			let rendered = template
				.replace(/\{\{\s*title\s*\}\}/g, titlePart)
				.replace(/\{\{\s*createDate\s*\}\}/g, dateOnly)
				.replace(/\{\{\s*createTime\s*\}\}/g, timeShort)
				.replace(/\{\{\s*noteId\s*\}\}/g, sourceId);
			rendered = rendered && rendered.trim() !== "" ? rendered : sourceId;
			baseFilename = sanitizeFilename(rendered);
		} else {
			console.warn(
				`Dinox: Invalid createTime "${noteData.createTime}" for filename template, note ${sourceId}. Falling back to noteId.`
			);
			baseFilename = sourceId.replace(/-/g, "_");
		}
	} else {
		baseFilename = sourceId.replace(/-/g, "_");
	}

	baseFilename = baseFilename || sourceId.replace(/-/g, "_") || "Untitled";
	const desiredPath = normalizePath(`${datePath}/${baseFilename}.md`);

	let existingFile: TFile | null = null;
	const mappedPath = notePathById[sourceId];
	if (mappedPath) {
		const mapped = app.vault.getAbstractFileByPath(mappedPath);
		if (mapped instanceof TFile) {
			existingFile = mapped;
		} else {
			delete notePathById[sourceId];
		}
	}

	if (!existingFile) {
		const indexedPath = localIndex[sourceId];
		if (indexedPath) {
			const indexed = app.vault.getAbstractFileByPath(indexedPath);
			if (indexed instanceof TFile) {
				existingFile = indexed;
				notePathById[sourceId] = indexed.path;
			}
		}
	}

	if (!existingFile) {
		const maybe = app.vault.getAbstractFileByPath(desiredPath);
		if (maybe instanceof TFile) {
			const cache = app.metadataCache.getFileCache(maybe);
			const fmId = cache?.frontmatter?.noteId ?? cache?.frontmatter?.source_app_id;
			if (typeof fmId === "string" && fmId.trim() === sourceId) {
				existingFile = maybe;
				notePathById[sourceId] = maybe.path;
			}
		}
	}

	if (existingFile) {
		notePathById[sourceId] = existingFile.path;
	}

	let propertiesToPreserve: Record<string, unknown> = {};
	if (existingFile) {
		try {
			const cache = app.metadataCache.getFileCache(existingFile);
			const existingFrontmatter = cache?.frontmatter;
			if (existingFrontmatter) {
				if (ignoreKey && existingFrontmatter[ignoreKey] === true) {
					return { status: "skipped" };
				}
				for (const key of keysToPreserve) {
					if (
						Object.prototype.hasOwnProperty.call(
							existingFrontmatter,
							key
						)
					) {
						propertiesToPreserve[key] = existingFrontmatter[key];
					}
				}
			}
		} catch (e) {
			console.warn(
				`Dinox: Failed to read frontmatter for preserving keys from ${existingFile.path}`,
				e
			);
			propertiesToPreserve = {};
		}
	}

	if (noteData.isDel) {
		if (existingFile) {
			await app.fileManager.trashFile(existingFile);
			delete notePathById[sourceId];
			return { status: "deleted", notePath: existingFile.path };
		}
		delete notePathById[sourceId];
		return { status: "skipped" };
	}

	const finalContent = stripQueryParamsFromImageUrls(noteData.content || "").content;

	let targetFile: TFile;
	let finalPath = desiredPath;

	if (existingFile) {
		targetFile = existingFile;
		if (targetFile.path !== desiredPath) {
			const candidate = resolveUniqueNotePath(
				app,
				desiredPath,
				sourceId,
				targetFile.path
			);
			const destination = app.vault.getAbstractFileByPath(candidate);
			if (!destination) {
				const folderIndex = candidate.lastIndexOf("/");
				const folder = folderIndex === -1 ? "" : candidate.slice(0, folderIndex);
				if (folder) {
					await ensureFolderExists(app, folder);
				}
				await app.fileManager.renameFile(targetFile, candidate);
				finalPath = candidate;
			} else {
				finalPath = targetFile.path;
			}
		} else {
			finalPath = targetFile.path;
		}

		await app.vault.modify(targetFile, finalContent);
	} else {
		const uniquePath = resolveUniqueNotePath(app, desiredPath, sourceId);
		const folderIndex = uniquePath.lastIndexOf("/");
		const folder = folderIndex === -1 ? "" : uniquePath.slice(0, folderIndex);
		if (folder) {
			await ensureFolderExists(app, folder);
		}
		targetFile = await app.vault.create(uniquePath, finalContent);
		finalPath = uniquePath;
	}

	notePathById[sourceId] = finalPath;

	if (Object.keys(propertiesToPreserve).length > 0) {
		try {
			await app.fileManager.processFrontMatter(targetFile, (frontmatter) => {
				for (const [key, value] of Object.entries(propertiesToPreserve)) {
					frontmatter[key] = value;
				}
			});
		} catch (frontmatterError) {
			console.warn(
				`Dinox: Failed to reapply preserved properties for ${targetFile.path}`,
				frontmatterError
			);
		}
	}

	return {
		status: "processed",
		notePath: finalPath,
		title: getDailyNoteEntryTitle(noteData, baseFilename),
		preview: buildDailyNotePreview(finalContent),
	};
}

export async function processApiResponse(args: {
	app: App;
	settings: DinoPluginSettings;
	t: TFunction;
	dayNotes: DayNote[];
	baseDir: string;
	notePathById: Record<string, string>;
	localIndex: Record<string, string>;
	dailyNotesBridge: DailyNotesBridge | null;
	onDailyNotesUnavailable: () => void;
}): Promise<{ processed: number; deleted: number }> {
	let processed = 0;
	let deleted = 0;

	const baseDir = normalizePath(args.baseDir);
	const dailyNotesBridge = args.dailyNotesBridge;
	const shouldSyncDailyNotes =
		args.settings.dailyNotes.enabled && !!dailyNotesBridge;

	const dailyNoteChanges = new Map<string, DailyNoteChangeSet>();
	const ensureChangeSet = (date: string): DailyNoteChangeSet => {
		let changeSet = dailyNoteChanges.get(date);
		if (!changeSet) {
			changeSet = { added: [], removed: [] };
			dailyNoteChanges.set(date, changeSet);
		}
		return changeSet;
	};

	const ensuredFolders = new Set<string>();
	const ensureFolderOnce = async (folderPath: string): Promise<void> => {
		const normalized = normalizePath(folderPath);
		if (ensuredFolders.has(normalized)) {
			return;
		}
		ensuredFolders.add(normalized);
		await ensureFolderExists(args.app, normalized);
	};

	for (const dayData of args.dayNotes.reverse()) {
		const safeDate = dayData.date.replace(/[^0-9-]/g, "");
		const wantsNestedLayout =
			args.settings.fileLayout === "nested" && !!safeDate;

		for (const noteData of dayData.notes.reverse()) {
			const typeValue = getNoteTypeForRouting(noteData);
			const categorization = categorizeDinoxType(typeValue);
			if (
				!categorization.isKnown &&
				categorization.normalizedType
			) {
				console.warn(
					`Dinox: Unknown note type "${categorization.normalizedType}" for note ${noteData.noteId}. Defaulting to note folder.`
				);
			}

			const categoryBaseDir = resolveCategoryBaseDir({
				baseDir,
				typeFolders: args.settings.typeFolders,
				category: categorization.category,
			});

			// Ensure the category folder exists so nested date folders can be created under it.
			await ensureFolderOnce(categoryBaseDir);

			const zettelBoxFolder = resolveZettelBoxFolderSegment({
				noteData,
				enabled: args.settings.zettelBoxFolders.enabled,
			});

			const noteBaseDir = zettelBoxFolder
				? normalizePath(`${categoryBaseDir}/${zettelBoxFolder}`)
				: categoryBaseDir;

			if (noteBaseDir !== categoryBaseDir) {
				await ensureFolderOnce(noteBaseDir);
			}

			const datePath = wantsNestedLayout
				? normalizePath(`${noteBaseDir}/${safeDate}`)
				: noteBaseDir;

			if (wantsNestedLayout) {
				await ensureFolderOnce(datePath);
			}

			try {
				const result = await handleNoteProcessing({
					app: args.app,
					settings: args.settings,
					noteData,
					datePath,
					notePathById: args.notePathById,
					localIndex: args.localIndex,
				});
				if (result.status === "deleted") {
					deleted++;
					if (shouldSyncDailyNotes && result.notePath) {
						const changeSet = ensureChangeSet(dayData.date);
						changeSet.removed.push({
							notePath: result.notePath,
							title: noteData.title,
						});
					}
				} else if (result.status === "processed") {
					processed++;
					if (shouldSyncDailyNotes) {
						const changeSet = ensureChangeSet(dayData.date);
						changeSet.added.push({
							notePath: result.notePath,
							title: result.title,
							preview: result.preview,
						});
					}
				}
			} catch (noteError) {
				console.error(
					`Dinox: Failed to process note ${noteData.noteId}:`,
					noteError
				);
				const shortId = noteData.noteId.substring(0, 8);
				new Notice(
					args.t("notice.processNoteFailed", { noteId: shortId }),
					5000
				);
			}
		}
	}

	if (shouldSyncDailyNotes && dailyNoteChanges.size > 0 && dailyNotesBridge) {
		let updatedDailyNotes = 0;
		for (const [date, changeSet] of dailyNoteChanges) {
			try {
				const changed = await dailyNotesBridge.applyChangesForDate(
					date,
					changeSet,
					args.settings.dailyNotes
				);
				if (changed) {
					updatedDailyNotes++;
				}
			} catch (error) {
				if (error instanceof DailyNotesUnavailableError) {
					args.onDailyNotesUnavailable();
				} else {
					console.error(
						`Dinox: Failed to update daily note for ${date}:`,
						error
					);
					new Notice(args.t("notice.dailyNotesUpdateFailed"), 5000);
				}
			}
		}
		if (updatedDailyNotes > 0) {
			new Notice(
				args.t("notice.dailyNotesUpdated", {
					count: updatedDailyNotes,
				})
			);
		}
	}

	return { processed, deleted };
}

export async function ensureBaseDir(app: App, dir: string): Promise<string> {
	const baseDir = normalizePath(dir?.trim() || DEFAULT_SETTINGS.dir);
	await ensureFolderExists(app, baseDir);
	return baseDir;
}
