# Hashtag Paragraph Compiler

An Obsidian plugin that scans your entire vault for paragraphs containing a
given hashtag (e.g. `#idea`, `#questions`) and compiles them into a single
note, with the source file and creation date for each paragraph.

## What it does

1. Run **Compile paragraphs by hashtag** from the Command Palette.
2. Enter a hashtag (`#idea` or just `idea` both work).
3. The plugin scans every markdown file in the vault and finds all
   "paragraphs" that contain that exact hashtag.
4. It writes (or overwrites) `Compilations/Compilation of idea.md`
   (folder name and overwrite/append behavior are configurable in Settings).

## Paragraph definition

Every non-blank line in a file is its own paragraph — `-` list items,
numbered items, and plain one-line entries alike, whether or not blank
lines separate them from their neighbors. This matches an Aegis-style
daily-note workflow where each line is one atomic, taggable thought (e.g.
a stack of `04_27 - [] --- ... #event` lines with no blank lines between
them still compiles as separate entries, one per line), and a heading line
above such a stack is simply its own non-matching paragraph and drops out
of the output on its own.

## Hashtag matching

- Matching is **case-sensitive** as typed (`#Idea` ≠ `#idea`).
- Whole-tag matching only: `#idea` matches `#idea` but not `#ideas` or
  `#idea2`, using the pattern `\B#<tag>\b`.
- The hashtag can appear anywhere in the paragraph.

## Output note

- Location: the configured output folder (default `Compilations/`),
  created automatically if it doesn't exist.
- Filename: `Compilation of <tag>.md`, e.g. `#idea` → `Compilation of idea.md`.
- For each matching paragraph:

  ```
  <paragraph text as-is>
  Source: [[folder/file.md]] • Created: 2024-03-17
  ```

  with a blank line separating entries.
- By default the note is **overwritten** on each run. Enable "Append instead
  of overwrite" in Settings to instead add a new dated section to the
  existing note on each run.
- Files already inside the output folder are excluded from scanning, so
  re-running the command doesn't pick up its own previous output.

## Settings

- **Output folder** — where compilation notes are created (default
  `Compilations`).
- **Append instead of overwrite** — toggle append vs. overwrite behavior.

## Performance

The scan uses `app.vault.getMarkdownFiles()` and `app.vault.cachedRead()`,
processing files sequentially and yielding to the UI thread every 25 files
so large vaults don't freeze the interface.

## Development

```bash
npm install
npm run dev    # watch build
npm run build  # production build (main.js)
```

To try it in a vault, copy (or symlink) this folder — containing
`manifest.json`, `main.js`, and `styles.css` if present — into
`<vault>/.obsidian/plugins/hashtag-paragraph-compiler/`, then enable it
under Settings → Community plugins.
