import { App, Modal, Notice, Plugin, PluginSettingTab, Setting, TFile } from "obsidian";

interface HashtagCompilerSettings {
	outputFolder: string;
	appendMode: boolean;
}

const DEFAULT_SETTINGS: HashtagCompilerSettings = {
	outputFolder: "Compilations",
	appendMode: false,
};

interface MatchEntry {
	text: string;
	path: string;
	created: string;
}

function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function formatDate(ms: number): string {
	const d = new Date(ms);
	const yyyy = d.getFullYear();
	const mm = String(d.getMonth() + 1).padStart(2, "0");
	const dd = String(d.getDate()).padStart(2, "0");
	return `${yyyy}-${mm}-${dd}`;
}

/**
 * Every non-blank line is treated as its own paragraph: `-` list items,
 * numbered items, and plain one-line entries alike, whether or not blank
 * lines separate them from their neighbors. Aegis-style notes put one
 * atomic, taggable thought per line, so lines are never glued together
 * into a combined multi-line entry.
 */
function extractParagraphs(content: string): string[] {
	return content
		.replace(/\r\n/g, "\n")
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export default class HashtagCompilerPlugin extends Plugin {
	settings!: HashtagCompilerSettings;

	async onload() {
		await this.loadSettings();

		this.addCommand({
			id: "compile-paragraphs-by-hashtag",
			name: "Compile paragraphs by hashtag",
			callback: () => {
				new HashtagInputModal(this.app, (tag) => {
					this.compileByHashtag(tag);
				}).open();
			},
		});

		this.addSettingTab(new HashtagCompilerSettingTab(this.app, this));
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	async compileByHashtag(rawTag: string) {
		const tagText = rawTag.trim().replace(/^#/, "");
		if (!tagText) {
			new Notice("Please enter a hashtag.");
			return;
		}

		const folder = (this.settings.outputFolder || DEFAULT_SETTINGS.outputFolder)
			.trim()
			.replace(/^\/+|\/+$/g, "");
		const outputPath = folder ? `${folder}/Compilation of ${tagText}.md` : `Compilation of ${tagText}.md`;

		const regex = new RegExp(`\\B#${escapeRegExp(tagText)}\\b`);

		const files = this.app.vault
			.getMarkdownFiles()
			.filter((f) => !(folder && (f.path === outputPath || f.path.startsWith(folder + "/"))));

		const entries: MatchEntry[] = [];
		for (let i = 0; i < files.length; i++) {
			const file = files[i];
			const content = await this.app.vault.cachedRead(file);
			const paragraphs = extractParagraphs(content);
			for (const paragraph of paragraphs) {
				if (regex.test(paragraph)) {
					entries.push({
						text: paragraph,
						path: file.path,
						created: formatDate(file.stat.ctime),
					});
				}
			}
			if (i % 25 === 0) {
				await sleep(0);
			}
		}

		await this.writeCompilation(tagText, outputPath, folder, entries);
	}

	private async writeCompilation(
		tagText: string,
		outputPath: string,
		folder: string,
		entries: MatchEntry[]
	) {
		if (folder) {
			await this.ensureFolder(folder);
		}

		const body = entries.length
			? entries
					.map((e) => `${e.text}\nSource: [[${e.path}]] • Created: ${e.created}\n`)
					.join("\n")
			: `_No paragraphs found containing #${tagText}._\n`;

		const section = `# Compilation of #${tagText}\n\n${body}`;

		const existing = this.app.vault.getAbstractFileByPath(outputPath);
		if (existing instanceof TFile) {
			if (this.settings.appendMode) {
				const prev = await this.app.vault.read(existing);
				await this.app.vault.modify(existing, `${prev.trimEnd()}\n\n---\n\n${section}`);
			} else {
				await this.app.vault.modify(existing, section);
			}
		} else {
			await this.app.vault.create(outputPath, section);
		}

		new Notice(`Compiled ${entries.length} paragraph(s) into ${outputPath}`);
	}

	private async ensureFolder(path: string) {
		const existing = this.app.vault.getAbstractFileByPath(path);
		if (!existing) {
			try {
				await this.app.vault.createFolder(path);
			} catch (e) {
				// Folder may have been created concurrently; ignore.
			}
		}
	}
}

class HashtagInputModal extends Modal {
	private tag = "";
	private onSubmit: (tag: string) => void;

	constructor(app: App, onSubmit: (tag: string) => void) {
		super(app);
		this.onSubmit = onSubmit;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.createEl("h2", { text: "Compile paragraphs by hashtag" });

		new Setting(contentEl).setName("Hashtag").addText((text) => {
			text.setPlaceholder("#idea or idea").onChange((value) => {
				this.tag = value;
			});
			text.inputEl.addEventListener("keydown", (evt: KeyboardEvent) => {
				if (evt.key === "Enter") {
					evt.preventDefault();
					this.submit();
				}
			});
			text.inputEl.focus();
		});

		new Setting(contentEl).addButton((btn) =>
			btn
				.setButtonText("Compile")
				.setCta()
				.onClick(() => this.submit())
		);
	}

	private submit() {
		this.close();
		this.onSubmit(this.tag);
	}

	onClose() {
		this.contentEl.empty();
	}
}

class HashtagCompilerSettingTab extends PluginSettingTab {
	plugin: HashtagCompilerPlugin;

	constructor(app: App, plugin: HashtagCompilerPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName("Output folder")
			.setDesc("Vault folder where compilation notes are created (created automatically if missing).")
			.addText((text) =>
				text
					.setPlaceholder("Compilations")
					.setValue(this.plugin.settings.outputFolder)
					.onChange(async (value) => {
						this.plugin.settings.outputFolder = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Append instead of overwrite")
			.setDesc(
				"If enabled, running the command again appends a new section to the existing compilation note instead of replacing it."
			)
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.appendMode).onChange(async (value) => {
					this.plugin.settings.appendMode = value;
					await this.plugin.saveSettings();
				})
			);
	}
}
