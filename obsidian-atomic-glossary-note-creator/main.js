const { Plugin, Notice, Modal, PluginSettingTab, Setting, stringifyYaml, requestUrl } = require('obsidian');

const PROVIDERS = {
	gemini: {
		name: 'Gemini',
		label: 'Gemini (Google)',
		defaultModel: 'gemini-3.5-flash-lite',
		defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta',
		keyHelp: 'Google AI Studio (aistudio.google.com)',
		costNote: 'A free tier is available.'
	},
	claude: {
		name: 'Claude',
		label: 'Claude (Anthropic)',
		defaultModel: 'claude-opus-5',
		defaultBaseUrl: 'https://api.anthropic.com/v1',
		keyHelp: 'the Claude Console (platform.claude.com)',
		costNote: 'Paid: requires API credit. Pick a smaller model (Sonnet, Haiku) for lower cost.'
	},
	openai: {
		name: 'OpenAI',
		label: 'OpenAI (ChatGPT models)',
		defaultModel: 'gpt-5-mini',
		defaultBaseUrl: 'https://api.openai.com/v1',
		keyHelp: 'the OpenAI platform (platform.openai.com)',
		costNote: 'Paid: requires API credit.'
	}
};

const emptyProviderSettings = () => ({ apiKey: '', model: '', baseUrl: '', availableModels: [], lastCheck: null });

const DEFAULT_SETTINGS = {
	provider: 'gemini',
	providers: {},
	timeoutSeconds: 15,
	showAiStatus: true,
	lastDestination: 'atomic'
};

const DESTINATIONS = {
	atomic: { label: 'Create atomic note', folder: 'Atomic Notes', type: 'atomic', key: 'a' },
	glossary: { label: 'Create glossary note', folder: 'Glossary', type: 'Glossary', key: 'g' }
};

const NEW_NOTE_TAG = '#newatomicnote';
const FORCE_TERMINATOR = '¤¤';

