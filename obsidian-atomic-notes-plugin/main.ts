import {
	App,
	Editor,
	MarkdownView,
	normalizePath,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	TFile,
} from "obsidian";

interface AtomicNoteSettings {
	/** Folder the new note is created in. Empty string = vault root. Filing it
	 * anywhere else is left to the user via the "move file" dialog below. */
	folderPath: string;
	/** Automatically invoke Obsidian's core "move file" command right after
	 * creating the note, so the user can file it manually. */
	openMoveDialogAfterCreate: boolean;
	/** Template used to build every new atomic note. Supports the
	 * placeholders {{title}}, {{content}}, {{link}} and {{date}}. */
	template: string;
}

const DEFAULT_TEMPLATE = `---
Title: {{title}}
aliases:
tags: #atomicnote
Subjects:
Projects:
Status:
Sources:
Links: {{link}}
cssclasses:
Note_Summary:
heading-indent: True
---

{{content}}


------
`;

const DEFAULT_SETTINGS: AtomicNoteSettings = {
	folderPath: "",
	openMoveDialogAfterCreate: true,
	template: DEFAULT_TEMPLATE,
};

/** Matches a level-2 or level-3 ATX heading line, e.g. "## Some title" or
 * "### Some title ###". Captures the heading text without the # markers. */
