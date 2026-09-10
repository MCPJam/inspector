---
"@mcpjam/inspector": patch
---

Make the local Electron build and dev run work off a clean checkout: raise the
main-process build's heap ceiling to match CI, pull in a `node-abi` that knows
Electron 43, and keep `ws`'s optional native accelerators out of the bundle.
