---
"@mcpjam/sdk": patch
---

Add the UVC acceptance corpus

25 manually reviewed trajectories with two labels per expectation — did the
detector fire correctly, and is that firing a finding a server developer should
see. The harness reports detector errors and misleading firings per check kind;
zero on both is the bar a kind must clear before it can be recommended by
default.
