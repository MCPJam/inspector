---
"@mcpjam/inspector": patch
---

Auto-connect is now a personal, per-device switch. The Servers-tab header switch reads and writes the same `autoConnectServersEnabled` preference the connect hook consults, so OFF actually stops servers from auto-connecting (#4840). Anyone can flip it — it is no longer admin-only — and it no longer enrolls or unenrolls servers on the project. Auto-connect opens every server in the project catalog rather than the active client's stored list, so a newly added server connects on its own.
