# Glossary Refraction

An [Obsidian](https://obsidian.md) plugin that turns `H2`/`H3` headings in a note
into individual glossary notes, each filed into a `glossary` folder with a
structured frontmatter template.

## What it does

Run the command **"Create glossary notes from document or selection"**
(via the command palette, `Ctrl/Cmd+P`):

- If you have text **highlighted**, only that selection is analysed.
- Otherwise, the **entire active note** is analysed.

For every `H2` (`##`) or `H3` (`###`) heading found, the plugin:

1. Creates a new note named after the heading text.
2. Sets the note's `title` frontmatter field to the heading text.
3. Takes the text under that heading (up to the next heading of any level),
   strips inline `#hashtags`, block-reference IDs (`^abc123`) and `{#id}`
   attributes, and writes the cleaned result into the `Note_Summary`
   frontmatter field.
4. Links back to the note it came from via the `Sources` field.
5. Places the new note inside the configured glossary folder (`glossary` by
   default), creating the folder first if it doesn't already exist.

## Note template

Each generated note starts with:

```yaml
---
title: "${heading text}"
aliases:
tags:
  - Glossary
Subjects:
Projects:
Status: draft
Sources: "[[${source note name}]]"
Links:
Note_Summary: "${cleaned heading content}"
---
```

## Settings

- **Glossary folder** — where new notes are filed (default: `glossary`).
- **Default status** — value written to the `Status` field (default: `draft`).

## Development

```bash
npm install
npm run dev     # watch build to main.js
npm run build   # production build
```

To try it in a vault, copy `manifest.json`, `main.js` and (if present)
`styles.css` into `<vault>/.obsidian/plugins/glossary-refraction/`, then
enable "Glossary Refraction" under Settings → Community plugins.

## Author

[Lina Stores](https://www.linastores.co.uk/)
