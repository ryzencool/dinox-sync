import { requestUrl, type RequestUrlResponse } from "obsidian";
import {
	API_BASE_URL_AI,
	SYNC_REQUEST_TIMEOUT_MS,
} from "./constants";
import type {
	Note,
	NotesSyncPage,
	ZettelBoxNode,
	ZettelBoxRef,
} from "./types";

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

// Obsidian's requestUrl cannot be aborted, but racing a timeout still unblocks
// the sync loop on flaky mobile networks instead of hanging indefinitely.
function requestWithTimeout(
	params: Parameters<typeof requestUrl>[0],
	timeoutMs: number
): Promise<RequestUrlResponse> {
	let timer: number | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = window.setTimeout(
			() => reject(new Error(`Request timed out after ${timeoutMs}ms`)),
			timeoutMs
		);
	});
	return Promise.race([requestUrl(params), timeout]).finally(() => {
		if (timer !== undefined) {
			window.clearTimeout(timer);
		}
	});
}

// Returns the raw response so callers read `.json` only on success and `.text`
// only on error — accessing both would materialize the whole payload twice,
// a real OOM risk on mobile for large responses.
async function postJson(args: {
	url: string;
	token: string;
	body: unknown;
	timeoutMs?: number;
}): Promise<{ status: number; resp: RequestUrlResponse }> {
	const resp = await requestWithTimeout(
		{
			url: args.url,
			method: "POST",
			headers: {
				Authorization: args.token,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(args.body),
			throw: false,
		},
		args.timeoutMs ?? SYNC_REQUEST_TIMEOUT_MS
	);
	return { status: resp.status, resp };
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

function asString(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function asStringArray(value: unknown): string[] {
	if (!Array.isArray(value)) {
		return [];
	}
	return value
		.map((item) => (typeof item === "string" ? item : String(item ?? "")))
		.filter((item) => item.length > 0);
}

function mapZettelBoxes(value: unknown): Array<string | ZettelBoxRef> {
	if (!Array.isArray(value)) {
		return [];
	}
	const boxes: Array<string | ZettelBoxRef> = [];
	for (const entry of value) {
		if (typeof entry === "string") {
			boxes.push(entry);
		} else if (isJsonRecord(entry)) {
			boxes.push({
				id: typeof entry.id === "string" ? entry.id : undefined,
				name: typeof entry.name === "string" ? entry.name : undefined,
				path: typeof entry.path === "string" ? entry.path : undefined,
			});
		}
	}
	return boxes;
}

function mapNote(raw: unknown): Note | null {
	if (!isJsonRecord(raw)) {
		return null;
	}
	const noteId = asString(raw.noteId);
	if (!noteId) {
		return null;
	}
	return {
		noteId,
		title: asString(raw.title),
		content: asString(raw.contentMd),
		type: asString(raw.type) || undefined,
		tags: asStringArray(raw.tags),
		zettelBoxes: mapZettelBoxes(raw.zettelBoxes),
		audioUrl: asString(raw.audioUrl),
		isAudio: raw.isAudio === true,
		isDel: raw.isDel === true,
		createTime: asString(raw.createdAt),
		updateTime: asString(raw.updatedAt),
	};
}

/**
 * Fetch one page of incrementally-changed notes via keyset pagination.
 * `since` is an unambiguous ISO-8601 timestamp (the prior sync high-water mark)
 * or null on a first/full sync.
 */
export async function fetchNotesPage(args: {
	token: string;
	since: string | null;
	cursor: string | null;
	limit: number;
	includeDeleted: boolean;
	boxIds: string[] | null;
}): Promise<NotesSyncPage> {
	const { status, resp } = await postJson({
		url: `${API_BASE_URL_AI}/api/openapi/notes/sync`,
		token: args.token,
		body: {
			since: args.since,
			cursor: args.cursor,
			limit: args.limit,
			includeDeleted: args.includeDeleted,
			// null => no box filter; array => only these boxes + descendants.
			boxIds: args.boxIds,
		},
	});

	if (status !== 200) {
		throw new DinoxHttpError(status, truncate(resp.text, 200));
	}

	const envelope = parseEnvelope<unknown>(resp.json);
	assertSuccess(envelope);

	const data = envelope.data;
	if (!isJsonRecord(data)) {
		throw new DinoxInvalidResponseError(
			"Dinox: Invalid API response: sync data is missing."
		);
	}
	if (!Array.isArray(data.notes)) {
		throw new DinoxInvalidResponseError(
			"Dinox: Invalid API response: notes is not an array."
		);
	}

	const notes: Note[] = [];
	for (const item of data.notes) {
		const note = mapNote(item);
		if (note) {
			notes.push(note);
		}
	}

	return {
		notes,
		nextCursor:
			typeof data.nextCursor === "string" && data.nextCursor
				? data.nextCursor
				: null,
		hasMore: data.hasMore === true,
		serverTime:
			typeof data.serverTime === "string" ? data.serverTime : undefined,
	};
}

function mapZettelBoxNode(raw: unknown): ZettelBoxNode | null {
	if (!isJsonRecord(raw)) {
		return null;
	}
	const id = asString(raw.id);
	if (!id) {
		return null;
	}
	const priority =
		typeof raw.priority === "number" && Number.isFinite(raw.priority)
			? raw.priority
			: 0;
	return {
		id,
		name: asString(raw.name) || id,
		parentId: typeof raw.parentId === "string" ? raw.parentId : null,
		path: typeof raw.path === "string" ? raw.path : null,
		priority,
	};
}

/** Fetch the user's full card-box list (for the settings tree). */
export async function fetchZettelBoxes(
	token: string
): Promise<ZettelBoxNode[]> {
	const resp = await requestWithTimeout(
		{
			url: `${API_BASE_URL_AI}/api/openapi/zettelboxes`,
			method: "GET",
			headers: { Authorization: token },
			throw: false,
		},
		SYNC_REQUEST_TIMEOUT_MS
	);

	if (resp.status !== 200) {
		throw new DinoxHttpError(resp.status, truncate(resp.text, 200));
	}

	const envelope = parseEnvelope<unknown>(resp.json);
	assertSuccess(envelope);

	if (!Array.isArray(envelope.data)) {
		return [];
	}
	const boxes: ZettelBoxNode[] = [];
	for (const item of envelope.data) {
		const box = mapZettelBoxNode(item);
		if (box) {
			boxes.push(box);
		}
	}
	return boxes;
}

export async function createDinoxNote(args: {
	token: string;
	content: string;
	title: string;
	tags: string[];
}): Promise<string> {
	const { status, resp } = await postJson({
		url: `${API_BASE_URL_AI}/api/openapi/createNote`,
		token: args.token,
		body: {
			content: args.content,
			tags: args.tags,
			title: args.title,
		},
	});

	if (status !== 200) {
		throw new DinoxHttpError(status, truncate(resp.text, 200));
	}

	const envelope = parseEnvelope<unknown>(resp.json);
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
	const { status, resp } = await postJson({
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
		throw new DinoxHttpError(status, truncate(resp.text, 200));
	}

	const envelope = parseEnvelope<unknown>(resp.json);
	assertSuccess(envelope);
}

