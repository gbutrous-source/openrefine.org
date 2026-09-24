const { Plugin, Notice, Modal, PluginSettingTab, Setting, stringifyYaml, requestUrl } = require('obsidian');

const DEFAULT_MODEL = 'gemini-3.5-flash-lite';
const DEFAULT_API_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

const DEFAULT_SETTINGS = {
	geminiApiKey: '',
	model: DEFAULT_MODEL,
	apiBaseUrl: DEFAULT_API_BASE_URL,
	timeoutSeconds: 15,
	showAiStatus: true,
	lastDestination: 'atomic',
	availableModels: [],
	// { ok: true|false, message, at } from the last test, diagnostics or run.
	lastCheck: null
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
			id: 'test-gemini-api-key',
			name: 'Test Gemini API key',
			callback: () => this.testApiKey()
		});

		this.addCommand({
			id: 'run-gemini-diagnostics',
			name: 'Run Gemini diagnostics',
			callback: () => this.openDiagnostics()
		});

		this.addSettingTab(new AtomicGlossarySettingTab(this.app, this));
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	async setLastCheck(ok, message) {
		this.settings.lastCheck = { ok, message, at: Date.now() };
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

		const { results: aiResults, report: aiReport } = await this.getAiSuggestions(blocks);
		this.assignTitles(blocks, aiResults, runStarted);

		await this.ensureFolder(destination.folder);

		let createdCount = 0;
		for (let i = 0; i < blocks.length; i++) {
			const block = blocks[i];
			const aiLinks = aiResults[i] ? aiResults[i].links : [];
			try {
				await this.createNote(block, aiLinks, definitions, sourceFile, destination);
				createdCount++;
			} catch (err) {
				console.error('Atomic notes: failed to create note', block.title, err);
			}
		}

		let summary = `Atomic notes: created ${createdCount} note(s) in "${destination.folder}".`;
		if (this.settings.showAiStatus) summary += `\n${this.describeAiReport(aiReport)}`;
		new Notice(summary, this.settings.showAiStatus ? 12000 : undefined);
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
			if (REF_DEF_REGEX.test(line)) continue;

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
			.filter((b) => b.body.length > 0);
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

	async createNote(block, aiLinks, definitions, sourceFile, destination) {
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
						Note_Summary: block.body,
						updated: updated
				  };

		const yaml = stringifyYaml(frontmatter);
		let noteContent = `---\n${yaml}---\n\n${block.body}\n`;

		const cited = this.findCitedDefinitions(block.body, definitions);
		if (cited.length > 0) {
			noteContent += `\n${cited.join('\n')}\n`;
		}

		const links = this.collectLinks(block, aiLinks);
		if (links.length > 0) {
			noteContent += `\n## See Also\n\n${links.map((l) => `- [[${l}]]`).join('\n')}\n`;
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
			const key = `${m[2] ? 'fn' : 'ref'}:${m[3].trim().toLowerCase()}`;
			if (seen.has(key) || !definitions.has(key)) continue;
			seen.add(key);
			found.push(...definitions.get(key));
		}
		return found;
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
	// Gemini (Tier 2)
	// ------------------------------------------------------------------

	getApiKey() {
		return (this.settings.geminiApiKey || '').trim();
	}

	getModel() {
		return (this.settings.model || '').trim().replace(/^models\//, '') || DEFAULT_MODEL;
	}

	getBaseUrl() {
		return ((this.settings.apiBaseUrl || '').trim() || DEFAULT_API_BASE_URL).replace(/\/+$/, '');
	}

	getTimeoutMs() {
		const seconds = Number(this.settings.timeoutSeconds);
		return (Number.isFinite(seconds) && seconds > 0 ? seconds : DEFAULT_SETTINGS.timeoutSeconds) * 1000;
	}

	/**
	 * Returns { results, report }: one { title, links } entry per block
	 * (null where Gemini was unavailable or failed), plus a report of what
	 * happened for the end-of-run notice. Never throws: any failure leaves
	 * the rule-based (Tier 1) behaviour in place.
	 */
	async getAiSuggestions(blocks) {
		const results = blocks.map(() => null);
		const apiKey = this.getApiKey();
		if (!apiKey) return { results, report: { state: 'off' } };

		try {
			const online = await this.checkOnline();
			if (!online.ok) return { results, report: { state: 'offline', reason: online.reason } };

			let failure = null;
			for (const batch of this.makeBatches(blocks)) {
				const outcome = await this.askGeminiBatch(batch.map((i) => blocks[i].body), apiKey);
				if (!outcome.ok) {
					failure = outcome;
					console.warn('Atomic notes: Gemini request failed:', outcome.reason, outcome.detail || '');
					// Once the key or quota is refused, later requests would be too.
					if (['invalid-key', 'permission', 'quota', 'model-not-found'].includes(outcome.kind)) break;
					continue;
				}
				batch.forEach((blockIndex, n) => {
					results[blockIndex] = outcome.results[n] || null;
				});
			}

			const succeeded = results.filter(Boolean).length;
			const report = {
				state: succeeded === 0 ? 'failed' : 'used',
				succeeded,
				total: blocks.length,
				reason: failure ? failure.reason : null
			};
			await this.setLastCheck(succeeded > 0, succeeded > 0 ? 'Last run used Gemini successfully.' : failure.reason);
			return { results, report };
		} catch (err) {
			return { results, report: { state: 'failed', reason: `unexpected error: ${err.message}` } };
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
			return { ok: false, reason: `the API base URL in settings is not a valid address (${this.getBaseUrl()})` };
		}
		try {
			await this.withTimeout(requestUrl({ url: `${origin}/`, method: 'HEAD', throw: false }), CONNECTIVITY_TIMEOUT_MS);
			return { ok: true };
		} catch (err) {
			const reason =
				err.message === 'timeout'
					? `the Gemini service did not answer within ${CONNECTIVITY_TIMEOUT_MS / 1000}s`
					: `cannot reach the Gemini service (${err.message})`;
			return { ok: false, reason };
		}
	}

	/**
	 * Low-level request to the Gemini API. Resolves to
	 * { ok: true, data, ms } or { ok: false, kind, reason, detail, ms }.
	 */
	async geminiRequest(path, apiKey, method, body) {
		const started = Date.now();
		let response;
		try {
			response = await this.withTimeout(
				requestUrl({
					url: `${this.getBaseUrl()}/${path}`,
					method,
					contentType: body ? 'application/json' : undefined,
					headers: { 'x-goog-api-key': apiKey },
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

		if (response.status !== 200) {
			return Object.assign({ ok: false, ms, detail: data || response.text }, this.classifyHttpError(response.status, data, response.text));
		}
		return { ok: true, ms, data };
	}

	/** Turns an HTTP error from Google into { kind, reason } in plain language. */
	classifyHttpError(status, data, text) {
		const error = (data && data.error) || {};
		const message = error.message || (text || '').slice(0, 200) || 'no details';
		const details = Array.isArray(error.details) ? error.details : [];
		const reasons = details.map((d) => d.reason).filter(Boolean);
		const model = this.getModel();

		if (reasons.includes('API_KEY_INVALID') || /api key not valid/i.test(message)) {
			return { kind: 'invalid-key', reason: 'API key is invalid or incorrectly copied. Paste it again from Google AI Studio.' };
		}
		if (/expired/i.test(message)) {
			return { kind: 'invalid-key', reason: 'API key has expired. Create a new key in Google AI Studio.' };
		}
		if (status === 401 || status === 403) {
			return {
				kind: 'permission',
				reason: `API key was refused (HTTP ${status}). The Gemini API may not be enabled for this key's project. Google says: ${message}`
			};
		}
		if (status === 404) {
			return {
				kind: 'model-not-found',
				reason: `The API key works, but model "${model}" is not available. Use "Refresh" next to the model in settings to pick a current one.`
			};
		}
		if (status === 429) {
			return { kind: 'quota', reason: this.describeQuotaError(message, details) };
		}
		if (status >= 500) {
			return { kind: 'server', reason: `Google's Gemini service had an error (HTTP ${status}). Try again later.` };
		}
		if (/billing|FAILED_PRECONDITION/i.test(message) || error.status === 'FAILED_PRECONDITION') {
			return { kind: 'billing', reason: `The API key is valid, but billing needs attention. Google says: ${message}` };
		}
		return { kind: 'bad-request', reason: `Request rejected (HTTP ${status}). Google says: ${message}` };
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
	async askGeminiBatch(texts, apiKey) {
		const prompt = [
			'You are helping build a Zettelkasten knowledge base in Obsidian.',
			`Below are ${texts.length} note(s), each marked with an id.`,
			'For every note, reply with JSON only, in exactly this shape:',
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
				reason: `Gemini's answer was not in the expected format: ${outcome.text.slice(0, 120)}`,
				detail: outcome.text
			};
		}

		const results = texts.map((_, i) => {
			const entry = entries.find((e) => e && Number(e.id) === i + 1) || entries[i];
			return entry ? this.cleanSuggestion(entry) : null;
		});
		return { ok: true, ms: outcome.ms, results };
	}

	/** One generateContent call. Resolves to { ok: true, text, ms } or a failure. */
	async generate(prompt, apiKey) {
		const outcome = await this.geminiRequest(`models/${encodeURIComponent(this.getModel())}:generateContent`, apiKey, 'POST', {
			contents: [{ role: 'user', parts: [{ text: prompt }] }],
			generationConfig: { responseMimeType: 'application/json' }
		});
		if (!outcome.ok) return outcome;

		const data = outcome.data;
		const candidate = data && data.candidates && data.candidates[0];
		if (!candidate) {
			const blocked = data && data.promptFeedback && data.promptFeedback.blockReason;
			return {
				ok: false,
				ms: outcome.ms,
				kind: 'empty',
				reason: blocked ? `Gemini refused the text (${blocked}).` : 'Gemini returned no answer.',
				detail: data
			};
		}

		// Skip "thought" parts some models return alongside the answer.
		const parts = (candidate.content && candidate.content.parts) || [];
		const text = parts
			.filter((p) => !p.thought)
			.map((p) => p.text || '')
			.join('');
		if (!text.trim()) {
			return {
				ok: false,
				ms: outcome.ms,
				kind: 'empty',
				reason: `Gemini returned an empty answer (finishReason: ${candidate.finishReason || 'unknown'}).`,
				detail: data
			};
		}
		return { ok: true, ms: outcome.ms, text };
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

	/** Models this key can use for generateContent, e.g. "gemini-3.5-flash-lite". */
	async listModels(apiKey) {
		const models = [];
		let pageToken = '';
		for (let page = 0; page < 5; page++) {
			const outcome = await this.geminiRequest(
				`models?pageSize=1000${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`,
				apiKey,
				'GET'
			);
			if (!outcome.ok) return outcome;
			for (const m of (outcome.data && outcome.data.models) || []) {
				const methods = m.supportedGenerationMethods || [];
				const id = (m.name || '').replace(/^models\//, '');
				if (id.startsWith('gemini') && methods.includes('generateContent')) models.push(id);
			}
			pageToken = outcome.data && outcome.data.nextPageToken;
			if (!pageToken) break;
		}
		return { ok: true, models: models.sort() };
	}

	// ------------------------------------------------------------------
	// Diagnostics
	// ------------------------------------------------------------------

	/**
	 * Quick key check. Lists the models the key can use, which confirms the
	 * key without spending any generation quota.
	 */
	async testApiKey() {
		const apiKey = this.getApiKey();
		let ok = false;
		let message;

		if (!apiKey) {
			message = 'No API key saved. Paste your Gemini API key in settings.';
		} else {
			const online = await this.checkOnline();
			if (!online.ok) {
				message = `Cannot test the key: ${online.reason}.`;
			} else {
				const listed = await this.listModels(apiKey);
				if (!listed.ok) {
					message = listed.reason;
				} else {
					this.settings.availableModels = listed.models;
					const model = this.getModel();
					if (listed.models.length && !listed.models.includes(model)) {
						message = `The API key is valid, but model "${model}" is not available. Pick another model in settings.`;
					} else {
						ok = true;
						message = `API key is valid and connected successfully (model: ${model}).`;
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

		const apiKey = this.getApiKey();
		const model = this.getModel();
		const later = ['API key valid', 'Model available', 'Generation and quota', 'Reply format', 'Speed'];

		// 1. Internet
		if (typeof navigator !== 'undefined' && navigator.onLine === false) {
			add('Internet connection', 'fail', 'This device reports no internet connection. Offline rules will be used.');
			skipRest(['Gemini service reachable', 'API key present', ...later]);
			return this.finishDiagnostics(steps);
		}
		add('Internet connection', 'pass', 'This device is online.');

		// 2. Service reachable
		const online = await this.checkOnline();
		if (!online.ok) {
			add('Gemini service reachable', 'fail', `${online.reason.charAt(0).toUpperCase()}${online.reason.slice(1)}.`);
			skipRest(['API key present', ...later]);
			return this.finishDiagnostics(steps);
		}
		add('Gemini service reachable', 'pass', this.getBaseUrl());

		// 3. Key present
		if (!apiKey) {
			add('API key present', 'fail', 'No API key saved. Paste your Gemini API key in settings.');
			skipRest(later);
			return this.finishDiagnostics(steps);
		}
		add('API key present', 'pass', `${apiKey.length} characters, ending …${apiKey.slice(-4)}.`);

		// 4. Key valid (listing models spends no generation quota)
		const listed = await this.listModels(apiKey);
		if (!listed.ok) {
			add('API key valid', 'fail', listed.reason);
			skipRest(later.slice(1));
			return this.finishDiagnostics(steps);
		}
		this.settings.availableModels = listed.models;
		add('API key valid', 'pass', `Key accepted. ${listed.models.length} Gemini model(s) available to it.`);

		// 5. Model available and supports generateContent
		const info = await this.geminiRequest(`models/${encodeURIComponent(model)}`, apiKey, 'GET');
		if (!info.ok) {
			add('Model available', 'fail', info.kind === 'model-not-found' ? `Model "${model}" does not exist or is not available to this key.` : info.reason);
			skipRest(later.slice(2));
			return this.finishDiagnostics(steps);
		}
		const methods = (info.data && info.data.supportedGenerationMethods) || [];
		if (methods.length && !methods.includes('generateContent')) {
			add('Model available', 'fail', `Model "${model}" exists but does not support text generation (generateContent).`);
			skipRest(later.slice(2));
			return this.finishDiagnostics(steps);
		}
		add('Model available', 'pass', `${(info.data && info.data.displayName) || model} supports generateContent.`);

		// 6. Generation request (uses one request of quota)
		const outcome = await this.askGeminiBatch(
			[
				'Galen of Pergamon believed that blood was produced in the liver and consumed by the organs. William Harvey later showed that blood circulates.'
			],
			apiKey
		);
		if (!outcome.ok && outcome.kind !== 'format') {
			add('Generation and quota', 'fail', outcome.reason);
			skipRest(later.slice(3));
			return this.finishDiagnostics(steps);
		}
		add('Generation and quota', 'pass', 'Test request accepted; quota and billing are fine for now.');

		// 7. Reply format
		const suggestion = outcome.ok && outcome.results[0];
		if (!suggestion) {
			add('Reply format', 'fail', outcome.reason || 'Gemini replied, but the plugin could not read the answer.');
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
		const message = failed ? `${failed.name}: ${failed.detail}` : 'All Gemini checks passed.';
		await this.setLastCheck(!failed, message);
		return steps;
	}

	/** One-line summary of what Gemini did in this run, shown after the run. */
	describeAiReport(report) {
		switch (report.state) {
			case 'off':
				return 'Gemini: not used (no API key in settings).';
			case 'offline':
				return `Offline mode: Gemini unavailable (${report.reason}); offline rules used.`;
			case 'failed':
				return `Gemini: failed, offline rules used.\n${report.reason}`;
			default:
				return report.succeeded === report.total
					? `Gemini: used for all ${report.total} block(s).`
					: `Gemini: used for ${report.succeeded} of ${report.total} block(s); offline rules for the rest.\n${report.reason}`;
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
		contentEl.empty();
		this.setTitle ? this.setTitle('Gemini diagnostics') : contentEl.createEl('h3', { text: 'Gemini diagnostics' });

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

		const failed = this.steps.some((s) => s.status === 'fail');
		running.setText(failed ? 'Gemini is not working. See the first ✗ above.' : 'Gemini is ready.');
		running.style.fontWeight = 'bold';
	}

	reportText() {
		const lines = [
			'Gemini diagnostics',
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
		const settings = this.plugin.settings;
		containerEl.empty();

		containerEl.createEl('h2', { text: 'Atomic & Glossary Note Creator settings' });

		this.renderStatus(containerEl);

		containerEl.createEl('h3', { text: 'Gemini connection' });

		new Setting(containerEl)
			.setName('Gemini API key')
			.setDesc('Optional. When empty, or when offline, notes are created with the offline rules only.')
			.addText((text) => {
				text.inputEl.type = 'password';
				text
					.setPlaceholder('Paste your API key')
					.setValue(settings.geminiApiKey)
					.onChange(async (value) => {
						settings.geminiApiKey = value.trim();
						settings.lastCheck = null;
						await this.plugin.saveSettings();
					});
			})
			.addButton((btn) =>
				btn.setButtonText('Test API key').onClick(async () => {
					btn.setDisabled(true).setButtonText('Testing…');
					await this.plugin.testApiKey();
					this.display();
				})
			);

		const model = this.plugin.getModel();
		const known = settings.availableModels || [];
		new Setting(containerEl)
			.setName('Model')
			.setDesc(
				known.length
					? 'Models available to your key. Refresh to update the list.'
					: 'Click Refresh to load the models available to your key, or type a model name below.'
			)
			.addDropdown((dropdown) => {
				const options = known.includes(model) ? known : [model, ...known];
				options.forEach((m) => dropdown.addOption(m, m === DEFAULT_MODEL ? `${m} (default)` : m));
				dropdown.setValue(model).onChange(async (value) => {
					settings.model = value;
					settings.lastCheck = null;
					await this.plugin.saveSettings();
					this.display();
				});
			})
			.addExtraButton((btn) =>
				btn
					.setIcon('refresh-cw')
					.setTooltip('Refresh available models')
					.onClick(async () => {
						const apiKey = this.plugin.getApiKey();
						if (!apiKey) {
							new Notice('Enter an API key first.');
							return;
						}
						const listed = await this.plugin.listModels(apiKey);
						if (!listed.ok) {
							new Notice(`Could not load models: ${listed.reason}`, 12000);
							return;
						}
						settings.availableModels = listed.models;
						await this.plugin.saveSettings();
						new Notice(`Found ${listed.models.length} Gemini model(s).`);
						this.display();
					})
			);

		new Setting(containerEl)
			.setName('Model name (manual)')
			.setDesc('Type a model name here if it is not in the list, e.g. gemini-3.5-flash-lite.')
			.addText((text) =>
				text.setValue(model).onChange(async (value) => {
					settings.model = value.trim() || DEFAULT_MODEL;
					settings.lastCheck = null;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName('API endpoint')
			.setDesc('Base address of the Gemini API. Change only if Google moves the API.')
			.addText((text) =>
				text
					.setPlaceholder(DEFAULT_API_BASE_URL)
					.setValue(settings.apiBaseUrl)
					.onChange(async (value) => {
						settings.apiBaseUrl = value.trim() || DEFAULT_API_BASE_URL;
						settings.lastCheck = null;
						await this.plugin.saveSettings();
					})
			)
			.addExtraButton((btn) =>
				btn
					.setIcon('rotate-ccw')
					.setTooltip('Restore default')
					.onClick(async () => {
						settings.apiBaseUrl = DEFAULT_API_BASE_URL;
						await this.plugin.saveSettings();
						this.display();
					})
			);

		new Setting(containerEl)
			.setName('Timeout (seconds)')
			.setDesc('How long to wait for Gemini before falling back to the offline rules.')
			.addText((text) => {
				text.inputEl.type = 'number';
				text.inputEl.min = '1';
				text.setValue(String(settings.timeoutSeconds)).onChange(async (value) => {
					const n = Number(value);
					if (Number.isFinite(n) && n > 0) {
						settings.timeoutSeconds = n;
						await this.plugin.saveSettings();
					}
				});
			});

		containerEl.createEl('h3', { text: 'Diagnostics' });

		new Setting(containerEl)
			.setName('Run Gemini diagnostics')
			.setDesc('Checks internet, service, key, model, quota and billing, reply format and speed, and shows the exact error for any failure.')
			.addButton((btn) => btn.setButtonText('Run diagnostics').onClick(() => this.plugin.openDiagnostics()));

		new Setting(containerEl)
			.setName('Show Gemini status after each run')
			.setDesc('Adds a line to the end-of-run notice saying whether Gemini was used, and why not if it was not.')
			.addToggle((toggle) =>
				toggle.setValue(settings.showAiStatus).onChange(async (value) => {
					settings.showAiStatus = value;
					await this.plugin.saveSettings();
				})
			);
	}

	/** Connection-status indicator from the last test, diagnostics or run. */
	renderStatus(containerEl) {
		const check = this.plugin.settings.lastCheck;
		const box = containerEl.createDiv();
		box.style.padding = '0.6em 0.8em';
		box.style.margin = '0.5em 0 1em';
		box.style.borderRadius = '6px';
		box.style.background = 'var(--background-secondary)';

		const dot = box.createEl('span', { text: '● ' });
		let label;
		if (!this.plugin.getApiKey()) {
			dot.style.color = 'var(--text-faint)';
			label = 'No API key: offline rules only.';
		} else if (!check) {
			dot.style.color = 'var(--text-faint)';
			label = 'Not tested yet. Click "Test API key" or "Run diagnostics".';
		} else {
			dot.style.color = check.ok ? 'var(--color-green)' : 'var(--color-red)';
			const when = new Date(check.at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
			label = `${check.ok ? 'Connected' : 'Problem'} (${when}): ${check.message}`;
		}
		box.createEl('span', { text: label });
	}
}
