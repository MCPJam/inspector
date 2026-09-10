---
"@mcpjam/inspector": patch
---

Share browser viewing and input between Node WebMCP inspection and Playground. Local inspection now follows pane size at DPR 1 and JPEG quality 75, matching Playground; this reduces raster work but trades Retina sharpness compared with the previous supersampled sharp-at-rest view. Preserve double/triple clicks, release physical keys correctly across modifier changes, capture drags beyond the pane, consume wheel input, and release held input on blur. Share viewport reporting and bounded image presentation; retry oversized captures once at lower quality.
