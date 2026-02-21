import { requestUrl } from "obsidian";
import { API_BASE_URL, API_BASE_URL_AI } from "./constants";
import type { DayNote } from "./types";

type JsonRecord = Record<string, unknown>;

function isJsonRecord(value: unknown): value is JsonRecord {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function truncate(text: string, limit: number): string {
	const raw = text ?? "";
	if (raw.length <= limit) {
		return raw;
	}
	return raw.slice(0, limit);
}

export class DinoxHttpError extends Error {
	readonly status: number;
	readonly bodyPreview: string;

	constructor(status: number, bodyPreview: string) {
		super(`API HTTP Error: Status ${status}\n${bodyPreview}`);
		this.name = "DinoxHttpError";
		this.status = status;
		this.bodyPreview = bodyPreview;
	}
}

export class DinoxLogicError extends Error {
	readonly code: string;
	readonly apiMessage: string;

	constructor(code: string, apiMessage: string) {
		super(`API Logic Error: Code ${code}\n${apiMessage}`);
		this.name = "DinoxLogicError";
		this.code = code;
		this.apiMessage = apiMessage;
	}
}

export class DinoxInvalidResponseError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "DinoxInvalidResponseError";
	}
}

interface DinoxEnvelope<T> {
	code: string;
	msg?: string;
	data?: T;
}

async function postJson(args: {
	url: string;
	token: string;
	body: unknown;
}): Promise<{ status: number; json: unknown; text: string }> {
	const resp = await requestUrl({
		url: args.url,
		method: "POST",
		headers: {
			Authorization: args.token,
			"Content-Type": "application/json",
		},
		body: JSON.stringify(args.body),
		throw: false,
	});
	return { status: resp.status, json: resp.json, text: resp.text };
}

function parseEnvelope<T>(value: unknown): DinoxEnvelope<T> {
	if (!isJsonRecord(value)) {
		throw new DinoxInvalidResponseError(
			"Dinox: Invalid API response: expected an object."
		);
	}
	if (typeof value.code !== "string") {
		throw new DinoxInvalidResponseError(
			"Dinox: Invalid API response: missing code."
		);
	}
	const msg = typeof value.msg === "string" ? value.msg : undefined;
	return {
		code: value.code,
		msg,
		data: value.data as T,
	};
}

function assertSuccess(envelope: DinoxEnvelope<unknown>): void {
	if (envelope.code !== "000000") {
		throw new DinoxLogicError(
			envelope.code,
			envelope.msg || "Unknown API error structure"
		);
	}
}

export async function fetchNotesFromApi(args: {
	token: string;
	template: string;
	lastSyncTime: string;
}): Promise<DayNote[]> {
	const { status, json, text } = await postJson({
		url: `${API_BASE_URL}/openapi/v5/notes`,
		token: args.token,
		body: {
			template: args.template,
			noteId: 0,
			lastSyncTime: args.lastSyncTime,
		},
	});

	if (status !== 200) {
		throw new DinoxHttpError(status, truncate(text, 200));
	}

	const envelope = parseEnvelope<unknown>(json);
	assertSuccess(envelope);

	const data = envelope.data;
	if (data === undefined || data === null) {
		return [];
	}
	if (!Array.isArray(data)) {
		throw new DinoxInvalidResponseError(
			"Dinox: Invalid API response: data is not an array."
		);
	}

	const dayNotes: DayNote[] = [];
	for (const item of data) {
		if (!isJsonRecord(item)) {
			continue;
		}
		const date = typeof item.date === "string" ? item.date : "";
		const notes = Array.isArray(item.notes) ? item.notes : [];
		if (!date) {
			continue;
		}
		dayNotes.push({ date, notes: notes as DayNote["notes"] });
	}
	return dayNotes;
}

export async function createDinoxNote(args: {
	token: string;
	content: string;
	title: string;
	tags: string[];
}): Promise<string> {
	const { status, json, text } = await postJson({
		url: `${API_BASE_URL_AI}/api/openapi/createNote`,
		token: args.token,
		body: {
			content: args.content,
			tags: args.tags,
			title: args.title,
		},
	});

	if (status !== 200) {
		throw new DinoxHttpError(status, truncate(text, 200));
	}

	const envelope = parseEnvelope<unknown>(json);
	assertSuccess(envelope);

	const data = envelope.data;
	if (!isJsonRecord(data)) {
		throw new DinoxInvalidResponseError(
			"Dinox: Invalid API response: createNote data is missing."
		);
	}
	const noteId = data.noteId;
	if (typeof noteId !== "string" || !noteId.trim()) {
		throw new DinoxInvalidResponseError(
			"Dinox: Invalid API response: createNote noteId is missing."
		);
	}
	return noteId.trim();
}

export async function updateDinoxNote(args: {
	token: string;
	noteId: string;
	contentMd: string;
	title: string;
	tags: string[];
}): Promise<void> {
	const { status, json, text } = await postJson({
		url: `${API_BASE_URL_AI}/api/openapi/updateNote`,
		token: args.token,
		body: {
			noteId: args.noteId,
			contentMd: args.contentMd,
			tags: args.tags,
			title: args.title,
		},
	});

	if (status !== 200) {
		throw new DinoxHttpError(status, truncate(text, 200));
	}

	const envelope = parseEnvelope<unknown>(json);
	assertSuccess(envelope);
}

