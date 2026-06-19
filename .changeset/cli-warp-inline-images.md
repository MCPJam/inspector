---
"@mcpjam/cli": patch
---

Render `eval screenshot` images inline in Warp.

Warp supports the iTerm2 inline-image protocol (OSC 1337) for normal command
output, but its `TERM_PROGRAM=WarpTerminal` wasn't recognized, so `eval
screenshot` fell back to printing the image URL. Warp is now detected and gets
the inline image like iTerm2/WezTerm; piped/non-TTY runs still print the URL.
