// Public subpath: the JSON tokenizer, single-sourced so the transcript's
// `JsonView` and the inspector's `JsonEditor` colour a payload from one token
// stream. Pure functions only — no React, no markdown graph — so a consumer
// that wants the tokenizer does not pull the renderer in with it.
export * from "./internal/json-tokens";
