# Atomic & Glossary Note Creator

Obsidian plugin that turns blocks of the active note into self-contained atomic or glossary notes.

## Install

Copy `main.js` and `manifest.json` into `<vault>/.obsidian/plugins/atomic-glossary-note-creator/`, then enable the plugin under Settings → Community plugins.

## Use

- **Create Atomic Note** → `Atomic Notes/`, **Create Glossary Note** → `Glossary/` (you can switch in the dialog).
- A block starts at an `##`/`###` heading or at a line holding only `#newatomicnote`.
- A block ends at `¤¤` alone on a line, the next `##`/`###`, the next `#newatomicnote`, or the end of the selection/document.
- Select text to process only the selection; with no selection the whole note is processed.
- Optional: add a Gemini API key in settings for AI titles (untitled blocks) and extra See Also links. Any failure falls back silently to the offline rules.
