import { App, Modal, Setting } from "obsidian";

export class ConfirmModal extends Modal {
	private readonly message: string;
	private readonly onConfirm: () => void | Promise<void>;
	private readonly onDismiss?: () => void;
	private confirmed = false;

	constructor(
		app: App,
		message: string,
		onConfirm: () => void | Promise<void>,
		onDismiss?: () => void
	) {
		super(app);
		this.message = message;
		this.onConfirm = onConfirm;
		this.onDismiss = onDismiss;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl("p", { text: this.message });
		new Setting(contentEl)
			.addButton((btn) =>
				btn
					.setButtonText("Confirm")
					.setWarning()
					.onClick(() => {
						this.confirmed = true;
						this.close();
						void this.onConfirm();
					})
			)
			.addButton((btn) =>
				btn.setButtonText("Cancel").onClick(() => this.close())
			);
	}

	onClose(): void {
		this.contentEl.empty();
		if (!this.confirmed) {
			this.onDismiss?.();
		}
	}
}

/** Resolves true on Confirm, false on Cancel or when the modal is dismissed. */
export function confirmAsync(app: App, message: string): Promise<boolean> {
	return new Promise((resolve) => {
		new ConfirmModal(app, message, () => resolve(true), () => resolve(false)).open();
	});
}
