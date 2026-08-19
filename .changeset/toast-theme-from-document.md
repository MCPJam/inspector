---
"@mcpjam/inspector": patch
---

Keep toast text readable for anyone running the app in light mode on a
dark-mode machine.

The Toaster read its theme from `next-themes`, which nothing in the app
provides. With no provider `useTheme()` fell back to `"system"`, so Sonner
resolved the operating system's setting instead of the app's: on a dark-mode
machine viewing the light app it stamped `data-sonner-theme="dark"` and
coloured the toast description near-white on the white background our own
tokens supplied. The message was there and unreadable.

The theme now comes from the `.dark` class the design system already scopes its
dark tokens under, read through `useSyncExternalStore` with a `MutationObserver`
on the document element so a theme switch updates a visible toast. Server-side
and observer-less environments fall back to light rather than throwing.

The toast description is also pinned to `var(--foreground)` in CSS. Sonner
colours that one element from its own theme rather than from the variables it
is handed, which is what made it the single part of a toast that could come out
light-on-light — pinning it keeps the text readable even if the two themes drift
again.
