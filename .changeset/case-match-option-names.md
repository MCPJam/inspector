---
"@mcpjam/inspector": patch
"@mcpjam/sdk": patch
---

Case match options now take the same names everywhere in the v1 eval API. Inline cases on `POST /eval-runs` and `POST /eval-suites`, case create and update, batch case create and suite defaults all accept the public names (`toolCallOrder: any | in-order | exact`, `extraToolCalls`, `arguments`) as well as the internal ones (`ignore | superset | strict`, `maxExtraToolCalls`, `argumentMatching`), the way run-level `matchOptionsOverride` already did. Before, `toolCallOrder: "exact"` worked on a run and was refused on an inline case. A body that mixes the two vocabularies in one object is still a 400, and responses keep returning the public names.
