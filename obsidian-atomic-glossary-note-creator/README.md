# Atomic & Glossary Note Creator

Obsidian plugin that turns blocks of the active note into self-contained atomic notes or glossary entries.

## Install

Copy `main.js` and `manifest.json` into `<vault>/.obsidian/plugins/atomic-glossary-note-creator/`, then restart Obsidian and enable the plugin under Settings → Community plugins.

## Use

- Run **Create Atomic or Glossary Note** (assign it one hotkey). A dialog offers **Create atomic note** (`Atomic Notes/`) or **Create glossary note** (`Glossary/`). Press **A** or **G** to create at once; the last choice is remembered.
- A block starts at an `##`/`###` heading or at a line holding only `#newatomicnote`.
- A block ends at `¤¤` alone on a line, the next `##`/`###`, the next `#newatomicnote`, or the end of the selection/document.
- Select text to process only the selection; with no selection the whole note is processed.
- Numbered citations such as `[1][6]` become Obsidian footnotes (`[^1][^6]`) linked to their sources, which appear as a numbered list at the bottom of each note. The source list in the original note may be written as `[1]: https://…`, `[^1]: …`, `[1] Title https://…` or `1. [Title](https://…)`. If the note has no source list, the end-of-run notice says which numbers could not be linked.

## AI (optional)

Choose an **AI provider** in settings: **Gemini** (Google, free tier), **Claude** (Anthropic, paid) or **OpenAI** (paid). Each provider keeps its own API key, model and endpoint, so you can switch back and forth. The AI suggests titles for untitled blocks and extra See Also links; all blocks of a run go in one request. Any failure falls back to the offline rules.

For each provider: API key with **Test API key**, model list with **Refresh**, manual model name, API endpoint, and a connection-status line. Changing provider, key or model never requires editing `main.js`.

## Diagnosing the AI

- **Test AI API key**: confirms the key without using quota or credit.
- **Run AI diagnostics** (command or settings button): checks internet, service, key, model, quota/billing, reply format and speed, with the exact reason for any failure and a **Copy report** button.
- After each run, the notice says whether the AI was used and, if not, why (toggle in settings).