const HEADING_REGEX = /^\s{0,3}(#{2,3})(?!#)\s+(.+?)\s*#*\s*$/;

const ILLEGAL_FILENAME_CHARS = /[\\/:*?"<>|#]/g;

export default class AtomicNotesPlugin extends Plugin {
	settings: AtomicNoteSettings;

	async onload() {
		await this.loadSettings();

		this.addCommand({
			id: "create-atomic-note",
			name: "Make new atomic note",
			editorCallback: (editor: Editor, view: MarkdownView) =>
				this.createAtomicNote(editor, view),
		});

		this.addSettingTab(new AtomicNotesSettingTab(this.app, this));
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	async createAtomicNote(editor: Editor, view: MarkdownView) {
		const sourceFile = view.file;
		if (!sourceFile) {
			new Notice("Atomic notes: no active file to capture from.");
			return;
		}

		const selection = editor.getSelection();
		const hasSelection = selection.trim().length > 0;
		const content = hasSelection ? selection : this.getSurroundingBlock(editor);

		if (!content.trim()) {
			new Notice("Atomic notes: nothing to capture (empty selection/paragraph).");
			return;
		}

		const title = this.deriveTitle(content);
		const link = `[[${sourceFile.basename}]]`;
		const body = this.applyTemplate(title, content.trim(), link);

		const folder = this.settings.folderPath
			? normalizePath(this.settings.folderPath)
			: "";
		const desiredPath = normalizePath(
			folder ? `${folder}/${title}.md` : `${title}.md`
		);
		const finalPath = await this.getAvailablePath(desiredPath);

		let newFile: TFile;
		try {
			newFile = await this.app.vault.create(finalPath, body);
		} catch (error) {
			console.error("Atomic notes: failed to create note", error);
			new Notice("Atomic notes: could not create the new note (see console).");
			return;
		}

		// Original note (and the cursor/selection within it) is left untouched.
		const rightLeaf = this.app.workspace.getLeaf("split", "vertical");
		await rightLeaf.openFile(newFile, { active: true });
		this.app.workspace.setActiveLeaf(rightLeaf, { focus: true });

		if (this.settings.openMoveDialogAfterCreate) {
			// Let the new leaf finish becoming active before invoking the
			// core "move file" command, so it targets the new note.
			window.setTimeout(() => {
				const commands = (this.app as any).commands;
				if (commands?.commands?.["file-explorer:move-file"]) {
					commands.executeCommandById("file-explorer:move-file");
				}
			}, 50);
		}
	}

	/** Reads from the nearest blank line above the cursor to the nearest
	 * blank line below it, i.e. the paragraph/block the cursor sits in. */
	getSurroundingBlock(editor: Editor): string {
		const cursor = editor.getCursor();
		const lastLine = editor.lastLine();

		let startLine = cursor.line;
		while (startLine > 0 && editor.getLine(startLine - 1).trim() !== "") {
			startLine--;
		}

		let endLine = cursor.line;
		while (endLine < lastLine && editor.getLine(endLine + 1).trim() !== "") {
			endLine++;
		}

		const lines: string[] = [];
		for (let i = startLine; i <= endLine; i++) {
			lines.push(editor.getLine(i));
		}
		return lines.join("\n");
	}

	/** Uses the first H2/H3 heading found in the captured text as the title
	 * (with the # markers stripped); otherwise falls back to a
	 * YYYYMMDDHHmmss timestamp. */
	deriveTitle(content: string): string {
		for (const line of content.split("\n")) {
			const match = line.match(HEADING_REGEX);
			if (match) {
				const heading = this.sanitizeFileName(match[2].trim());
				if (heading) return heading;
			}
		}
		return this.formatTimestamp();
	}

	formatTimestamp(): string {
		const now = new Date();
		const pad = (n: number) => n.toString().padStart(2, "0");
		return (
			`${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
			`${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
		);
	}

	sanitizeFileName(name: string): string {
		return name.replace(ILLEGAL_FILENAME_CHARS, "").trim();
	}

	/** Wraps a YAML frontmatter value in quotes when needed so it stays
	 * valid YAML. Wikilinks (which start with "[[") must always be quoted:
	 * unquoted, the leading "[" is YAML flow-sequence syntax, so
	 * "Links: [[Note]]" silently parses as a nested array instead of the
	 * literal string "[[Note]]" - and Obsidian can no longer recognize or
	 * render it as a link. */
	yamlSafeValue(value: string): string {
		if (/^\[\[/.test(value) || /[:#{}\[\],&*!|>'"%@`]/.test(value) || /^\s|\s$/.test(value)) {
			return `"${value.replace(/"/g, '\\"')}"`;
		}
		return value;
	}

	applyTemplate(title: string, content: string, link: string): string {
		return this.settings.template
			.replace(/{{\s*title\s*}}/g, this.yamlSafeValue(title))
			.replace(/{{\s*content\s*}}/g, content)
			.replace(/{{\s*link\s*}}/g, this.yamlSafeValue(link))
			.replace(/{{\s*date\s*}}/g, this.formatTimestamp());
	}

	/** Appends " 1", " 2", etc. if a file already exists at this path. */
	async getAvailablePath(path: string): Promise<string> {
		if (!(await this.app.vault.adapter.exists(path))) return path;

		const lastSlash = path.lastIndexOf("/");
		const dir = lastSlash >= 0 ? path.slice(0, lastSlash) : "";
		const fileName = lastSlash >= 0 ? path.slice(lastSlash + 1) : path;
		const base = fileName.replace(/\.md$/, "");

		let counter = 1;
		let candidate: string;
		do {
			candidate = normalizePath(dir ? `${dir}/${base} ${counter}.md` : `${base} ${counter}.md`);
			counter++;
		} while (await this.app.vault.adapter.exists(candidate));

		return candidate;
	}
}

class AtomicNotesSettingTab extends PluginSettingTab {
	plugin: AtomicNotesPlugin;

	constructor(app: App, plugin: AtomicNotesPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl("h2", { text: "Atomic notes from selection" });

		new Setting(containerEl)
			.setName("Creation folder")
			.setDesc(
				"Where new atomic notes are created. Leave blank to create them in the vault root. " +
					"This is only a starting location — filing them into a permanent folder is left up to you."
			)
			.addText((text) =>
				text
					.setPlaceholder("e.g. Inbox")
					.setValue(this.plugin.settings.folderPath)
					.onChange(async (value) => {
						this.plugin.settings.folderPath = value.trim();
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Open \"move file\" dialog after creating")
			.setDesc(
				"Automatically opens Obsidian's built-in \"Move file to another folder\" command " +
					"right after the note is created, so you can file it manually. The plugin never files it for you."
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.openMoveDialogAfterCreate)
					.onChange(async (value) => {
						this.plugin.settings.openMoveDialogAfterCreate = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Template")
			.setDesc(
				"Template applied to every new atomic note. Placeholders: {{title}}, {{content}}, {{link}}, {{date}}."
			)
			.addTextArea((text) => {
				text
					.setValue(this.plugin.settings.template)
					.onChange(async (value) => {
						this.plugin.settings.template = value;
						await this.plugin.saveSettings();
					});
				text.inputEl.rows = 16;
				text.inputEl.cols = 50;
			});

		new Setting(containerEl).addButton((button) =>
			button.setButtonText("Restore default template").onClick(async () => {
				this.plugin.settings.template = DEFAULT_TEMPLATE;
				await this.plugin.saveSettings();
				this.display();
			})
		);
	}
}
