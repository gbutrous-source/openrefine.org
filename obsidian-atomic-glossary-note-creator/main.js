const { Plugin, Notice, Modal, PluginSettingTab, Setting, stringifyYaml, requestUrl } = require('obsidian');

const DEFAULT_SETTINGS = {
	geminiApiKey: '',
	showAiStatus: true
};

const DESTINATIONS = {
	atomic: { label: 'Atomic Notes', folder: 'Atomic Notes', type: 'atomic' },
	glossary: { label: 'Glossary', folder: 'Glossary', type: 'Glossary' }
};

const NEW_NOTE_TAG = '#newatomicnote';
const FORCE_TERMINATOR = '¤¤';

// H2 or H3 only ("##" / "###", not "####"). Trailing closing hashes are dropped.
const H2_H3_REGEX = /^\s{0,3}(#{2,3})(?!#)\s+(.+?)\s*#*\s*$/;
const FENCE_REGEX = /^\s{0,3}(```|~~~)/;
const ILLEGAL_FILENAME_CHARS = /[\\/:*?"<>|#^[\]\u0000-\u001f]/g;
const WINDOWS_RESERVED_NAMES = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;

const GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent';
const GEMINI_TIMEOUT_MS = 5000;
const CONNECTIVITY_TIMEOUT_MS = 3000;
const GEMINI_CONCURRENCY = 4;
const GEMINI_MAX_INPUT_CHARS = 12000;
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
			id: 'create-atomic-note',
			name: 'Create Atomic Note',
			editorCallback: (editor, view) => this.run(editor, view, 'atomic')
		});

		this.addCommand({
			id: 'create-glossary-note',
			name: 'Create Glossary Note',
			editorCallback: (editor, view) => this.run(editor, view, 'glossary')
		});

		this.addCommand({
			id: 'test-gemini-connection',
			name: 'Test Gemini connection',
			callback: () => this.testGemini()
		});

		this.addSettingTab(new AtomicGlossarySettingTab(this.app, this));
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	/**
	 * Entry point for both commands. Asks for the destination, splits the
	 * selection (or the whole note) into blocks, optionally enriches them
	 * with Gemini, then writes one note per block.
	 */
	async run(editor, view, defaultDestination) {
		// Timestamp of command execution, used for untitled blocks.
		const runStarted = new Date();

		const sourceFile = view.file;
		if (!sourceFile) {
			new Notice('Atomic notes: no active file open.');
			return;
		}

		const destinationKey = await this.chooseDestination(defaultDestination);
		if (!destinationKey) return; // Dialog dismissed: cancel silently.
		const destination = DESTINATIONS[destinationKey];

		const selection = editor.getSelection();
		const hasSelection = selection.trim().length > 0;
		const text = hasSelection ? selection : editor.getValue();

		const blocks = this.parseBlocks(text, !hasSelection);
		if (blocks.length === 0) {
			new Notice('No atomic note triggers found.');
			return;
		}

		const { results: aiResults, report: aiReport } = await this.getAiSuggestions(blocks);
		this.assignTitles(blocks, aiResults, runStarted);

		await this.ensureFolder(destination.folder);

		let createdCount = 0;
		for (let i = 0; i < blocks.length; i++) {
			const block = blocks[i];
			const aiLinks = aiResults[i] ? aiResults[i].links : [];
			try {
				await this.createNote(block, aiLinks, sourceFile, destination);
				createdCount++;
			} catch (err) {
				console.error('Atomic notes: failed to create note', block.title, err);
			}
		}

		let summary = `Atomic notes: created ${createdCount} note(s) in "${destination.folder}".`;
		if (this.settings.showAiStatus) summary += `\n${this.describeAiReport(aiReport)}`;
		new Notice(summary, this.settings.showAiStatus ? 10000 : undefined);
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
	 * (before the first trigger, or after a "¤¤") is ignored.
	 */
	parseBlocks(text, skipFrontmatter) {
		let lines = text.split(/\r?\n/);
		if (skipFrontmatter) lines = this.stripFrontmatter(lines);

		const rawBlocks = [];
		let current = null;
		let inFence = false;

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

	async createNote(block, aiLinks, sourceFile, destination) {
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

		const links = this.collectLinks(block, aiLinks);
		if (links.length > 0) {
			noteContent += `\n## See Also\n\n${links.map((l) => `- [[${l}]]`).join('\n')}\n`;
		}

		await this.app.vault.create(path, noteContent);
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

	/**
	 * Tier 2. Returns { results, report }: one { title, links } entry per
	 * block (null where Gemini was unavailable or failed), plus a report of
	 * what happened for the diagnostics notice. Never throws: any failure
	 * leaves the rule-based (Tier 1) behaviour in place.
	 */
	async getAiSuggestions(blocks) {
		const empty = blocks.map(() => null);
		const apiKey = (this.settings.geminiApiKey || '').trim();
		if (!apiKey) return { results: empty, report: { state: 'off', reason: 'no API key in settings' } };

		try {
			const online = await this.checkOnline();
			if (!online.ok) return { results: empty, report: { state: 'offline', reason: online.reason } };

			const outcomes = await this.mapWithConcurrency(blocks, GEMINI_CONCURRENCY, (block) =>
				this.askGemini(block.body, apiKey).catch((err) => ({ ok: false, reason: `unexpected error: ${err.message}` }))
			);
			outcomes.forEach((o, i) => {
				if (!o.ok) console.warn(`Atomic notes: Gemini failed for block ${i + 1}: ${o.reason}`, o.detail || '');
			});

			const results = outcomes.map((o) => (o.ok ? o.result : null));
			const succeeded = outcomes.filter((o) => o.ok).length;
			const firstFailure = outcomes.find((o) => !o.ok);
			return {
				results,
				report: {
					state: succeeded === 0 ? 'failed' : 'used',
					succeeded,
					total: blocks.length,
					reason: firstFailure ? firstFailure.reason : null
				}
			};
		} catch (err) {
			return { results: empty, report: { state: 'failed', reason: `unexpected error: ${err.message}` } };
		}
	}

	async checkOnline() {
		if (typeof navigator !== 'undefined' && navigator.onLine === false) {
			return { ok: false, reason: 'the computer reports no network connection' };
		}
		try {
			await this.withTimeout(
				requestUrl({ url: 'https://generativelanguage.googleapis.com/', method: 'HEAD', throw: false }),
				CONNECTIVITY_TIMEOUT_MS
			);
			return { ok: true };
		} catch (err) {
			const reason =
				err.message === 'timeout'
					? `Google's server did not answer within ${CONNECTIVITY_TIMEOUT_MS / 1000}s`
					: `cannot reach Google's server (${err.message})`;
			return { ok: false, reason };
		}
	}

	/**
	 * Sends one block to Gemini. Resolves to { ok: true, result, ms } or
	 * { ok: false, reason, detail, ms } where reason is a plain-language
	 * explanation for the diagnostics.
	 */
	async askGemini(text, apiKey) {
		const prompt = [
			'You are helping build a Zettelkasten knowledge base in Obsidian.',
			'Read the note text below and reply with JSON only, in exactly this shape:',
			'{"title": "<title>", "links": ["<term>", "<term>"]}',
			'',
			'Rules:',
			'- title: five words or fewer, capturing the central idea of the note. No quotation marks, no final punctuation.',
			`- links: up to ${MAX_AI_LINKS} distinct, semantically relevant topic terms (concepts, people, places, works, disciplines) that would make good titles for related notes. Use canonical noun-phrase forms. No brackets.`,
			'',
			'Note text:',
			'"""',
			text.slice(0, GEMINI_MAX_INPUT_CHARS),
			'"""'
		].join('\n');

		const started = Date.now();
		let response;
		try {
			response = await this.withTimeout(
				requestUrl({
					url: GEMINI_ENDPOINT,
					method: 'POST',
					contentType: 'application/json',
					headers: { 'x-goog-api-key': apiKey },
					body: JSON.stringify({
						contents: [{ role: 'user', parts: [{ text: prompt }] }],
						generationConfig: { responseMimeType: 'application/json' }
					}),
					throw: false
				}),
				GEMINI_TIMEOUT_MS
			);
		} catch (err) {
			const ms = Date.now() - started;
			if (err.message === 'timeout') {
				return { ok: false, ms, reason: `no reply within ${GEMINI_TIMEOUT_MS / 1000}s (timeout)` };
			}
			return { ok: false, ms, reason: `network error (${err.message})` };
		}
		const ms = Date.now() - started;

		let data = null;
		try {
			data = JSON.parse(response.text);
		} catch (err) {
			// Leave data null; handled below.
		}

		if (response.status !== 200) {
			const apiMessage = data && data.error && data.error.message ? data.error.message : (response.text || '').slice(0, 200);
			return { ok: false, ms, reason: `${this.describeHttpStatus(response.status)} — Google says: ${apiMessage}`, detail: data };
		}

		const candidate = data && data.candidates && data.candidates[0];
		if (!candidate) {
			const blocked = data && data.promptFeedback && data.promptFeedback.blockReason;
			return {
				ok: false,
				ms,
				reason: blocked ? `Gemini refused the text (${blocked})` : 'Gemini returned no answer',
				detail: data
			};
		}

		// Skip "thought" parts some models return alongside the answer.
		const parts = (candidate.content && candidate.content.parts) || [];
		const raw = parts
			.filter((p) => !p.thought)
			.map((p) => p.text || '')
			.join('');
		if (!raw.trim()) {
			return { ok: false, ms, reason: `Gemini returned an empty answer (finishReason: ${candidate.finishReason || 'unknown'})`, detail: data };
		}

		const result = this.parseGeminiReply(raw);
		if (!result) {
			return { ok: false, ms, reason: `Gemini's answer was not the expected JSON: ${raw.slice(0, 120)}`, detail: raw };
		}
		return { ok: true, ms, result };
	}

	describeHttpStatus(status) {
		switch (status) {
			case 400:
				return 'HTTP 400: bad request or invalid API key';
			case 401:
			case 403:
				return `HTTP ${status}: API key rejected or Gemini API not enabled for this key`;
			case 404:
				return 'HTTP 404: model not found (check the model name)';
			case 429:
				return 'HTTP 429: quota or rate limit exceeded';
			default:
				return status >= 500 ? `HTTP ${status}: Google server error` : `HTTP ${status}`;
		}
	}

	/**
	 * "Test Gemini connection" command and settings button. Runs every
	 * step with a sample text and shows the result, whether it worked or not.
	 */
	async testGemini() {
		const apiKey = (this.settings.geminiApiKey || '').trim();
		const model = GEMINI_ENDPOINT.replace(/^.*\/models\/([^:]+):.*$/, '$1');
		const lines = [`Gemini test (model: ${model})`];

		if (!apiKey) {
			lines.push('✗ API key: none saved in settings.');
			return this.showDiagnostic(lines);
		}
		lines.push(`✓ API key: saved (${apiKey.length} characters, ends …${apiKey.slice(-4)}).`);

		const online = await this.checkOnline();
		if (!online.ok) {
			lines.push(`✗ Connection: ${online.reason}.`);
			return this.showDiagnostic(lines);
		}
		lines.push("✓ Connection: Google's server is reachable.");

		const notice = new Notice('Gemini test: waiting for reply…', 0);
		const outcome = await this.askGemini(
			'Galen of Pergamon believed that blood was produced in the liver and consumed by the organs. William Harvey later showed that blood circulates.',
			apiKey
		);
		notice.hide();

		if (outcome.ok) {
			lines.push(`✓ Reply in ${(outcome.ms / 1000).toFixed(1)}s.`);
			lines.push(`Title: ${outcome.result.title || '(none)'}`);
			lines.push(`Links: ${outcome.result.links.join(', ') || '(none)'}`);
			if (outcome.ms > GEMINI_TIMEOUT_MS * 0.8) {
				lines.push(`⚠ Close to the ${GEMINI_TIMEOUT_MS / 1000}s limit; longer notes may time out.`);
			}
		} else {
			lines.push(`✗ Gemini: ${outcome.reason}`);
			console.warn('Atomic notes: Gemini test failed', outcome);
		}
		this.showDiagnostic(lines);
	}

	showDiagnostic(lines) {
		console.log(lines.join('\n'));
		new Notice(lines.join('\n'), 20000);
	}

	/** One-line summary of what Gemini did in this run, shown after the run. */
	describeAiReport(report) {
		switch (report.state) {
			case 'off':
				return 'Gemini: not used (no API key in settings).';
			case 'offline':
				return `Gemini: not used (${report.reason}).`;
			case 'failed':
				return `Gemini: failed, offline rules used. Reason: ${report.reason}`;
			default:
				return report.succeeded === report.total
					? `Gemini: used for all ${report.total} block(s).`
					: `Gemini: used for ${report.succeeded} of ${report.total} block(s). Other blocks failed: ${report.reason}`;
		}
	}

	parseGeminiReply(raw) {
		const jsonText = raw.replace(/^[\s\S]*?(\{[\s\S]*\})[\s\S]*$/, '$1');
		let data;
		try {
			data = JSON.parse(jsonText);
		} catch (err) {
			return null;
		}

		let title = typeof data.title === 'string' ? data.title : '';
		title = title
			.replace(/["“”'`*_[\]]/g, '')
			.replace(/[.!?:;,]+$/, '')
			.trim()
			.split(/\s+/)
			.slice(0, 5)
			.join(' ');

		const links = (Array.isArray(data.links) ? data.links : [])
			.filter((t) => typeof t === 'string')
			.map((t) => t.replace(/[[\]|#^]/g, '').trim())
			.filter((t) => t.length > 0)
			.slice(0, MAX_AI_LINKS);

		return { title: title || null, links };
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

	async mapWithConcurrency(items, limit, fn) {
		const results = new Array(items.length).fill(null);
		let next = 0;
		const worker = async () => {
			while (next < items.length) {
				const i = next++;
				results[i] = await fn(items[i], i);
			}
		};
		await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
		return results;
	}
};

class DestinationModal extends Modal {
	constructor(app, defaultKey, onResult) {
		super(app);
		this.selected = defaultKey;
		this.onResult = onResult;
		this.confirmed = false;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		this.setTitle ? this.setTitle('Create notes in') : contentEl.createEl('h3', { text: 'Create notes in' });

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
			label.appendText(dest.label);
		}

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

class AtomicGlossarySettingTab extends PluginSettingTab {
	constructor(app, plugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display() {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl('h2', { text: 'Atomic & Glossary Note Creator settings' });

		new Setting(containerEl)
			.setName('Gemini API key')
			.setDesc(
				'Optional. When set and you are online, Gemini suggests titles for untitled blocks and extra See Also links. Leave empty to work fully offline.'
			)
			.addText((text) => {
				text.inputEl.type = 'password';
				text
					.setPlaceholder('Paste your API key')
					.setValue(this.plugin.settings.geminiApiKey)
					.onChange(async (value) => {
						this.plugin.settings.geminiApiKey = value.trim();
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName('Test Gemini connection')
			.setDesc('Sends a short sample text to Gemini and shows each step: key, connection, and the reply or the exact error.')
			.addButton((btn) => btn.setButtonText('Run test').onClick(() => this.plugin.testGemini()));

		new Setting(containerEl)
			.setName('Show Gemini status after each run')
			.setDesc('Adds a line to the end-of-run notice saying whether Gemini was used, and why not if it was not.')
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.showAiStatus).onChange(async (value) => {
					this.plugin.settings.showAiStatus = value;
					await this.plugin.saveSettings();
				})
			);
	}
}
