---
name: ui-copy
description: Review or write the short copy a user sees in MCPJam (errors, toasts, empty states, tooltips, labels). Names the slop pattern in each string and gives the fix, or rewrites a string so it says what happened and what to do next. Use before a PR adds or changes user-facing text, or when asked to review such text.
---

# UI copy

Copy is the text a person reads in the product: toasts, error messages, empty
states, tooltips, dialog bodies, button labels. CI runs this rubric over every
string a PR adds (`scripts/slop/copy-review.mjs`), so following it here saves a
round trip. The rules adapt Peter Yang's MIT-licensed `no-ai-slop` skill to
copy of five to forty words.

## Two jobs

**Detect.** For each string, name every pattern below that applies, quote the
string, and give the fix in a few words. Do not rewrite unasked. A string with
no pattern is fine as it is; terse labels are not slop.

**Rewrite.** Keep the meaning, the product and server names, and every
`${placeholder}` exactly. Lead with what happened or what to do. Name the next
step when the user can take one. One or two sentences, sentence case, a period
at the end of a sentence, none after a label. No dash of any kind, no
exclamation mark, no emoji. Return only the new copy.

## What good copy does

An error names the blocked action and a supported next step, in words the user
already knows. "Your profile picture could not be updated. Try uploading it
again." A confirmation says what will happen: "Delete 3 runs? This cannot be
undone." An empty state says what belongs here and how to start. A success
toast says what is now true: "Server saved." Nothing else.

## Patterns, with the fix

| Pattern | Looks like | Fix |
| --- | --- | --- |
| `vague-error` | "Something went wrong", "An unexpected error occurred", "Unknown error" | Say what failed: "Could not reach the server." |
| `no-next-step` | "Failed to save." | Add what the user can do: "Could not save. Check the URL and try again." |
| `apology` | "Oops!", "Sorry, we", "Unfortunately" | Delete the apology, keep the fact. |
| `exclamation` | "Saved successfully!" | "Saved." |
| `success-noise` | "Successfully", "has been successfully" | State what is true now: "Server added." |
| `dash` | an em or en dash joining two clauses | A period, a comma or a colon. |
| `filler-word` | leverage, seamless, robust, effortless, empower, streamline, simply, just | Delete it or say the concrete thing. |
| `hedge` | "may", "might", "possibly", "it seems" where the app knows | State the fact the code knows. |
| `explains-too-much` | a paragraph that explains the mechanism before saying what to do | Cut to what happened and the next step; move the mechanism to a tooltip or docs. |
| `jargon-leak` | stack traces, HTTP codes, internal names (Convex, mutation, payload, null) | Translate to the user's action and object. |
| `binary-contrast` | "This isn't an error, it's a warning." | Say the second half. |
| `colon-reveal` | "The fix: reconnect." | A plain sentence. |
| `throat-clearing` | "Please note that", "It looks like", "Note:" | Start at the fact. |
| `condescension` | "Don't worry", "Simply", "Just", "Easy" | Delete it. |
| `inconsistent-term` | server / connection / endpoint for the same thing | Use the term the rest of the screen uses. |

## Not slop

Terse labels ("Save changes", "Tools"), technical nouns the user typed or chose
(server names, tool names, MCP terms such as "resource template"), numbers and
units, and quoted values. A `${placeholder}` is opaque: judge the words around
it.
