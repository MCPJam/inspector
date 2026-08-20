---
"@mcpjam/sdk": minor
---

Add `readOpenAIPluginPackage`, which turns a plugin package into gradeable
evidence plus a list of typed portal issues.

The reader borrows `plugin-bundle`'s PRIMITIVES — the `PluginFileSource`
abstraction, path normalisation, the frontmatter splitter, the hashers — and
none of its policy. Reusing `parsePluginBundle` itself would have been wrong
twice over: its issue codes and limits are a persisted backend contract, and it
rejects `.codex-plugin/` outright, which is the location OpenAI documents as
canonical.

The subtle part is that the portal's path rules run against RAW entry names,
before anything normalises them. `normalizeBundlePath` repairs a backslash
separator, a doubled separator and a `.` segment — three of the things the
portal rejects — so checking normalised paths would report a clean package for
an archive that is about to bounce. `OpenAIArchiveObservations` carries the
facts a file source cannot: compressed size, encryption flags, and those raw
names. New collectors supply them (`collectZipArchiveObservations` on the
server, `collectFolderArchiveObservations` on the client, which reads
`webkitRelativePath` before the selection mapping rewrites separators). An
absent observation becomes a recorded gap with a reason, never a silent pass —
a folder source genuinely has no compressed size, and reporting that limit as
satisfied would claim a measurement nobody took.

The reader accepts all three manifest locations and records the normalisation
when it used a non-canonical one, reads skills and their per-skill
`agents/openai.yaml`, decodes asset dimensions, and lists the unsupported
surfaces a package ships (`hooks/`, `commands/`, `.app.json`, …) WITHOUT
judging them — that decision needs the submission mode, and belongs to the
check module.
