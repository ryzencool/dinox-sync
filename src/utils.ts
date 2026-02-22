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

function isValidDateParts(
	year: number,
	month: number,
	day: number,
	hours: number,
	minutes: number,
	seconds: number
): boolean {
	if (!Number.isInteger(year) || year < 0 || year > 9999) return false;
	if (!Number.isInteger(month) || month < 1 || month > 12) return false;
	if (!Number.isInteger(day) || day < 1 || day > 31) return false;
	if (!Number.isInteger(hours) || hours < 0 || hours > 23) return false;
	if (!Number.isInteger(minutes) || minutes < 0 || minutes > 59) return false;
	if (!Number.isInteger(seconds) || seconds < 0 || seconds > 59) return false;
	return true;
}

export function parseLocalDateTime(value: string): Date | null {
	const trimmed = value.trim();
	const match = trimmed.match(
		/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/
	);
	if (!match) {
		return null;
	}

	const year = Number(match[1]);
	const month = Number(match[2]);
	const day = Number(match[3]);
	const hours = Number(match[4]);
	const minutes = Number(match[5]);
	const seconds = Number(match[6]);

	if (!isValidDateParts(year, month, day, hours, minutes, seconds)) {
		return null;
	}

	// Construct in local time and verify to avoid Date auto-rollover (e.g. Feb 31).
	const date = new Date(year, month - 1, day, hours, minutes, seconds, 0);
	if (
		Number.isNaN(date.getTime()) ||
		date.getFullYear() !== year ||
		date.getMonth() !== month - 1 ||
		date.getDate() !== day ||
		date.getHours() !== hours ||
		date.getMinutes() !== minutes ||
		date.getSeconds() !== seconds
	) {
		return null;
	}
	return date;
}

export function parseDate(value: unknown): Date | null {
	if (typeof value !== "string") {
		return null;
	}
	const trimmed = value.trim();
	if (!trimmed) {
		return null;
	}

	const local = parseLocalDateTime(trimmed);
	if (local) {
		return local;
	}

	// ISO 8601 and other browser-supported formats (only used as a fallback).
	const parsed = new Date(trimmed);
	return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function normalizeDinoxDateTime(
	value: unknown
): string | null {
	const parsed = parseDate(value);
	if (!parsed) {
		return null;
	}
	return formatDate(parsed);
}

export function sanitizeFilename(name: string): string {
	if (!name) return "Untitled";
	let sanitized = name.replace(/[\\/:*?"<>|#^[\]]/g, "-");
	sanitized = sanitized.replace(/[\s-]+/g, "-");
	sanitized = sanitized.trim().replace(/^-+|-+$/g, "");
	sanitized = sanitized.substring(0, 100);
	if (sanitized === "." || sanitized === "..") return "Untitled";
	return sanitized || "Untitled";
}

function isWindowsReservedDeviceName(value: string): boolean {
	const trimmed = value.trim().replace(/[. ]+$/g, "");
	if (!trimmed) {
		return false;
	}
	const upper = trimmed.toUpperCase();
	const base = upper.split(".")[0] ?? upper;
	if (base === "CON" || base === "PRN" || base === "AUX" || base === "NUL") {
		return true;
	}
	return /^(COM|LPT)[1-9]$/.test(base);
}

export function sanitizeFolderSegment(value: string): string | null {
	const raw = value?.trim();
	if (!raw) {
		return null;
	}

	// Keep this a single path segment: replace slashes so "a/b" cannot create nested folders.
	let sanitized = raw.replace(/[\\/]/g, "-");
	// Strip control chars + common filesystem-invalid characters (Windows).
	sanitized = sanitized.replace(/[\u0000-\u001F<>:"|?*]/g, "-");
	// Collapse whitespace/dashes for a stable, readable folder name.
	sanitized = sanitized.replace(/\s+/g, " ");
	sanitized = sanitized.replace(/-+/g, "-");
	// Trim leading/trailing characters that commonly break folder creation on Windows.
	sanitized = sanitized.replace(/^[ .-]+|[ .-]+$/g, "");
	sanitized = sanitized.replace(/[. ]+$/g, "");
	sanitized = sanitized.trim();

	if (!sanitized || sanitized === "." || sanitized === "..") {
		return null;
	}

	sanitized = sanitized.slice(0, 80).trim().replace(/[. ]+$/g, "");
	if (!sanitized || sanitized === "." || sanitized === "..") {
		return null;
	}

	if (isWindowsReservedDeviceName(sanitized)) {
		sanitized = `${sanitized}-box`;
	}

	return sanitized;
}
