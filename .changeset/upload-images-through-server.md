---
"@mcpjam/inspector": patch
"@mcpjam/sdk": patch
---

Profile pictures and organization logos now upload through the MCPJam backend, which accepts PNG, JPEG, GIF and WebP only and checks the file's own bytes rather than its declared type. The file picker offers only those formats, and a refused file says which formats are accepted.

Widget snapshots captured by the inspector and uploaded by `reportEvalResults` are now stored as plain text instead of `text/html`, so a stored snapshot is never served as a web page. Replays read the same bytes and render as before.
