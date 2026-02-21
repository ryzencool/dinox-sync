import { normalizePath, TFolder, type App } from "obsidian";

export async function ensureFolderExists(
	app: App,
	folderPath: string
): Promise<void> {
	const normalizedPath = normalizePath(folderPath);
	try {
		const abstractFile =
			app.vault.getAbstractFileByPath(normalizedPath);
		if (abstractFile) {
			if (!(abstractFile instanceof TFolder)) {
				throw new Error(
					`Sync path "${normalizedPath}" exists but is not a folder.`
				);
			}
			return;
		}

		await app.vault.createFolder(normalizedPath);
	} catch (error) {
		if (
			error instanceof Error &&
			/error\s+exists/i.test(error.message)
		) {
			return;
		}
		console.error(
			`Dinox: Error ensuring folder "${normalizedPath}" exists:`,
			error
		);
		throw error;
	}
}

