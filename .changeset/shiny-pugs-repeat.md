---
"@mcpjam/inspector": patch
---

Desktop: stop showing an Update button that cannot install anything. When a download is announced and then never lands, the button is retired instead of being left clickable, and a second failure turns it into a "Download update" link to the releases page. A slow download is no longer mistaken for a failed one: the 10-minute update poll gets refused while a download is in flight, on macOS and on Windows, and that refusal is now ignored instead of retiring the download. A download that hangs without ever reporting an error still ends at the "Download update" link rather than at no button at all, and once that link is showing the app stops repeating the "Update failed" toast on every poll.
