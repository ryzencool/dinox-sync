export function getErrorMessage(error: unknown): string {
	if (error instanceof Error && typeof error.message === "string") {
		return error.message;
	}
	try {
		return JSON.stringify(error);
	} catch {
		return String(error);
	}
}

export function formatDate(date: Date): string {
	const year = date.getFullYear();
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	const hours = String(date.getHours()).padStart(2, "0");
	const minutes = String(date.getMinutes()).padStart(2, "0");
	const seconds = String(date.getSeconds()).padStart(2, "0");
	return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

export function sanitizeFilename(name: string): string {
	if (!name) return "Untitled";
	let sanitized = name.replace(/[\\/:*?"<>|#^\[\]]/g, "-");
	sanitized = sanitized.replace(/[\s-]+/g, "-");
	sanitized = sanitized.trim().replace(/^-+|-+$/g, "");
	sanitized = sanitized.substring(0, 100);
	if (sanitized === "." || sanitized === "..") return "Untitled";
	return sanitized || "Untitled";
}
