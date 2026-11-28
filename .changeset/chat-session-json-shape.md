---
"@mcpjam/sdk": minor
"@mcpjam/inspector": patch
---

`get_chat_session` and `send_chat_message` no longer cut long content into a broken JSON string. Shortened message content and tool inputs and outputs keep their JSON type, so a field such as `isError` stays readable: a long string ends in `…[+N chars]`, a long array ends in an `…[+N items]` item, and the new `truncatedFields` lists each cut with its path and reason. A page of messages also stops early to stay under about 96,000 characters, so keep following `nextMessageIndex` to read the rest.
