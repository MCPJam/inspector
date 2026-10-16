---
"@mcpjam/sdk": patch
---

`parsePluginBundle` now finds a key in a server URL, an OpenAI auth endpoint or a `homepage`, `repository` or `author.url` when the key is written in letters only or percent-encoded (`sk%2Dlive…`), and refuses or drops that URL as it does any other URL carrying a key. A docs slug of two or more words is still kept.
