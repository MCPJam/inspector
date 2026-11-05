---
"@mcpjam/inspector": patch
---

Self-hosted and desktop installs now say why a guest session could not be created in their error reports (for example, an untrusted TLS certificate on a network that re-signs HTTPS), and report when the app is still not usable 30 seconds after it opens, naming the step it is stuck on.
