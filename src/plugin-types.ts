import type { Plugin } from "obsidian";
import type {
	DinoPluginSettings,
	DinoHotkeySetting,
	DinoCommandKey,
} from "./types";
import type { TranslationKey, TranslationVars } from "../i18n";

type MaybePromise<T> = T | Promise<T>;

export interface DinoPluginAPI extends Plugin {
	settings: DinoPluginSettings;
	defaults: Readonly<DinoPluginSettings>;
	saveSettings(): Promise<void>;
	cancelHotkeyCapture(restoreLabel: boolean): void;
	refreshLocale(): void;
	refreshAutoSyncSchedule(): void;
	getHotkeyDisplay(commandKey: DinoCommandKey): string;
	applyHotkeySetting(
		commandKey: DinoCommandKey,
		setting: DinoHotkeySetting | null
	): Promise<boolean>;
	beginHotkeyCapture(
		commandKey: DinoCommandKey,
		displayEl: HTMLElement,
		onResolve: (setting: DinoHotkeySetting) => MaybePromise<void>,
		onClear: () => MaybePromise<void>
	): void;
	t(key: TranslationKey, vars?: TranslationVars): string;
}
