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

A paragraph is either:

- **A block of text**: any contiguous run of non-blank lines, bounded by a
  blank line or the start/end of the file.
- **A list item**: any line starting with `-` (optionally indented) is
  *also* treated as its own paragraph, independent of the block it sits in.
  This means a single hashtag on one bullet in a long list is captured on
  its own, without pulling in the whole list.

Within a block, every list item is always split out as its own paragraph —
consecutive task/list lines are never glued together into one entry, even
when they sit directly under a heading or each other with no blank line in
between. Any run of plain (non-list) lines around or between list items is
still kept together as its own paragraph, so ordinary prose paragraphs are
unaffected.

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
