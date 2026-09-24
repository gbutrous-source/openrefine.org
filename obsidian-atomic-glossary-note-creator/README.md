# Atomic & Glossary Note Creator

Obsidian plugin that turns blocks of the active note into self-contained atomic notes or glossary entries.

## Install

Copy `main.js` and `manifest.json` into `<vault>/.obsidian/plugins/atomic-glossary-note-creator/`, then enable the plugin under Settings → Community plugins.

## Use

- Run **Create AI Note** (assign it one hotkey). A dialog asks for **Atomic note** (`Atomic Notes/`) or **Glossary entry** (`Glossary/`). Press **A** or **G** to create at once; the last choice is remembered.
- A block starts at an `##`/`###` heading or at a line holding only `#newatomicnote`.
- A block ends at `¤¤` alone on a line, the next `##`/`###`, the next `#newatomicnote`, or the end of the selection/document.
- Select text to process only the selection; with no selection the whole note is processed.
- Citations such as `[2]` or `[^1]` keep working: each new note gets the matching `[2]: https://…` / `[^1]: …` definitions from the source note.

## Gemini (optional)

With an API key and an internet connection, Gemini suggests titles for untitled blocks and extra See Also links. All blocks of a run are sent in one request, so a long note does not use up the free tier's per-minute limit. Any failure falls back to the offline rules.

Settings: API key, **Test API key**, model (with **Refresh** to list the models your key can use, or type a name), API endpoint, timeout, **Run diagnostics**, and a connection-status line. Changing key or model never requires editing `main.js`.

## Diagnosing Gemini

- **Test API key**: confirms the key without using any generation quota.
- **Run Gemini diagnostics** (command or settings button): checks internet, service, key, model, quota/billing, reply format and speed, with the exact reason for any failure and a **Copy report** button.
- After each run, the notice says whether Gemini was used and, if not, why (toggle in settings).
