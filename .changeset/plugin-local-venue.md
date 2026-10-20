---
"@mcpjam/inspector": patch
---

A Playground chat whose client you run on this machine now runs your plugins' local stdio servers there too, without the environments UI. If that chat also uses a server only this machine can reach, a model whose key is stored on this machine, or this machine's browser or shell, it still runs without its plugins and says so. Elsewhere, including the hosted app, chats still run remote plugin servers only.
