import {
	App,
	Editor,
	MarkdownView,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	TFile,
	normalizePath,
} from "obsidian";

interface GlossaryRefractionSettings {
	glossaryFolder: string;
	defaultStatus: string;
}

const DEFAULT_SETTINGS: GlossaryRefractionSettings = {
	glossaryFolder: "glossary",
	defaultStatus: "draft",
};

const HEADING_LEVELS = [2, 3];

interface HeadingSection {
	level: number;
	headingText: string;
	body: string;
}

/** Strips block-reference IDs (^abc123), Pandoc-style {#id} attributes, and inline #tags. */
function stripHashesAndIds(text: string): string {
	let cleaned = text;
	cleaned = cleaned.replace(/\s*\^[a-zA-Z0-9-]+\s*$/gm, "");
	cleaned = cleaned.replace(/\s*\{#[^}]+\}\s*$/gm, "");
	cleaned = cleaned.replace(/(^|\s)#[^\s#]+/g, "$1");
	cleaned = cleaned.replace(/#/g, "");
	return cleaned;
}

function cleanHeadingText(raw: string): string {
	return stripHashesAndIds(raw).replace(/\s+/g, " ").trim();
}

function cleanNoteSummary(raw: string): string {
	const cleaned = stripHashesAndIds(raw);
	return cleaned
		.split(/\n{2,}/)
		.map((paragraph) => paragraph.replace(/[ \t]+/g, " ").split("\n").map((l) => l.trim()).join("\n").trim())
		.filter((paragraph) => paragraph.length > 0)
		.join("\n\n")
		.trim();
}

function extractHeadingSections(content: string, levels: number[]): HeadingSection[] {
	const lines = content.split(/\r?\n/);
	const headingRegex = /^(#{1,6})\s+(.*)$/;
	const sections: HeadingSection[] = [];

	let current: HeadingSection | null = null;
	let bodyLines: string[] = [];

	const pushCurrent = () => {
		if (current) {
			current.body = bodyLines.join("\n").trim();
			sections.push(current);
		}
	};

	for (const line of lines) {
		const match = line.match(headingRegex);
		if (match) {
			pushCurrent();
			current = null;
			bodyLines = [];

			const level = match[1].length;
			if (levels.includes(level)) {
				const headingText = cleanHeadingText(match[2]);
				if (headingText.length > 0) {
					current = { level, headingText, body: "" };
				}
			}
		} else if (current) {
			bodyLines.push(line);
		}
	}
	pushCurrent();

	return sections;
}

/** Sanitises a heading into a safe Obsidian file name. */
function sanitizeFileName(name: string): string {
	return name
		.replace(/[\\/:*?"<>|[\]#^]/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

/** Produces a double-quoted YAML scalar, escaping backslashes, quotes and newlines. */
function yamlQuote(value: string): string {
	const escaped = value
		.replace(/\\/g, "\\\\")
		.replace(/"/g, '\\"')
		.replace(/\r?\n/g, "\\n");
	return `"${escaped}"`;
}

function buildNoteContent(opts: {
	title: string;
	sourceFileName: string;
	noteSummary: string;
	status: string;
}): string {
	return `---
title: ${yamlQuote(opts.title)}
aliases:
tags:
  - Glossary
Subjects:
Projects:
Status: ${opts.status}
Sources: "[[${opts.sourceFileName}]]"
Links:
Note_Summary: ${yamlQuote(opts.noteSummary)}
---

# ${opts.title}

${opts.noteSummary}
`;
}

export default class GlossaryRefractionPlugin extends Plugin {
	settings: GlossaryRefractionSettings;

	async onload() {
		await this.loadSettings();

		this.addCommand({
			id: "create-glossary-notes",
			name: "Create glossary notes from document or selection",
			editorCallback: (editor: Editor, view: MarkdownView) => {
				this.runGlossaryRefraction(editor, view);
			},
		});

		this.addSettingTab(new GlossaryRefractionSettingTab(this.app, this));
	}

	onunload() {}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	private async runGlossaryRefraction(editor: Editor, view: MarkdownView) {
		const sourceFile = view.file;
		if (!sourceFile) {
			new Notice("Glossary Refraction: no active file to analyse.");
			return;
		}

		const selection = editor.getSelection();
		const content = selection.trim().length > 0 ? selection : editor.getValue();

		const sections = extractHeadingSections(content, HEADING_LEVELS);
		if (sections.length === 0) {
			new Notice("Glossary Refraction: no H2 or H3 headings found to extract.");
			return;
		}

		const folderPath = normalizePath(this.settings.glossaryFolder || DEFAULT_SETTINGS.glossaryFolder);
		await this.ensureFolder(folderPath);

		let created = 0;
		for (const section of sections) {
			const ok = await this.createGlossaryNote(section, folderPath, sourceFile);
			if (ok) created++;
		}

		new Notice(`Glossary Refraction: created ${created} of ${sections.length} glossary note(s).`);
	}

	private async ensureFolder(folderPath: string) {
		const existing = this.app.vault.getAbstractFileByPath(folderPath);
		if (!existing) {
			await this.app.vault.createFolder(folderPath);
		}
	}

	private async createGlossaryNote(
		section: HeadingSection,
		folderPath: string,
		sourceFile: TFile
	): Promise<boolean> {
		const baseName = sanitizeFileName(section.headingText);
		if (baseName.length === 0) {
			return false;
		}

		const filePath = await this.getAvailablePath(folderPath, baseName);
		const noteSummary = cleanNoteSummary(section.body);
		const sourceFileName = sourceFile.basename;

		const noteContent = buildNoteContent({
			title: section.headingText,
			sourceFileName,
			noteSummary,
			status: this.settings.defaultStatus || DEFAULT_SETTINGS.defaultStatus,
		});

		await this.app.vault.create(filePath, noteContent);
		return true;
	}

	private async getAvailablePath(folderPath: string, baseName: string): Promise<string> {
		let candidate = normalizePath(`${folderPath}/${baseName}.md`);
		let suffix = 1;
		while (this.app.vault.getAbstractFileByPath(candidate)) {
			candidate = normalizePath(`${folderPath}/${baseName} ${suffix}.md`);
			suffix++;
		}
		return candidate;
	}
}

class GlossaryRefractionSettingTab extends PluginSettingTab {
	plugin: GlossaryRefractionPlugin;

	constructor(app: App, plugin: GlossaryRefractionPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName("Glossary folder")
			.setDesc("Notes created by Glossary Refraction are filed into this folder, created if missing.")
			.addText((text) =>
				text
					.setPlaceholder(DEFAULT_SETTINGS.glossaryFolder)
					.setValue(this.plugin.settings.glossaryFolder)
					.onChange(async (value) => {
						this.plugin.settings.glossaryFolder = value.trim() || DEFAULT_SETTINGS.glossaryFolder;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Default status")
			.setDesc("Value written to the Status field of each new glossary note.")
			.addText((text) =>
				text
					.setPlaceholder(DEFAULT_SETTINGS.defaultStatus)
					.setValue(this.plugin.settings.defaultStatus)
					.onChange(async (value) => {
						this.plugin.settings.defaultStatus = value.trim() || DEFAULT_SETTINGS.defaultStatus;
						await this.plugin.saveSettings();
					})
			);
	}
}