// H2 or H3 only ("##" / "###", not "####"). Trailing closing hashes are dropped.
const H2_H3_REGEX = /^\s{0,3}(#{2,3})(?!#)\s+(.+?)\s*#*\s*$/;
const FENCE_REGEX = /^\s{0,3}(```|~~~)/;
// "[2]: https://…" reference-link definitions and "[^1]: …" footnote definitions.
const REF_DEF_REGEX = /^\s{0,3}\[([^\]^\n][^\]\n]*)\]:\s*\S/;
const FOOTNOTE_DEF_REGEX = /^\s{0,3}\[\^([^\]\n]+)\]:/;
const INDENTED_CONTINUATION = /^( {4}|\t)\S/;
const CITATION_LABEL = /^\d+(?:[_.-]\d+)*$/;
// Lines of a citation source list: "[1] Title https://…" or "1. [Title](https://…)".
const BRACKET_SOURCE_LINE = /^\s{0,3}(?:[-*+]\s+)?\[\^?\d+(?:[_.-]\d+)*\]:?\s+.*https?:\/\//;
const NUMBERED_SOURCE_LINE = /^\s{0,3}\d+[.)]\s+.*https?:\/\//;
const ILLEGAL_FILENAME_CHARS = /[\\/:*?"<>|#^[\]\u0000-\u001f]/g;
const WINDOWS_RESERVED_NAMES = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;

const CONNECTIVITY_TIMEOUT_MS = 3000;
// All blocks of a run go to Gemini in as few requests as possible, so a
// long note does not use up the free tier's per-minute request limit.
const BATCH_MAX_BLOCKS = 15;
const BATCH_MAX_CHARS = 40000;
const BLOCK_MAX_CHARS = 6000;
const MAX_AI_LINKS = 8;

// Words that commonly open a sentence in capitalised form. When a capitalised
// run starts a sentence, a leading word from this list is dropped
// ("The Royal Society" -> "Royal Society").
const SENTENCE_STARTERS = new Set([
	'a', 'an', 'the', 'this', 'that', 'these', 'those', 'it', 'its', 'in', 'on', 'at', 'for',
	'from', 'with', 'by', 'of', 'to', 'and', 'but', 'or', 'so', 'as', 'if', 'when', 'while',
	'after', 'before', 'during', 'since', 'because', 'although', 'though', 'however', 'thus',
	'therefore', 'also', 'both', 'each', 'every', 'all', 'some', 'many', 'most', 'such',
	'there', 'here', 'his', 'her', 'their', 'our', 'my', 'your', 'we', 'they', 'he', 'she',
	'you', 'one', 'no', 'not', 'what', 'which', 'who', 'how', 'why', 'where', 'then', 'yet',
	'unlike', 'like', 'among', 'between', 'under', 'over', 'into', 'through', 'per', 'via',
	'see', 'note', 'until', 'unless', 'whereas', 'despite', 'within', 'without', 'only'
]);

// Lower-case words allowed inside a capitalised run ("Bank of England").
const RUN_CONNECTORS = new Set(['of', 'de', 'la', 'le', 'du', 'da', 'del', 'di', 'von', 'van', 'der', 'den']);

// Capitalised by convention but rarely worth a note of their own.
const EXCLUDED_TERMS = new Set([
	'i', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
	'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september',
	'october', 'november', 'december'
]);

module.exports = class AtomicGlossaryNotePlugin extends Plugin {
	async onload() {
		await this.loadSettings();

		this.addCommand({
			id: 'create-atomic-or-glossary-note',
			name: 'Create Atomic or Glossary Note',
			editorCallback: (editor, view) => this.run(editor, view)
		});

		this.addCommand({
			id: 'test-ai-api-key',
			name: 'Test AI API key',
			callback: () => this.testApiKey()
		});

		this.addCommand({
			id: 'run-ai-diagnostics',
			name: 'Run AI diagnostics',
			callback: () => this.openDiagnostics()
		});

		this.addSettingTab(new AtomicGlossarySettingTab(this.app, this));
	}

	async loadSettings() {
		const saved = (await this.loadData()) || {};
		this.settings = Object.assign({}, DEFAULT_SETTINGS, saved);

		// Each provider keeps its own key, model, endpoint and status.
		const providers = {};
		for (const key of Object.keys(PROVIDERS)) {
			providers[key] = Object.assign(emptyProviderSettings(), (saved.providers || {})[key]);
		}
		this.settings.providers = providers;

		// Carry over settings from versions that supported Gemini only.
		if (saved.geminiApiKey !== undefined && !(saved.providers && saved.providers.gemini)) {
			Object.assign(providers.gemini, {
				apiKey: saved.geminiApiKey || '',
				model: saved.model || '',
				baseUrl: saved.apiBaseUrl && saved.apiBaseUrl !== PROVIDERS.gemini.defaultBaseUrl ? saved.apiBaseUrl : '',
				availableModels: saved.availableModels || [],
				lastCheck: saved.lastCheck || null
			});
		}
		for (const legacy of ['geminiApiKey', 'model', 'apiBaseUrl', 'availableModels', 'lastCheck']) delete this.settings[legacy];
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	async setLastCheck(ok, message) {
		this.getProviderSettings().lastCheck = { ok, message, at: Date.now() };
		await this.saveSettings();
	}

	/**
	 * Entry point for "Create Atomic or Glossary Note". Asks for atomic note or glossary
	 * entry, splits the selection (or the whole note) into blocks,
	 * optionally enriches them with Gemini, then writes one note per block.
	 */
	async run(editor, view) {
		// Timestamp of command execution, used for untitled blocks.
		const runStarted = new Date();

		const sourceFile = view.file;
		if (!sourceFile) {
			new Notice('Atomic notes: no active file open.');
			return;
		}

		const destinationKey = await this.chooseDestination(this.settings.lastDestination);
		if (!destinationKey) return; // Dialog dismissed: cancel silently.
		const destination = DESTINATIONS[destinationKey];
		if (this.settings.lastDestination !== destinationKey) {
			this.settings.lastDestination = destinationKey;
			await this.saveSettings();
		}

		const fullText = editor.getValue();
		const selection = editor.getSelection();
		const hasSelection = selection.trim().length > 0;
		const text = hasSelection ? selection : fullText;

		const blocks = this.parseBlocks(text, !hasSelection);
		if (blocks.length === 0) {
			new Notice('No atomic note triggers found.');
			return;
		}

		// Citation definitions are looked up in the whole note, so a
		// selection still gets the references it cites.
		const definitions = this.collectReferenceDefinitions(fullText);
		const sources = this.collectCitationSources(fullText);
		const citationStats = { linked: new Set(), missing: new Set() };

		const { results: aiResults, report: aiReport } = await this.getAiSuggestions(blocks);
		this.assignTitles(blocks, aiResults, runStarted);

		await this.ensureFolder(destination.folder);

		let createdCount = 0;
		for (let i = 0; i < blocks.length; i++) {
			const block = blocks[i];
			const aiLinks = aiResults[i] ? aiResults[i].links : [];
			try {
				await this.createNote(block, aiLinks, definitions, sources, citationStats, sourceFile, destination);
				createdCount++;
			} catch (err) {
				console.error('Atomic notes: failed to create note', block.title, err);
			}
		}

		let summary = `Atomic notes: created ${createdCount} note(s) in "${destination.folder}".`;
		if (this.settings.showAiStatus) summary += `\n${this.describeAiReport(aiReport)}`;
		const citationLine = this.describeCitations(citationStats);
		if (citationLine) summary += `\n${citationLine}`;
		new Notice(summary, this.settings.showAiStatus || citationLine ? 15000 : undefined);
	}

	chooseDestination(defaultKey) {
		return new Promise((resolve) => {
			new DestinationModal(this.app, defaultKey, resolve).open();
		});
	}

	/**
	 * Splits text into blocks. A block opens on an H2/H3 heading or a line
	 * holding only #newatomicnote, and closes on "¤¤" alone on a line, the
	 * next H2/H3, the next #newatomicnote, or the end of the text. Lines
	 * inside fenced code are always body text. Anything outside a block
	 * (before the first trigger, or after a "¤¤") is ignored, as are
	 * citation definitions (see collectReferenceDefinitions).
	 */
	parseBlocks(text, skipFrontmatter) {
		let lines = text.split(/\r?\n/);
		if (skipFrontmatter) lines = this.stripFrontmatter(lines);

		const rawBlocks = [];
		let current = null;
		let inFence = false;
		let inFootnote = false;

		const close = () => {
			if (current) rawBlocks.push(current);
			current = null;
		};

		for (const line of lines) {
			if (inFence) {
				if (FENCE_REGEX.test(line)) inFence = false;
				if (current) current.lines.push(line);
				continue;
			}

			const trimmed = line.trim();

			// Citation definitions ("[2]: https://…", "[^1]: …" and its indented
			// continuation lines) are not body text; each note gets the ones it
			// cites appended at the end instead.
			if (inFootnote && INDENTED_CONTINUATION.test(line)) continue;
			inFootnote = false;
			if (FOOTNOTE_DEF_REGEX.test(line)) {
				inFootnote = true;
				continue;
			}
			if (REF_DEF_REGEX.test(line) || BRACKET_SOURCE_LINE.test(line)) continue;

			if (trimmed === FORCE_TERMINATOR) {
				close();
				continue;
			}

			const headingMatch = line.match(H2_H3_REGEX);
			if (headingMatch) {
				const headingText = headingMatch[2].trim();
				if (current && current.awaitingHeading) {
					// #newatomicnote followed by a heading before any body text:
					// the heading names the block and is not part of the body.
					current.title = headingText;
					current.awaitingHeading = false;
				} else {
					close();
					current = { title: headingText, lines: [], awaitingHeading: false };
				}
				continue;
			}

			if (trimmed === NEW_NOTE_TAG) {
				close();
				current = { title: null, lines: [], awaitingHeading: true };
				continue;
			}

			if (FENCE_REGEX.test(line)) inFence = true;

			if (current) {
				if (trimmed !== '') current.awaitingHeading = false;
				current.lines.push(line);
			}
		}
		close();

		return rawBlocks
			.map((b) => ({ title: b.title, body: this.trimBlankLines(b.lines).join('\n') }))
			.filter((b) => b.body.length > 0 && !this.isSourceList(b.body));
	}

	/** True when a block holds nothing but a citation source list. */
	isSourceList(body) {
		const lines = body.split('\n').filter((l) => l.trim() !== '');
		return lines.length > 0 && lines.every((l) => NUMBERED_SOURCE_LINE.test(l) || BRACKET_SOURCE_LINE.test(l));
	}

	stripFrontmatter(lines) {
		if (lines.length === 0 || lines[0].trim() !== '---') return lines;
		for (let i = 1; i < lines.length; i++) {
			const t = lines[i].trim();
			if (t === '---' || t === '...') return lines.slice(i + 1);
		}
		return lines;
	}

	trimBlankLines(lines) {
		const out = lines.slice();
		while (out.length && out[0].trim() === '') out.shift();
		while (out.length && out[out.length - 1].trim() === '') out.pop();
		return out;
	}

	/**
	 * Gives every untitled block a title: the Gemini title when one came
	 * back, otherwise a Zettelkasten timestamp. When several blocks fall
	 * back to the timestamp they are numbered "YYYYMMDD-HHmmss 1", "… 2".
	 */
	assignTitles(blocks, aiResults, runStarted) {
		const timestamp = this.formatTimestamp(runStarted);
		const needTimestamp = [];

		blocks.forEach((block, i) => {
			if (block.title) return;
			const aiTitle = aiResults[i] && aiResults[i].title;
			if (aiTitle) {
				block.title = aiTitle;
			} else {
				needTimestamp.push(block);
			}
		});

		if (needTimestamp.length === 1) {
			needTimestamp[0].title = timestamp;
		} else {
			needTimestamp.forEach((block, n) => {
				block.title = `${timestamp} ${n + 1}`;
			});
		}
	}

	formatTimestamp(date) {
		const pad = (n) => n.toString().padStart(2, '0');
		return (
			`${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
			`-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
		);
	}

	/**
	 * Makes sure folderPath exists, creating every missing segment along
	 * the way. Safe to call every time the command runs.
	 */
	async ensureFolder(folderPath) {
		const normalized = folderPath.replace(/^\/+|\/+$/g, '');
		if (!normalized) return;

		const segments = normalized.split('/');
		let pathSoFar = '';

		for (const segment of segments) {
			pathSoFar = pathSoFar ? `${pathSoFar}/${segment}` : segment;
			const existing = this.app.vault.getAbstractFileByPath(pathSoFar);
			if (!existing) {
				try {
					await this.app.vault.createFolder(pathSoFar);
				} catch (err) {
					// Ignore "already exists" races; rethrow anything else.
					const already = this.app.vault.getAbstractFileByPath(pathSoFar);
					if (!already) throw err;
				}
			}
		}
	}

	/** Replace characters that are illegal on any major OS with a hyphen. */
	sanitizeFilename(name) {
		let safe = name
			.replace(ILLEGAL_FILENAME_CHARS, '-')
			.replace(/-{2,}/g, '-')
			.trim()
			.replace(/[.\s]+$/, ''); // Windows rejects trailing dots and spaces.
		if (WINDOWS_RESERVED_NAMES.test(safe)) safe = `${safe}-`;
		return safe;
	}

	async getUniquePath(folderPath, baseName) {
		let candidate = `${folderPath}/${baseName}.md`;
		let counter = 2;
		while (this.app.vault.getAbstractFileByPath(candidate)) {
			candidate = `${folderPath}/${baseName} ${counter}.md`;
			counter++;
		}
		return candidate;
	}

	async createNote(block, aiLinks, definitions, sources, citationStats, sourceFile, destination) {
		// Numbered citations become Obsidian footnotes linked to their sources.
		const citations = this.linkCitations(block.body, sources);
		citations.linked.forEach((n) => citationStats.linked.add(n));
		citations.missing.forEach((n) => citationStats.missing.add(n));
		const body = citations.body;
		block = Object.assign({}, block, { body });

		const safeTitle = this.sanitizeFilename(block.title) || this.formatTimestamp(new Date());
		const path = await this.getUniquePath(destination.folder, safeTitle);
		const updated = new Date().toISOString().slice(0, 10);
		const sourceLink = `[[${sourceFile.basename}]]`;

		// stringifyYaml() handles quoting/escaping (e.g. "[[Note]]" would
		// otherwise be read as a nested list, and multi-line summaries need
		// block-literal formatting).
		const frontmatter =
			destination.type === 'atomic'
				? {
						title: block.title,
						type: 'atomic',
						source: sourceFile.basename,
						tags: ['atomicnote'],
						Subjects: [],
						Projects: [],
						Links: [sourceLink],
						Status: 'draft',
						updated: updated
				  }
				: {
						Title: block.title,
						aliases: [],
						type: 'Glossary',
						tags: ['Glossary'],
						Subjects: [],
						Projects: [],
						Status: 'draft',
						Sources: sourceLink,
						Links: [],
						Note_Summary: body,
						updated: updated
				  };

		const yaml = stringifyYaml(frontmatter);
		let noteContent = `---\n${yaml}---\n\n${body}\n`;

		// Other (non-numbered) reference-link and footnote definitions.
		const cited = this.findCitedDefinitions(body, definitions);
		if (cited.length > 0) {
			noteContent += `\n${cited.join('\n')}\n`;
		}

		const links = this.collectLinks(block, aiLinks);
		if (links.length > 0) {
			noteContent += `\n## See Also\n\n${links.map((l) => `- [[${l}]]`).join('\n')}\n`;
		}

		// Footnote definitions go last; Obsidian shows them as a numbered
		// source list at the bottom of the note.
		if (citations.footnotes.length > 0) {
			noteContent += `\n${citations.footnotes.join('\n')}\n`;
		}

		await this.app.vault.create(path, noteContent);
	}

	/**
	 * Reads every citation definition in the note: reference links
	 * ("[2]: https://…") and footnotes ("[^1]: …", with indented
	 * continuation lines). Returns a Map from "ref:label" / "fn:label"
	 * (lower case) to the definition's lines.
	 */
	collectReferenceDefinitions(text) {
		const definitions = new Map();
		const lines = text.split(/\r?\n/);
		let inFence = false;
		let footnote = null;

		for (const line of lines) {
			if (FENCE_REGEX.test(line)) {
				inFence = !inFence;
				footnote = null;
				continue;
			}
			if (inFence) continue;

			if (footnote && INDENTED_CONTINUATION.test(line)) {
				footnote.push(line);
				continue;
			}
			footnote = null;

			const fn = line.match(FOOTNOTE_DEF_REGEX);
			if (fn) {
				const key = `fn:${fn[1].trim().toLowerCase()}`;
				if (!definitions.has(key)) {
					footnote = [line.trim()];
					definitions.set(key, footnote);
				}
				continue;
			}
			const ref = line.match(REF_DEF_REGEX);
			if (ref) {
				const key = `ref:${ref[1].trim().toLowerCase()}`;
				if (!definitions.has(key)) definitions.set(key, [line.trim()]);
			}
		}
		return definitions;
	}

	/** Definitions for the citations used in this block, in order of first use. */
	findCitedDefinitions(body, definitions) {
		if (definitions.size === 0) return [];
		const found = [];
		const seen = new Set();
		const re = /(\[)?\[(\^?)([^\[\]\n]+)\](?!\])/g;
		let m;
		while ((m = re.exec(body)) !== null) {
			if (m[1]) continue; // part of a [[wiki link]]
			if (CITATION_LABEL.test(m[3].trim())) continue; // numbered citations: see linkCitations
			const key = `${m[2] ? 'fn' : 'ref'}:${m[3].trim().toLowerCase()}`;
			if (seen.has(key) || !definitions.has(key)) continue;
			seen.add(key);
			found.push(...definitions.get(key));
		}
		return found;
	}

	/**
	 * Finds the source behind every citation number in the note. Accepts
	 * the common layouts of AI and web exports:
	 *   [1]: https://…  "Title"      reference-link definition
	 *   [^1]: Title https://…        footnote definition
	 *   [1] Title https://…          bracketed list line (optionally "- [1] …")
	 *   1. [Title](https://…)        numbered list line containing a link
	 * Returns a Map from the number ("1", "1_2") to { display }.
	 */
	collectCitationSources(text) {
		const sources = new Map();
		let inFence = false;
		const lines = text.split(/\r?\n/);

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			if (FENCE_REGEX.test(line)) {
				inFence = !inFence;
				continue;
			}
			if (inFence) continue;

			const m =
				line.match(/^\s{0,3}(?:[-*+]\s+)?\[\^?(\d+(?:[_.-]\d+)*)\]:?\s*(.+)$/) ||
				line.match(/^\s{0,3}(\d+)[.)]\s+(.*https?:\/\/.*)$/);
			if (!m || sources.has(m[1])) continue;

			// Footnote definitions may continue on indented lines.
			let rest = m[2].trim();
			while (i + 1 < lines.length && INDENTED_CONTINUATION.test(lines[i + 1]) && /^\s{0,3}\[\^/.test(line)) {
				rest += ` ${lines[++i].trim()}`;
			}

			const source = this.parseSourceText(rest);
			if (source) sources.set(m[1], source);
		}
		return sources;
	}

	/**
	 * Turns a source line into the footnote text: the full citation as
	 * written, followed by its URL, e.g.
	 *   "Is Rye Flour the Same as Wholemeal Flour? – HomeDiningKitchen – [https://…](https://…)"
	 * so a scholarly reference keeps its authors, journal and year.
	 * Returns { display } or null if the line holds nothing.
	 */
	parseSourceText(rest) {
		rest = rest.trim();
		if (!rest) return null;

		// "https://… "Title"" (reference-link definition) or a bare URL.
		const urlFirst = rest.match(/^<?(https?:\/\/[^\s<>]+?)>?(?:\s+["'(](.*)["')])?\s*$/);
		if (urlFirst) return { display: this.formatSource(urlFirst[2] || '', urlFirst[1]) };

		// Markdown links "[Title](url)" become "Title – url".
		const links = [];
		let text = rest.replace(/\[([^\]]*)\]\(\s*<?(https?:\/\/[^()\s>]+)>?[^)]*\)/g, (m, title, url) => {
			links.push(this.formatSource(title, url));
			return `${links.length - 1}`;
		});
		// Bare or <angle> URLs, with any ":" or "-" separator before them.
		text = text.replace(/(\S?)\s*([:\-–—]?)\s*<?(https?:\/\/[^\s<>]+?)>?(?=[.,;]?(?:\s|$))/g, (m, prev, sep, url) => {
			let join = '';
			if (prev) join = sep === ':' ? ': ' : /[.;,]/.test(prev) ? ' ' : ' – ';
			return `${prev}${join}${this.linkUrl(url)}`;
		});
		// "doi:10.xxxx/yyy" becomes a clickable DOI link.
		text = text.replace(/(^|[\s(])doi:\s*(10\.\d{4,9}\/[^\s<>]+?)(?=[.,;]?(?:\s|$))/gi, (m, pre, doi) =>
			`${pre}[doi:${doi}](https://doi.org/${doi})`
		);
		text = text.replace(/(\d+)/g, (m, i) => links[Number(i)]);
		return { display: text.replace(/\s{2,}/g, ' ').trim() };
	}

	formatSource(title, url) {
		const t = (title || '').replace(/[[\]]/g, '').trim();
		return t && t !== url ? `${t} – ${this.linkUrl(url)}` : this.linkUrl(url);
	}

	/** A clickable link that shows the URL itself. */
	linkUrl(url) {
		const clean = url.replace(/[.,;]+$/, '');
		return `[${clean}](${clean.replace(/ /g, '%20').replace(/\(/g, '%28').replace(/\)/g, '%29')})`;
	}

	/**
	 * Rewrites numbered citations in a block as footnotes: "[1][6]",
	 * "[1]" or "[1](https://…)" become "[^1][^6]" and each gets a
	 * "[^1]: Title – URL" definition. Numbers with no known source are left
	 * as written and reported as missing.
	 */
	linkCitations(body, sources) {
		const used = new Map();
		const missing = new Set();
		// A single number ("[1]", "[1_2]") or a group ("[1,2]", "[1–3]", "[1, 3-5]").
		const re = /(\[)?\[(\^?)(\d+(?:\s*[,_.–—-]\s*\d+)*)\](\(\s*<?(https?:\/\/[^()\s>]+)>?(?:\s+["'(]([^"')]*)["')])?\s*\))?/g;

		const lines = body.split('\n');
		let inFence = false;
		const out = lines.map((line) => {
			if (FENCE_REGEX.test(line)) {
				inFence = !inFence;
				return line;
			}
			if (inFence) return line;
			return line.replace(re, (whole, wikiOpen, caret, num, inline, inlineUrl, inlineTitle) => {
				if (wikiOpen) return whole; // part of a [[wiki link]]
				if (inline) {
					if (!used.has(num)) used.set(num, { display: this.formatSource(inlineTitle, inlineUrl) });
					return `[^${num}]`;
				}
				const numbers = sources.has(num) ? [num] : this.expandCitationGroup(num);
				if (!numbers.some((n) => sources.has(n))) {
					numbers.forEach((n) => missing.add(n));
					return whole;
				}
				// "[1,2]" becomes "[^1][^2]"; a number without a source stays as "[n]".
				return numbers
					.map((n) => {
						const source = sources.get(n);
						if (!source) {
							missing.add(n);
							return `[${n}]`;
						}
						if (!used.has(n)) used.set(n, source);
						return `[^${n}]`;
					})
					.join('');
			});
		});

		const footnotes = Array.from(used.entries()).map(([num, src]) => `[^${num}]: ${src.display}`);

		// A numbered source list at the end of the block is shown as footnotes
		// instead, so drop it from the text.
		if (used.size > 0) {
			while (out.length && (out[out.length - 1].trim() === '' || NUMBERED_SOURCE_LINE.test(out[out.length - 1]))) out.pop();
		}

		return { body: out.join('\n'), footnotes, linked: Array.from(used.keys()), missing: Array.from(missing) };
	}

	/** "1, 3-5" -> ["1", "3", "4", "5"]; a label such as "1_2" stays whole. */
	expandCitationGroup(label) {
		const numbers = [];
		for (const part of label.split(/\s*,\s*/)) {
			const range = part.match(/^(\d+)\s*[–—-]\s*(\d+)$/);
			const from = range && Number(range[1]);
			const to = range && Number(range[2]);
			if (range && to > from && to - from <= 50) {
				for (let n = from; n <= to; n++) numbers.push(String(n));
			} else {
				numbers.push(part.replace(/\s+/g, ''));
			}
		}
		return numbers;
	}

	/** End-of-run line about citations, or '' when the notes had none. */
	describeCitations(stats) {
		const sortNums = (set) => Array.from(set).sort((a, b) => parseFloat(a) - parseFloat(b));
		const missing = sortNums(stats.missing).filter((n) => !stats.linked.has(n));
		if (!stats.linked.size && !missing.length) return '';
		const parts = [];
		if (stats.linked.size) parts.push(`Citations: ${stats.linked.size} linked to their sources.`);
		if (missing.length) {
			const shown = missing.slice(0, 8).map((n) => `[${n}]`).join(' ');
			parts.push(
				`${missing.length} citation number(s) (${shown}${missing.length > 8 ? ' …' : ''}) have no source list in the note, so they were left as plain text.`
			);
		}
		return parts.join(' ');
	}

	/**
	 * Explicit [[links]] first, then rule-based candidates, then Gemini
	 * suggestions. Deduplicated case-insensitively; the note's own title
	 * is left out.
	 */
	collectLinks(block, aiLinks) {
		const ownTitle = block.title.trim().toLowerCase();
		const seen = new Set();
		const out = [];

		const add = (term) => {
			const clean = term.trim();
			if (!clean) return;
			const key = clean.toLowerCase();
			const pageKey = key.split('#')[0].trim();
			if (pageKey === ownTitle || seen.has(key)) return;
			seen.add(key);
			out.push(clean);
		};

		this.extractExplicitLinks(block.body).forEach(add);
		this.extractCandidateTerms(block.body).forEach(add);
		(aiLinks || []).forEach(add);
		return out;
	}

	/** Targets of [[...]] links in the block, ignoring ![[embeds]] and aliases. */
	extractExplicitLinks(text) {
		const out = [];
		const re = /(!?)\[\[([^\]\n]+?)\]\]/g;
		let m;
		while ((m = re.exec(text)) !== null) {
			if (m[1] === '!') continue;
			const target = m[2].split('|')[0].trim();
			if (target) out.push(target);
		}
		return out;
	}

	/**
	 * Proper nouns and consistently capitalised terms: runs of capitalised
	 * words that appear somewhere other than the start of a sentence.
	 * A single capitalised word is dropped if the same word also appears
	 * in lower case elsewhere in the block (so it is not consistently
	 * capitalised).
	 */
	extractCandidateTerms(text) {
		const lines = this.stripCodeFences(text.split(/\r?\n/));
		const runs = [];

		for (const rawLine of lines) {
			const line = this.cleanLineForScanning(rawLine);
			const tokens = line.match(/\p{L}[\p{L}\p{M}'’-]*|[.!?:;]|[^\s\p{L}]/gu) || [];

			let sentenceStart = true;
			let run = [];
			let runAtStart = false;
			let pending = [];

			const flush = () => {
				if (run.length) runs.push({ words: run, atStart: runAtStart });
				run = [];
				pending = [];
			};

			for (const rawToken of tokens) {
				const isWord = /^\p{L}/u.test(rawToken);
				if (!isWord) {
					flush();
					if (/^[.!?:]$/.test(rawToken)) sentenceStart = true;
					continue;
				}

				const word = rawToken.replace(/['’]s$/, '').replace(/[-'’]+$/, '');
				const capitalised = /^\p{Lu}/u.test(word) && word.length > 1;

				if (capitalised) {
					if (run.length === 0) {
						runAtStart = sentenceStart;
						run = [word];
					} else {
						run.push(...pending, word);
						pending = [];
					}
				} else if (run.length && pending.length === 0 && RUN_CONNECTORS.has(word)) {
					pending.push(word);
				} else {
					flush();
				}
				sentenceStart = false;
			}
			flush();
		}

		const lowerCaseWords = new Set(
			(text.match(/\p{L}[\p{L}\p{M}'’-]*/gu) || []).filter((w) => /^\p{Ll}/u.test(w))
		);

		const terms = [];
		for (const { words, atStart } of runs) {
			let w = words.slice();
			if (atStart) {
				// The first word may only be capitalised because it opens a sentence.
				if (w.length === 1) continue;
				if (SENTENCE_STARTERS.has(w[0].toLowerCase())) {
					w.shift();
					while (w.length && RUN_CONNECTORS.has(w[0])) w.shift();
				}
			}
			if (w.length === 0) continue;

			const term = w.join(' ');
			const lower = term.toLowerCase();
			if (EXCLUDED_TERMS.has(lower)) continue;
			if (w.length === 1 && (SENTENCE_STARTERS.has(lower) || lowerCaseWords.has(lower))) continue;
			terms.push(term);
		}
		return terms;
	}

	stripCodeFences(lines) {
		const out = [];
		let inFence = false;
		for (const line of lines) {
			if (FENCE_REGEX.test(line)) {
				inFence = !inFence;
				continue;
			}
			if (!inFence) out.push(line);
		}
		return out;
	}

	/**
	 * Removes markdown syntax that would confuse the capitalisation scan.
	 * Removed spans are replaced by a "|" so they break a run of words
	 * without starting a new sentence.
	 */
	cleanLineForScanning(line) {
		return line
			.replace(/^\s*(>\s*)*/, '')
			.replace(/^#{1,6}\s+/, '')
			.replace(/^([-*+]\s+(\[.\]\s+)?|\d+[.)]\s+)/, '')
			.replace(/`[^`]*`/g, ' | ')
			.replace(/!?\[\[[^\]]*\]\]/g, ' | ')
			.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
			.replace(/\[\^[^\]]*\]/g, ' | ')
			.replace(/\[![^\]]*\]/g, ' | ')
			.replace(/https?:\/\/\S+/g, ' | ')
			.replace(/(^|\s)#[^\s#]+/g, ' | ')
			.replace(/<[^>]+>/g, ' | ')
			.replace(/[*_~=]{1,3}/g, '');
	}

	// ------------------------------------------------------------------
	// AI providers (Tier 2): Gemini, Claude, OpenAI
	// ------------------------------------------------------------------

	getProviderKey() {
		return PROVIDERS[this.settings.provider] ? this.settings.provider : 'gemini';
	}

	getProvider() {
		return PROVIDERS[this.getProviderKey()];
	}

	/** Settings for the selected provider: { apiKey, model, baseUrl, availableModels, lastCheck }. */
	getProviderSettings() {
		return this.settings.providers[this.getProviderKey()];
	}

	getApiKey() {
		return (this.getProviderSettings().apiKey || '').trim();
	}

	getModel() {
		return (this.getProviderSettings().model || '').trim().replace(/^models\//, '') || this.getProvider().defaultModel;
	}

	getBaseUrl() {
		return ((this.getProviderSettings().baseUrl || '').trim() || this.getProvider().defaultBaseUrl).replace(/\/+$/, '');
	}

	getTimeoutMs() {
		const seconds = Number(this.settings.timeoutSeconds);
		return (Number.isFinite(seconds) && seconds > 0 ? seconds : DEFAULT_SETTINGS.timeoutSeconds) * 1000;
	}

	/**
	 * Returns { results, report }: one { title, links } entry per block
	 * (null where the AI was unavailable or failed), plus a report of what
	 * happened for the end-of-run notice. Never throws: any failure leaves
	 * the rule-based (Tier 1) behaviour in place.
	 */
	async getAiSuggestions(blocks) {
		const results = blocks.map(() => null);
		const provider = this.getProvider().name;
		const apiKey = this.getApiKey();
		if (!apiKey) return { results, report: { state: 'off', provider } };

		try {
			const online = await this.checkOnline();
			if (!online.ok) return { results, report: { state: 'offline', provider, reason: online.reason } };

			let failure = null;
			for (const batch of this.makeBatches(blocks)) {
				const outcome = await this.askBatch(batch.map((i) => blocks[i].body), apiKey);
				if (!outcome.ok) {
					failure = outcome;
					console.warn(`Atomic notes: ${provider} request failed:`, outcome.reason, outcome.detail || '');
					// Once the key, quota or model is refused, later requests would be too.
					if (['invalid-key', 'permission', 'quota', 'billing', 'model-not-found'].includes(outcome.kind)) break;
					continue;
				}
				batch.forEach((blockIndex, n) => {
					results[blockIndex] = outcome.results[n] || null;
				});
			}

			const succeeded = results.filter(Boolean).length;
			const report = {
				state: succeeded === 0 ? 'failed' : 'used',
				provider,
				succeeded,
				total: blocks.length,
				reason: failure ? failure.reason : null
			};
			await this.setLastCheck(succeeded > 0, succeeded > 0 ? `Last run used ${provider} successfully.` : failure.reason);
			return { results, report };
		} catch (err) {
			return { results, report: { state: 'failed', provider, reason: `unexpected error: ${err.message}` } };
		}
	}

	/** Groups block indexes so each request stays within size limits. */
	makeBatches(blocks) {
		const batches = [];
		let current = [];
		let chars = 0;
		blocks.forEach((block, i) => {
			const size = Math.min(block.body.length, BLOCK_MAX_CHARS);
			if (current.length && (current.length >= BATCH_MAX_BLOCKS || chars + size > BATCH_MAX_CHARS)) {
				batches.push(current);
				current = [];
				chars = 0;
			}
			current.push(i);
			chars += size;
		});
		if (current.length) batches.push(current);
		return batches;
	}

	async checkOnline() {
		if (typeof navigator !== 'undefined' && navigator.onLine === false) {
			return { ok: false, reason: 'no internet connection' };
		}
		let origin;
		try {
			origin = new URL(this.getBaseUrl()).origin;
		} catch (err) {
			return { ok: false, reason: `the API endpoint in settings is not a valid address (${this.getBaseUrl()})` };
		}
		try {
			await this.withTimeout(requestUrl({ url: `${origin}/`, method: 'HEAD', throw: false }), CONNECTIVITY_TIMEOUT_MS);
			return { ok: true };
		} catch (err) {
			const name = this.getProvider().name;
			const reason =
				err.message === 'timeout'
					? `the ${name} service did not answer within ${CONNECTIVITY_TIMEOUT_MS / 1000}s`
					: `cannot reach the ${name} service (${err.message})`;
			return { ok: false, reason };
		}
	}

	/** Authentication and version headers for the selected provider. */
	providerHeaders(apiKey) {
		switch (this.getProviderKey()) {
			case 'claude':
				return { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' };
			case 'openai':
				return { Authorization: `Bearer ${apiKey}` };
			default:
				return { 'x-goog-api-key': apiKey };
		}
	}

	/**
	 * Low-level request to the selected provider. Resolves to
	 * { ok: true, data, ms } or { ok: false, kind, reason, detail, ms }.
	 */
	async apiRequest(path, apiKey, method, body) {
		const started = Date.now();
		let response;
		try {
			response = await this.withTimeout(
				requestUrl({
					url: `${this.getBaseUrl()}/${path}`,
					method,
					contentType: body ? 'application/json' : undefined,
					headers: this.providerHeaders(apiKey),
					body: body ? JSON.stringify(body) : undefined,
					throw: false
				}),
				this.getTimeoutMs()
			);
		} catch (err) {
			const ms = Date.now() - started;
			if (err.message === 'timeout') {
				return {
					ok: false,
					ms,
					kind: 'timeout',
					reason: `no reply within ${this.getTimeoutMs() / 1000}s. Increase the timeout in settings, or try again later.`
				};
			}
			return { ok: false, ms, kind: 'network', reason: `network error (${err.message})` };
		}
		const ms = Date.now() - started;

		let data = null;
		try {
			data = JSON.parse(response.text);
		} catch (err) {
			// Leave data null; handled below.
		}

		if (response.status < 200 || response.status >= 300) {
			return Object.assign(
				{ ok: false, ms, status: response.status, detail: data || response.text },
				this.classifyHttpError(response.status, data, response.text)
			);
		}
		return { ok: true, ms, data };
	}

	/** Turns an HTTP error from any provider into { kind, reason } in plain language. */
	classifyHttpError(status, data, text) {
		const error = (data && data.error) || {};
		const message = error.message || (text || '').slice(0, 200) || 'no details';
		const type = `${error.type || ''} ${error.code || ''} ${error.status || ''}`;
		const details = Array.isArray(error.details) ? error.details : [];
		const reasons = details.map((d) => d.reason).filter(Boolean);
		const provider = this.getProvider();
		const model = this.getModel();

		if (
			status === 401 ||
			reasons.includes('API_KEY_INVALID') ||
			/api key not valid|invalid[_ ]api[_ ]key|invalid x-api-key|authentication_error/i.test(`${message} ${type}`)
		) {
			return { kind: 'invalid-key', reason: `${provider.name} API key is invalid, expired or incorrectly copied. Paste it again from ${provider.keyHelp}.` };
		}
		if (/expired/i.test(message) && /key/i.test(message)) {
			return { kind: 'invalid-key', reason: `${provider.name} API key has expired. Create a new key in ${provider.keyHelp}.` };
		}
		if (/credit balance|insufficient_quota|billing|payment|FAILED_PRECONDITION/i.test(`${message} ${type}`)) {
			return { kind: 'billing', reason: `The API key is valid, but billing or credit needs attention. ${provider.name} says: ${message}` };
		}
		if (status === 403) {
			return { kind: 'permission', reason: `API key was refused (HTTP 403): it lacks permission for this request. ${provider.name} says: ${message}` };
		}
		if (status === 404) {
			return {
				kind: 'model-not-found',
				reason: `The API key works, but model "${model}" is not available. Use "Refresh" next to the model in settings to pick a current one.`
			};
		}
		if (status === 429) {
			if (this.getProviderKey() === 'gemini') return { kind: 'quota', reason: this.describeQuotaError(message, details) };
			return { kind: 'quota', reason: `The API key is valid, but the rate limit has been reached. Wait a minute and try again. ${provider.name} says: ${message}` };
		}
		if (status === 529 || status === 503) {
			return { kind: 'server', reason: `${provider.name} is overloaded right now (HTTP ${status}). Try again in a few minutes.` };
		}
		if (status >= 500) {
			return { kind: 'server', reason: `${provider.name}'s service had an error (HTTP ${status}). Try again later.` };
		}
		return { kind: 'bad-request', reason: `Request rejected (HTTP ${status}). ${provider.name} says: ${message}` };
	}

	describeQuotaError(message, details) {
		const violation = details
			.filter((d) => Array.isArray(d.violations))
			.reduce((all, d) => all.concat(d.violations), [])[0] || {};
		const retry = details.find((d) => d.retryDelay);
		const quotaId = `${violation.quotaId || ''} ${violation.quotaMetric || ''} ${message}`;
		const limitMatch = message.match(/limit:\s*(\d+)/);
		const limit = violation.quotaValue || (limitMatch && limitMatch[1]);
		const perDay = /per\s*day|PerDay/i.test(quotaId);
		const freeTier = /free[_\s-]?tier/i.test(quotaId);
		const retrySeconds = retry ? Math.ceil(parseFloat(retry.retryDelay)) : null;

		const what = `the ${freeTier ? 'free-tier' : 'quota'} limit has been reached${
			limit ? ` (${limit} requests per ${perDay ? 'day' : 'minute'} for ${this.getModel()})` : ''
		}.`;
		const when = perDay
			? ' Try again tomorrow, or enable billing in Google AI Studio.'
			: ` Wait ${retrySeconds ? `${retrySeconds}s` : 'a minute'} and try again${freeTier ? ', or enable billing in Google AI Studio' : ''}.`;
		return `The API key is valid, but ${what}${when}`;
	}

	/**
	 * Sends several blocks in one request. Resolves to
	 * { ok: true, results: [{ title, links } | null, …], ms } or a failure.
	 */
	async askBatch(texts, apiKey) {
		const prompt = [
			'You are helping build a Zettelkasten knowledge base in Obsidian.',
			`Below are ${texts.length} note(s), each marked with an id.`,
			'For every note, reply with JSON only, no other text, in exactly this shape:',
			'{"notes": [{"id": 1, "title": "<title>", "links": ["<term>", "<term>"]}]}',
			'',
			'Rules:',
			'- One entry per note, using the same id.',
			'- title: five words or fewer, capturing the central idea of that note. No quotation marks, no final punctuation.',
			`- links: up to ${MAX_AI_LINKS} distinct, semantically relevant topic terms (concepts, people, places, works, disciplines) that would make good titles for related notes. Use canonical noun-phrase forms. No brackets.`,
			'',
			...texts.map((t, i) => `=== NOTE id=${i + 1} ===\n${t.slice(0, BLOCK_MAX_CHARS)}`),
			'=== END ==='
		].join('\n');

		const outcome = await this.generate(prompt, apiKey);
		if (!outcome.ok) return outcome;

		const data = this.parseJson(outcome.text);
		const entries = data && (Array.isArray(data.notes) ? data.notes : Array.isArray(data) ? data : null);
		if (!entries) {
			return {
				ok: false,
				ms: outcome.ms,
				kind: 'format',
				reason: `The answer was not in the expected format: ${outcome.text.slice(0, 120)}`,
				detail: outcome.text
			};
		}

		const results = texts.map((_, i) => {
			const entry = entries.find((e) => e && Number(e.id) === i + 1) || entries[i];
			return entry ? this.cleanSuggestion(entry) : null;
		});
		return { ok: true, ms: outcome.ms, results };
	}

	/** One text-generation call. Resolves to { ok: true, text, ms } or a failure. */
	async generate(prompt, apiKey) {
		switch (this.getProviderKey()) {
			case 'claude':
				return this.generateClaude(prompt, apiKey);
			case 'openai':
				return this.generateOpenAI(prompt, apiKey);
			default:
				return this.generateGemini(prompt, apiKey);
		}
	}

	async generateGemini(prompt, apiKey) {
		const outcome = await this.apiRequest(`models/${encodeURIComponent(this.getModel())}:generateContent`, apiKey, 'POST', {
			contents: [{ role: 'user', parts: [{ text: prompt }] }],
			generationConfig: { responseMimeType: 'application/json' }
		});
		if (!outcome.ok) return outcome;

		const data = outcome.data;
		const candidate = data && data.candidates && data.candidates[0];
		if (!candidate) {
			const blocked = data && data.promptFeedback && data.promptFeedback.blockReason;
			return this.emptyReply(outcome, blocked ? `Gemini refused the text (${blocked}).` : 'Gemini returned no answer.', data);
		}

		// Skip "thought" parts some models return alongside the answer.
		const parts = (candidate.content && candidate.content.parts) || [];
		const text = parts
			.filter((p) => !p.thought)
			.map((p) => p.text || '')
			.join('');
		if (!text.trim()) {
			return this.emptyReply(outcome, `Gemini returned an empty answer (finishReason: ${candidate.finishReason || 'unknown'}).`, data);
		}
		return { ok: true, ms: outcome.ms, text };
	}

	async generateClaude(prompt, apiKey) {
		const body = {
			model: this.getModel(),
			max_tokens: 16000,
			// Low effort keeps simple extraction fast and cheap on models that
			// support it; models that do not are retried without it below.
			output_config: { effort: 'low' },
			messages: [{ role: 'user', content: prompt }]
		};
		let outcome = await this.apiRequest('messages', apiKey, 'POST', body);
		if (!outcome.ok && outcome.status === 400 && /effort|output_config/i.test(JSON.stringify(outcome.detail || ''))) {
			delete body.output_config;
			outcome = await this.apiRequest('messages', apiKey, 'POST', body);
		}
		if (!outcome.ok) return outcome;

		const data = outcome.data || {};
		if (data.stop_reason === 'refusal') {
			return this.emptyReply(outcome, 'Claude declined to process this text (refusal).', data);
		}
		// Only "text" blocks carry the answer; skip "thinking" blocks.
		const text = (data.content || [])
			.filter((b) => b.type === 'text')
			.map((b) => b.text || '')
			.join('');
		if (!text.trim()) {
			return this.emptyReply(outcome, `Claude returned an empty answer (stop_reason: ${data.stop_reason || 'unknown'}).`, data);
		}
		return { ok: true, ms: outcome.ms, text };
	}

	async generateOpenAI(prompt, apiKey) {
		const body = {
			model: this.getModel(),
			messages: [{ role: 'user', content: prompt }],
			response_format: { type: 'json_object' }
		};
		let outcome = await this.apiRequest('chat/completions', apiKey, 'POST', body);
		if (!outcome.ok && outcome.status === 400 && /response_format/i.test(JSON.stringify(outcome.detail || ''))) {
			delete body.response_format;
			outcome = await this.apiRequest('chat/completions', apiKey, 'POST', body);
		}
		if (!outcome.ok) return outcome;

		const choice = outcome.data && outcome.data.choices && outcome.data.choices[0];
		const messageObj = (choice && choice.message) || {};
		if (messageObj.refusal) {
			return this.emptyReply(outcome, `OpenAI declined to process this text: ${messageObj.refusal}`, outcome.data);
		}
		const text = messageObj.content || '';
		if (!text.trim()) {
			return this.emptyReply(outcome, `OpenAI returned an empty answer (finish_reason: ${(choice && choice.finish_reason) || 'unknown'}).`, outcome.data);
		}
		return { ok: true, ms: outcome.ms, text };
	}

	emptyReply(outcome, reason, detail) {
		return { ok: false, ms: outcome.ms, kind: 'empty', reason, detail };
	}

	parseJson(raw) {
		const jsonText = raw.replace(/^[\s\S]*?([[{][\s\S]*[\]}])[\s\S]*$/, '$1');
		try {
			return JSON.parse(jsonText);
		} catch (err) {
			return null;
		}
	}

	cleanSuggestion(entry) {
		let title = typeof entry.title === 'string' ? entry.title : '';
		title = title
			.replace(/["“”'`*_[\]]/g, '')
			.replace(/[.!?:;,]+$/, '')
			.trim()
			.split(/\s+/)
			.slice(0, 5)
			.join(' ');

		const links = (Array.isArray(entry.links) ? entry.links : [])
			.filter((t) => typeof t === 'string')
			.map((t) => t.replace(/[[\]|#^]/g, '').trim())
			.filter((t) => t.length > 0)
			.slice(0, MAX_AI_LINKS);

		return { title: title || null, links };
	}

	/** Text models this key can use. Resolves to { ok: true, models } or a failure. */
	async listModels(apiKey) {
		const models = [];
		const key = this.getProviderKey();
		let pageToken = '';

		for (let page = 0; page < 10; page++) {
			let path;
			if (key === 'gemini') path = `models?pageSize=1000${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`;
			else if (key === 'claude') path = `models?limit=1000${pageToken ? `&after_id=${encodeURIComponent(pageToken)}` : ''}`;
			else path = 'models';

			const outcome = await this.apiRequest(path, apiKey, 'GET');
			if (!outcome.ok) return outcome;
			const data = outcome.data || {};

			if (key === 'gemini') {
				for (const m of data.models || []) {
					const id = (m.name || '').replace(/^models\//, '');
					if (id.startsWith('gemini') && (m.supportedGenerationMethods || []).includes('generateContent')) models.push(id);
				}
				pageToken = data.nextPageToken;
			} else if (key === 'claude') {
				for (const m of data.data || []) if (m.id) models.push(m.id);
				pageToken = data.has_more ? data.last_id : '';
			} else {
				for (const m of data.data || []) {
					const id = m.id || '';
					if (/^(gpt|o\d|chatgpt)/.test(id) && !/audio|realtime|transcribe|tts|image|search|embedding|moderation|dall-e|whisper/.test(id)) {
						models.push(id);
					}
				}
				pageToken = '';
			}
			if (!pageToken) break;
		}
		return { ok: true, models: Array.from(new Set(models)).sort() };
	}

	/** Checks that the selected model exists and can generate text. */
	async checkModel(apiKey) {
		const key = this.getProviderKey();
		const model = this.getModel();
		const info = await this.apiRequest(`models/${encodeURIComponent(model)}`, apiKey, 'GET');
		if (!info.ok) {
			const reason = info.kind === 'model-not-found' ? `Model "${model}" does not exist or is not available to this key.` : info.reason;
			return { ok: false, reason };
		}
		const data = info.data || {};
		if (key === 'gemini') {
			const methods = data.supportedGenerationMethods || [];
			if (methods.length && !methods.includes('generateContent')) {
				return { ok: false, reason: `Model "${model}" exists but does not support text generation (generateContent).` };
			}
		}
		return { ok: true, name: data.displayName || data.display_name || data.id || model };
	}

	// ------------------------------------------------------------------
	// Diagnostics
	// ------------------------------------------------------------------

	/**
	 * Quick key check. Lists the models the key can use, which confirms the
	 * key without spending any generation quota or credit.
	 */
	async testApiKey() {
		const provider = this.getProvider();
		const apiKey = this.getApiKey();
		let ok = false;
		let message;

		if (!apiKey) {
			message = `No ${provider.name} API key saved. Paste your key in settings.`;
		} else {
			const online = await this.checkOnline();
			if (!online.ok) {
				message = `Cannot test the key: ${online.reason}.`;
			} else {
				const listed = await this.listModels(apiKey);
				if (!listed.ok) {
					message = listed.reason;
				} else {
					this.getProviderSettings().availableModels = listed.models;
					const model = this.getModel();
					if (listed.models.length && !listed.models.includes(model)) {
						message = `The ${provider.name} API key is valid, but model "${model}" is not available. Pick another model in settings.`;
					} else {
						ok = true;
						message = `${provider.name} API key is valid and connected successfully (model: ${model}).`;
					}
				}
			}
		}

		await this.setLastCheck(ok, message);
		new Notice(`${ok ? '✓' : '✗'} ${message}`, 12000);
		return { ok, message };
	}

	openDiagnostics() {
		new DiagnosticsModal(this.app, this).open();
	}

	/**
	 * Full check, step by step. onStep(step) is called as each step
	 * finishes, so the dialog fills in live. Each step is
	 * { name, status: 'pass' | 'fail' | 'warn' | 'skip', detail }.
	 */
	async runDiagnostics(onStep) {
		const steps = [];
		const add = (name, status, detail) => {
			const step = { name, status, detail };
			steps.push(step);
			onStep(step);
			return step;
		};
		const skipRest = (names) => names.forEach((n) => add(n, 'skip', 'Skipped because an earlier step failed.'));

		const provider = this.getProvider();
		const apiKey = this.getApiKey();
		const later = ['API key valid', 'Model available', 'Generation, quota and billing', 'Reply format', 'Speed'];
		const service = `${provider.name} service reachable`;

		// 1. Internet
		if (typeof navigator !== 'undefined' && navigator.onLine === false) {
			add('Internet connection', 'fail', 'This device reports no internet connection. Offline rules will be used.');
			skipRest([service, 'API key present', ...later]);
			return this.finishDiagnostics(steps);
		}
		add('Internet connection', 'pass', 'This device is online.');

		// 2. Service reachable
		const online = await this.checkOnline();
		if (!online.ok) {
			add(service, 'fail', `${online.reason.charAt(0).toUpperCase()}${online.reason.slice(1)}.`);
			skipRest(['API key present', ...later]);
			return this.finishDiagnostics(steps);
		}
		add(service, 'pass', this.getBaseUrl());

		// 3. Key present
		if (!apiKey) {
			add('API key present', 'fail', `No ${provider.name} API key saved. Paste your key in settings (get one from ${provider.keyHelp}).`);
			skipRest(later);
			return this.finishDiagnostics(steps);
		}
		add('API key present', 'pass', `${apiKey.length} characters, ending …${apiKey.slice(-4)}.`);

		// 4. Key valid (listing models spends no quota or credit)
		const listed = await this.listModels(apiKey);
		if (!listed.ok) {
			add('API key valid', 'fail', listed.reason);
			skipRest(later.slice(1));
			return this.finishDiagnostics(steps);
		}
		this.getProviderSettings().availableModels = listed.models;
		add('API key valid', 'pass', `Key accepted. ${listed.models.length} model(s) available to it.`);

		// 5. Model available
		const model = await this.checkModel(apiKey);
		if (!model.ok) {
			add('Model available', 'fail', model.reason);
			skipRest(later.slice(2));
			return this.finishDiagnostics(steps);
		}
		add('Model available', 'pass', `${model.name} (${this.getModel()}).`);

		// 6. Generation request (uses one request of quota or credit)
		const outcome = await this.askBatch(
			[
				'Galen of Pergamon believed that blood was produced in the liver and consumed by the organs. William Harvey later showed that blood circulates.'
			],
			apiKey
		);
		if (!outcome.ok && outcome.kind !== 'format') {
			add('Generation, quota and billing', 'fail', outcome.reason);
			skipRest(later.slice(3));
			return this.finishDiagnostics(steps);
		}
		add('Generation, quota and billing', 'pass', 'Test request accepted; quota and billing are fine for now.');

		// 7. Reply format
		const suggestion = outcome.ok && outcome.results[0];
		if (!suggestion) {
			add('Reply format', 'fail', outcome.reason || 'The AI replied, but the plugin could not read the answer.');
		} else {
			add('Reply format', 'pass', `Title: ${suggestion.title || '(none)'}. Links: ${suggestion.links.join(', ') || '(none)'}.`);
		}

		// 8. Speed
		const timeout = this.getTimeoutMs();
		const seconds = (outcome.ms / 1000).toFixed(1);
		if (outcome.ms > timeout * 0.6) {
			add('Speed', 'warn', `Reply took ${seconds}s, close to the ${timeout / 1000}s timeout. Long notes may time out; consider a longer timeout.`);
		} else {
			add('Speed', 'pass', `Reply took ${seconds}s (timeout ${timeout / 1000}s).`);
		}

		return this.finishDiagnostics(steps);
	}

	async finishDiagnostics(steps) {
		const failed = steps.find((s) => s.status === 'fail');
		const message = failed ? `${failed.name}: ${failed.detail}` : `All ${this.getProvider().name} checks passed.`;
		await this.setLastCheck(!failed, message);
		return steps;
	}

	/** One-line summary of what the AI did in this run, shown after the run. */
	describeAiReport(report) {
		const name = report.provider || 'AI';
		switch (report.state) {
			case 'off':
				return `AI: not used (no ${name} API key in settings).`;
			case 'offline':
				return `Offline mode: ${name} unavailable (${report.reason}); offline rules used.`;
			case 'failed':
				return `${name}: failed, offline rules used.\n${report.reason}`;
			default:
				return report.succeeded === report.total
					? `${name}: used for all ${report.total} block(s).`
					: `${name}: used for ${report.succeeded} of ${report.total} block(s); offline rules for the rest.\n${report.reason}`;
		}
	}

	withTimeout(promise, ms) {
		return new Promise((resolve, reject) => {
			const timer = window.setTimeout(() => reject(new Error('timeout')), ms);
			promise.then(
				(value) => {
					window.clearTimeout(timer);
					resolve(value);
				},
				(err) => {
					window.clearTimeout(timer);
					reject(err);
				}
			);
		});
	}
};

class DestinationModal extends Modal {
	constructor(app, defaultKey, onResult) {
		super(app);
		this.selected = DESTINATIONS[defaultKey] ? defaultKey : 'atomic';
		this.onResult = onResult;
		this.confirmed = false;
		this.radios = {};
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		this.setTitle ? this.setTitle('Create Atomic or Glossary Note') : contentEl.createEl('h3', { text: 'Create Atomic or Glossary Note' });

		const options = contentEl.createDiv();
		for (const [key, dest] of Object.entries(DESTINATIONS)) {
			const label = options.createEl('label');
			label.style.display = 'block';
			label.style.margin = '0.4em 0';
			const radio = label.createEl('input', { type: 'radio' });
			radio.name = 'atomic-notes-destination';
			radio.value = key;
			radio.checked = key === this.selected;
			radio.style.marginRight = '0.5em';
			radio.addEventListener('change', () => {
				if (radio.checked) this.selected = key;
			});
			this.radios[key] = radio;
			label.appendText(`${dest.label} → ${dest.folder}/`);
			label.createEl('kbd', { text: dest.key.toUpperCase() }).style.marginLeft = '0.6em';
		}

		const hint = contentEl.createEl('div', { text: 'Press A or G to create at once, Enter to confirm, Esc to cancel.' });
		hint.style.fontSize = 'var(--font-ui-smaller)';
		hint.style.color = 'var(--text-muted)';

		new Setting(contentEl)
			.addButton((btn) => btn.setButtonText('Cancel').onClick(() => this.close()))
			.addButton((btn) =>
				btn
					.setButtonText('Create')
					.setCta()
					.onClick(() => this.confirm())
			);

		this.scope.register([], 'Enter', (evt) => {
			evt.preventDefault();
			this.confirm();
			return false;
		});
		for (const [key, dest] of Object.entries(DESTINATIONS)) {
			this.scope.register([], dest.key, (evt) => {
				evt.preventDefault();
				this.selected = key;
				this.radios[key].checked = true;
				this.confirm();
				return false;
			});
		}
	}

	confirm() {
		this.confirmed = true;
		this.close();
	}

	onClose() {
		this.contentEl.empty();
		this.onResult(this.confirmed ? this.selected : null);
	}
}

const STEP_ICONS = { pass: '✓', fail: '✗', warn: '⚠', skip: '–' };
const STEP_COLOURS = { pass: 'var(--color-green)', fail: 'var(--color-red)', warn: 'var(--color-orange)', skip: 'var(--text-faint)' };

class DiagnosticsModal extends Modal {
	constructor(app, plugin) {
		super(app);
		this.plugin = plugin;
		this.steps = [];
	}

	async onOpen() {
		const { contentEl } = this;
		const title = `${this.plugin.getProvider().name} diagnostics`;
		contentEl.empty();
		this.setTitle ? this.setTitle(title) : contentEl.createEl('h3', { text: title });

		contentEl.createEl('div', {
			text: `Model: ${this.plugin.getModel()} · Endpoint: ${this.plugin.getBaseUrl()}`
		}).style.color = 'var(--text-muted)';

		const list = contentEl.createDiv();
		list.style.margin = '0.8em 0';
		const running = contentEl.createEl('div', { text: 'Running checks…' });

		const buttons = new Setting(contentEl);
		buttons.addButton((btn) =>
			btn.setButtonText('Copy report').onClick(async () => {
				await navigator.clipboard.writeText(this.reportText());
				new Notice('Diagnostics report copied.');
			})
		);
		buttons.addButton((btn) => btn.setButtonText('Close').setCta().onClick(() => this.close()));

		await this.plugin.runDiagnostics((step) => {
			this.steps.push(step);
			const row = list.createDiv();
			row.style.margin = '0.35em 0';
			const icon = row.createEl('span', { text: `${STEP_ICONS[step.status]} ` });
			icon.style.color = STEP_COLOURS[step.status];
			icon.style.fontWeight = 'bold';
			row.createEl('strong', { text: step.name });
			const detail = row.createDiv({ text: step.detail });
			detail.style.marginLeft = '1.4em';
			detail.style.fontSize = 'var(--font-ui-small)';
			detail.style.color = step.status === 'fail' ? 'var(--text-normal)' : 'var(--text-muted)';
			detail.style.userSelect = 'text';
		});

		const name = this.plugin.getProvider().name;
		const failed = this.steps.some((s) => s.status === 'fail');
		running.setText(failed ? `${name} is not working. See the first ✗ above.` : `${name} is ready.`);
		running.style.fontWeight = 'bold';
	}

	reportText() {
		const lines = [
			`${this.plugin.getProvider().name} diagnostics`,
			`Model: ${this.plugin.getModel()}`,
			`Endpoint: ${this.plugin.getBaseUrl()}`,
			`Time: ${new Date().toISOString()}`,
			''
		];
		for (const s of this.steps) lines.push(`${STEP_ICONS[s.status]} ${s.name}: ${s.detail}`);
		return lines.join('\n');
	}

	onClose() {
		this.contentEl.empty();
	}
}

class AtomicGlossarySettingTab extends PluginSettingTab {
	constructor(app, plugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display() {
		const { containerEl } = this;
		const plugin = this.plugin;
		const settings = plugin.settings;
		const provider = plugin.getProvider();
		const ps = plugin.getProviderSettings();
		containerEl.empty();

		containerEl.createEl('h2', { text: 'Atomic & Glossary Note Creator settings' });

		new Setting(containerEl)
			.setName('AI provider')
			.setDesc('Which AI suggests titles and See Also links. Each provider keeps its own key and model. Without a key, the offline rules are used.')
			.addDropdown((dropdown) => {
				for (const [key, p] of Object.entries(PROVIDERS)) dropdown.addOption(key, p.label);
				dropdown.setValue(plugin.getProviderKey()).onChange(async (value) => {
					settings.provider = value;
					await plugin.saveSettings();
					this.display();
				});
			});

		this.renderStatus(containerEl);

		containerEl.createEl('h3', { text: `${provider.name} connection` });

		new Setting(containerEl)
			.setName(`${provider.name} API key`)
			.setDesc(`Get a key from ${provider.keyHelp}. ${provider.costNote}`)
			.addText((text) => {
				text.inputEl.type = 'password';
				text
					.setPlaceholder('Paste your API key')
					.setValue(ps.apiKey)
					.onChange(async (value) => {
						ps.apiKey = value.trim();
						ps.lastCheck = null;
						await plugin.saveSettings();
					});
			})
			.addButton((btn) =>
				btn.setButtonText('Test API key').onClick(async () => {
					btn.setDisabled(true).setButtonText('Testing…');
					await plugin.testApiKey();
					this.display();
				})
			);

		const model = plugin.getModel();
		const known = ps.availableModels || [];
		new Setting(containerEl)
			.setName('Model')
			.setDesc(
				known.length
					? 'Models available to your key. Refresh to update the list.'
					: 'Click Refresh to load the models available to your key, or type a model name below.'
			)
			.addDropdown((dropdown) => {
				const options = known.includes(model) ? known : [model, ...known];
				options.forEach((m) => dropdown.addOption(m, m === provider.defaultModel ? `${m} (default)` : m));
				dropdown.setValue(model).onChange(async (value) => {
					ps.model = value;
					ps.lastCheck = null;
					await plugin.saveSettings();
					this.display();
				});
			})
			.addExtraButton((btn) =>
				btn
					.setIcon('refresh-cw')
					.setTooltip('Refresh available models')
					.onClick(async () => {
						const apiKey = plugin.getApiKey();
						if (!apiKey) {
							new Notice('Enter an API key first.');
							return;
						}
						const listed = await plugin.listModels(apiKey);
						if (!listed.ok) {
							new Notice(`Could not load models: ${listed.reason}`, 12000);
							return;
						}
						ps.availableModels = listed.models;
						await plugin.saveSettings();
						new Notice(`Found ${listed.models.length} ${provider.name} model(s).`);
						this.display();
					})
			);

		new Setting(containerEl)
			.setName('Model name (manual)')
			.setDesc(`Type a model name here if it is not in the list, e.g. ${provider.defaultModel}.`)
			.addText((text) =>
				text.setValue(model).onChange(async (value) => {
					ps.model = value.trim();
					ps.lastCheck = null;
					await plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName('API endpoint')
			.setDesc(`Base address of the ${provider.name} API. Change only if the provider moves its API or you use a proxy.`)
			.addText((text) =>
				text
					.setPlaceholder(provider.defaultBaseUrl)
					.setValue(ps.baseUrl || provider.defaultBaseUrl)
					.onChange(async (value) => {
						ps.baseUrl = value.trim();
						ps.lastCheck = null;
						await plugin.saveSettings();
					})
			)
			.addExtraButton((btn) =>
				btn
					.setIcon('rotate-ccw')
					.setTooltip('Restore default')
					.onClick(async () => {
						ps.baseUrl = '';
						await plugin.saveSettings();
						this.display();
					})
			);

		containerEl.createEl('h3', { text: 'Diagnostics' });

		new Setting(containerEl)
			.setName(`Run ${provider.name} diagnostics`)
			.setDesc('Checks internet, service, key, model, quota and billing, reply format and speed, and shows the exact error for any failure.')
			.addButton((btn) => btn.setButtonText('Run diagnostics').onClick(() => plugin.openDiagnostics()));

		containerEl.createEl('h3', { text: 'General' });

		new Setting(containerEl)
			.setName('Timeout (seconds)')
			.setDesc('How long to wait for the AI before falling back to the offline rules.')
			.addText((text) => {
				text.inputEl.type = 'number';
				text.inputEl.min = '1';
				text.setValue(String(settings.timeoutSeconds)).onChange(async (value) => {
					const n = Number(value);
					if (Number.isFinite(n) && n > 0) {
						settings.timeoutSeconds = n;
						await plugin.saveSettings();
					}
				});
			});

		new Setting(containerEl)
			.setName('Show AI status after each run')
			.setDesc('Adds a line to the end-of-run notice saying whether the AI was used, and why not if it was not.')
			.addToggle((toggle) =>
				toggle.setValue(settings.showAiStatus).onChange(async (value) => {
					settings.showAiStatus = value;
					await plugin.saveSettings();
				})
			);
	}

	/** Connection-status indicator from the last test, diagnostics or run. */
	renderStatus(containerEl) {
		const plugin = this.plugin;
		const check = plugin.getProviderSettings().lastCheck;
		const name = plugin.getProvider().name;
		const box = containerEl.createDiv();
		box.style.padding = '0.6em 0.8em';
		box.style.margin = '0.5em 0 1em';
		box.style.borderRadius = '6px';
		box.style.background = 'var(--background-secondary)';

		const dot = box.createEl('span', { text: '● ' });
		let label;
		if (!plugin.getApiKey()) {
			dot.style.color = 'var(--text-faint)';
			label = `No ${name} API key: offline rules only.`;
		} else if (!check) {
			dot.style.color = 'var(--text-faint)';
			label = `${name}: not tested yet. Click "Test API key" or "Run diagnostics".`;
		} else {
			dot.style.color = check.ok ? 'var(--color-green)' : 'var(--color-red)';
			const when = new Date(check.at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
			label = `${name} ${check.ok ? 'connected' : 'problem'} (${when}): ${check.message}`;
		}
		box.createEl('span', { text: label });
	}
}
