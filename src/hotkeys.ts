import type { Modifier } from "obsidian";
import type { DinoHotkeyMap, DinoHotkeySetting } from "./types";

export const VALID_MODIFIERS: Modifier[] = [
	"Mod",
	"Ctrl",
	"Meta",
	"Shift",
	"Alt",
];

export const MODIFIER_ORDER: Modifier[] = [
	"Mod",
	"Ctrl",
	"Meta",
	"Shift",
	"Alt",
];

export function normalizeKeyValue(key: string): string {
	if (!key) return "";
	if (key === "Esc") return "Escape";
	if (key === "Space") return " ";
	if (key.length === 1) return key.toUpperCase();
	return key;
}

export function createEmptyHotkey(): DinoHotkeySetting {
	return { modifiers: [], key: "" };
}

export function createDefaultHotkeys(): DinoHotkeyMap {
	return {
		syncAll: createEmptyHotkey(),
		syncCurrentNote: createEmptyHotkey(),
		createNote: createEmptyHotkey(),
	};
}

export function sanitizeHotkeySetting(
	setting?: DinoHotkeySetting | null
): DinoHotkeySetting {
	if (!setting) {
		return createEmptyHotkey();
	}

	const keyValue = typeof setting.key === "string"
		? normalizeKeyValue(setting.key)
		: "";

	const rawModifiers = Array.isArray(setting.modifiers)
		? setting.modifiers
		: [];

	const deduped = new Set<Modifier>();
	for (const maybeModifier of rawModifiers) {
		if (
			typeof maybeModifier === "string" &&
			(VALID_MODIFIERS as string[]).includes(maybeModifier) &&
			!deduped.has(maybeModifier as Modifier)
		) {
			deduped.add(maybeModifier as Modifier);
		}
	}

	const modifiers = Array.from(deduped).sort(
		(a, b) => MODIFIER_ORDER.indexOf(a) - MODIFIER_ORDER.indexOf(b)
	);

	return { key: keyValue, modifiers };
}

export function cloneHotkeyMap(
	map?: Partial<DinoHotkeyMap>
): DinoHotkeyMap {
	return {
		syncAll: sanitizeHotkeySetting(map?.syncAll),
		syncCurrentNote: sanitizeHotkeySetting(map?.syncCurrentNote),
		createNote: sanitizeHotkeySetting(map?.createNote),
	};
}
