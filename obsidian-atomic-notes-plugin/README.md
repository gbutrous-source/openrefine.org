# Atomic Notes from Selection

An Obsidian plugin that turns a selection — or the paragraph around your
cursor — into a new atomic note, opened beside your source note, without
ever touching the source note itself.

## What it does

Run the command **"Make new atomic note"** (Command Palette, or bind it to
a hotkey):

- **If text is selected**, that exact selection is used as the new note's
  content.
- **If nothing is selected**, the plugin captures the paragraph/block
  around the cursor — from the nearest blank line above down to the
  nearest blank line below — and uses that as the content.

Either way, the plugin then:

1. Creates a brand-new note (the source note is never modified).
2. Opens the new note in a split to the right, so the source note stays
   visible.
3. Fills the new note in from the template below.
4. Optionally opens Obsidian's built-in **"Move file to another folder"**
   dialog, so you can file the note into place yourself. The plugin never
   auto-files notes into a folder — that part stays manual, by design.

The cursor/selection in the original note is left exactly as it was.

## File name and title

- By default, both the file name and the `Title` field in the frontmatter
  are a timestamp in `YYYYMMDDHHmmss` format (year, month, day, hour,
  minute, second), e.g. `20260828143205.md`.
- If the captured text contains a level-2 (`## Heading`) or level-3
  (`### Heading`) heading, that heading's text is used instead — with the
  `#` markers stripped — for both the file name and the `Title` field.

## Template

The default template matches:

```
---
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
```

`{{link}}` becomes a wikilink back to the source note, stored as
`Links: "[[Source note name]]"`. It's always wrapped in quotes: an
unquoted `[[...]]` right after `Key:` is YAML flow-sequence syntax (a
nested list), so Obsidian would silently parse it as an array instead of
a link and it would show up as inert, unclickable text. Quoting keeps it
a single string, which Obsidian recognizes and renders as a real,
clickable link. The template is fully
editable from the plugin's settings tab, and supports these placeholders:

| Placeholder   | Replaced with                                   |
|---------------|--------------------------------------------------|
| `{{title}}`   | The derived title (heading text, or timestamp)   |
| `{{content}}` | The captured selection/paragraph                 |
| `{{link}}`    | A `[[wikilink]]` to the source note               |
| `{{date}}`    | The current timestamp (`YYYYMMDDHHmmss`)         |

## Settings

- **Creation folder** — where new notes are created (blank = vault root).
  This is just a starting point; permanent filing is still up to you.
- **Open "move file" dialog after creating** — toggle whether Obsidian's
  core move-file command is triggered automatically right after the note
  is created.
- **Template** — edit the frontmatter/body template used for new notes.

## Installing

### Manual install

1. Build the plugin (see below), or use the `main.js`, `manifest.json`,
   and `styles.css` (if present) already in this folder.
2. Copy this folder into your vault at
   `<Vault>/.obsidian/plugins/atomic-notes-from-selection/`.
3. In Obsidian, go to **Settings → Community plugins**, disable
   **Restricted mode** if needed, and enable **Atomic Notes from
   Selection**.

### Building from source

```bash
npm install
npm run build
```

This produces `main.js` from `main.ts` via esbuild. `npm run dev` runs an
esbuild watcher for iterative development.

## Notes on implementation

- The command only creates a new note — it never edits, deletes, or moves
  text out of the source note.
- The new note is opened via a vertical split to the right
  (`workspace.getLeaf("split", "vertical")`), so the source note stays on
  screen.
- Folder placement is intentionally left manual: the plugin, at most,
  opens the core "move file" dialog for you to complete.
