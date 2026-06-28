import { normalizePath, TFolder, type App } from "obsidian";

export async function ensureFolderExists(
	app: App,
	folderPath: string
): Promise<void> {
	const normalizedPath = normalizePath(folderPath);
	if (!normalizedPath || normalizedPath === "/" || normalizedPath === ".") {
		return;
	}

	// Create each ancestor in order so multi-level paths (e.g. nested zettel
	// box folders) work even if vault.createFolder is not recursive.
	const segments = normalizedPath.split("/").filter(Boolean);
	let current = "";
	for (const segment of segments) {
		current = current ? `${current}/${segment}` : segment;

		const node = app.vault.getAbstractFileByPath(current);
		if (node) {
			if (!(node instanceof TFolder)) {
				throw new Error(
					`Sync path "${current}" exists but is not a folder.`
				);
			}
			continue;
		}

		try {
			await app.vault.createFolder(current);
		} catch (error) {
			// Tolerate races and "already exists" so concurrent ensures are safe.
			if (
				error instanceof Error &&
				/exists/i.test(error.message)
			) {
				continue;
			}
			console.error(
				`Dinox: Error ensuring folder "${current}" exists:`,
				error
			);
			throw error;
		}
	}
}

