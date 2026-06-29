import * as Mustache from "mustache";
import type { Note, ZettelBoxRef } from "./types";
import { normalizeDinoxDateTime } from "./utils";

// Notes are markdown, not HTML — Mustache's default HTML escaping would corrupt
// content (e.g. `&` -> `&amp;`). Render everything verbatim instead.
const NO_ESCAPE = (value: unknown): string => String(value ?? "");

interface NoteTemplateContext {
	title: string;
	noteId: string;
	type: string;
	tags: string[];
	zettelBoxes: string[];
	audioUrl: string;
	createTime: string;
	updateTime: string;
	content: string;
}

function zettelBoxLabels(
	boxes: Array<string | ZettelBoxRef> | undefined
): string[] {
	if (!Array.isArray(boxes)) {
		return [];
	}
	const labels: string[] = [];
	for (const box of boxes) {
		if (typeof box === "string") {
			const trimmed = box.trim();
			if (trimmed) {
				labels.push(trimmed);
			}
			continue;
		}
		// Prefer the full hierarchical path; fall back to the leaf name.
		const path = typeof box?.path === "string" ? box.path.trim() : "";
		const name = typeof box?.name === "string" ? box.name.trim() : "";
		const label = path || name;
		if (label) {
			labels.push(label);
		}
	}
	return labels;
}

function buildContext(note: Note): NoteTemplateContext {
	return {
		title: note.title ?? "",
		noteId: note.noteId ?? "",
		type: typeof note.type === "string" ? note.type : "",
		tags: Array.isArray(note.tags) ? note.tags : [],
		zettelBoxes: zettelBoxLabels(note.zettelBoxes),
		audioUrl: note.audioUrl ?? "",
		// Keep the frontmatter timestamps in the plugin's stable local format so
		// downstream parsing (filename formats, etc.) reads them back correctly.
		createTime:
			normalizeDinoxDateTime(note.createTime) ?? note.createTime ?? "",
		updateTime:
			normalizeDinoxDateTime(note.updateTime) ?? note.updateTime ?? "",
		content: note.content ?? "",
	};
}

/**
 * Validate a Mustache template without needing note data.
 *
 * `Mustache.parse` compiles (and caches) the template, throwing on syntax
 * errors such as unclosed or mismatched sections. Returns the error message
 * when invalid, or null when the template is well-formed.
 */
export function validateTemplate(template: string): string | null {
	try {
		Mustache.parse(template);
		return null;
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}

/**
 * Render a note into its final markdown using the user's Mustache template.
 *
 * This used to happen server-side; moving it to the client lets the API return
 * compact, structured data and keeps presentation under the user's control.
 */
export function renderNoteTemplate(template: string, note: Note): string {
	const context = buildContext(note);
	try {
		return Mustache.render(template, context, undefined, {
			escape: NO_ESCAPE,
		});
	} catch (error) {
		console.error(
			`Dinox: Failed to render template for note ${note.noteId}:`,
			error
		);
		// Fall back to raw content so a broken template never drops the note body.
		return context.content;
	}
}
