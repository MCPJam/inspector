---
"@mcpjam/inspector": patch
---

The desktop app now trusts the certificates in your operating system's certificate store, as your browser does. On networks that inspect HTTPS traffic with a company certificate, the app previously stayed on the loading screen at first launch; it now opens normally.
