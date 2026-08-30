---
"@mcpjam/inspector": patch
---

Stop the local Ollama model detection from polling `127.0.0.1:11434` every 30s forever. The probe now backs off while the daemon is unreachable (30s → 1m → 2m → 4m → 8m, capped at 10m, reset on the first success) and pauses entirely while the tab is hidden, resuming with whatever is left of the current delay. Users running Ollama keep the same 30s cadence; users without it no longer get a console full of connection errors they cannot suppress.
