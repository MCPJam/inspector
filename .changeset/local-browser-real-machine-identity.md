---
"@mcpjam/inspector": patch
---

Stop the local browser from impersonating the hosted sandbox, which is what put a captcha in front of it on most sites.

The local engine reused browserd's hosted launch pins verbatim, so a browser running on a user's own machine claimed to be a GPU-less Linux box in UTC: an `X11; Linux x86_64` UA (with an `MCPJam-Browser/1.0` product token) beside macOS/Windows client hints, SwiftShader WebGL on a machine with a real GPU, and a pinned UTC timezone and `en-US` locale regardless of where the request came from. Bot scoring reads that pile of contradictions as automation.

Launches now declare a surface. The hosted sandbox is unchanged — every pin there is a true statement about the box. A local browser keeps only the observation viewport (the model's coordinate space) and lets Chromium answer with the truth about everything else, correcting just the UA string, via Chromium's own `--user-agent` switch, so headless does not announce `HeadlessChrome` while the real client hints stay intact. The Electron engine's agent partition likewise drops the `Electron/…` and app-name tokens from its UA.
