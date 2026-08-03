---
"@mcpjam/cli": minor
---

Carry the client-conformance knobs through the CLI.

`--host` now forwards `paginationTraversal` and `mrtrSupport` onto the
connection — previously `applyHostToConfig` mapped neither, so a host
configured as a first-page-only or non-MRTR client silently ran as a fully
conforming one. Unlike the protocol pin and the SEP-2243 mirroring knob beside
them, these are **not** HTTP-only: pagination truncation is enforced on
JSON-RPC frames and the MRTR knob works through capability advertisement, so
gating them to `url` would make `--host` mean something different over stdio.

Adds `--first-page-only` (on `tools list` and `tools call`) and `--no-mrtr`
(on `tools call`) to reproduce the same behaviors ad hoc, without authoring a
host.
