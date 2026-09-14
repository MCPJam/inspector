---
"@mcpjam/design-system": patch
"@mcpjam/inspector": patch
---

Add shadcn/ui's `scroll-fade` Tailwind utilities to the design system, and use `scroll-fade-y` on User Testing's session transcript. Scrolling a tester's chat used to end at a hard edge that cut a message mid-line and said nothing about whether that was the end; the edges now dissolve as you scroll, and each one only paints when there is something to scroll toward. The utilities are vendored CSS rather than the `shadcn` package, and Tailwind emits only the classes that are actually used. The fade is opt-in (`fadeTranscriptEdges`), so the four other surfaces sharing the session detail — both Swarm panels, the Sessions page and the host share-usage dialog — are unchanged.
