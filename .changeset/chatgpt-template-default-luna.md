---
"@mcpjam/inspector": patch
"@mcpjam/sdk": patch
---

Default the ChatGPT host template to GPT-5.6 Luna.

The ChatGPT template pinned `openai/gpt-5-nano`, chosen back when it was the
smallest free GPT-5 variant guests could reach without an OpenAI key. Guests
are no longer model-curated — every hosted model is guest-allowed and the
backend enforces spend caps instead — so the cheapest-reachable constraint no
longer applies, and Luna is the model real ChatGPT actually runs.

The Playground's first-run seed already forced Luna onto its ChatGPT column
via a local override, so those three seeded clients looked right while every
other way of creating a ChatGPT host — the New Host template picker, the home
page's recommended hosts, the Compat tab, the host bar, and the CLI's
`--template chatgpt` — still landed on nano. Moving the value into the
template itself fixes all of them at once, and the now-redundant Playground
override is gone.

The backend host catalog is the runtime source of truth here; this ships the
matching SDK fallback snapshot so offline and cold-start seeds agree with it.
