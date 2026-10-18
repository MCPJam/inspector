---
name: engineering-writing
description: Write and edit engineering essays, technical blog posts, and leadership newsletters with worked examples, precise claims, and natural prose. Use for editorial writing and removing formulaic AI prose, not routine code comments or API references.
---

# Engineering Writing

Write an original argument a working engineer can examine and use. Preserve the user's perspective and distinctive language. Broad craft lessons from Martin Fowler and practical engineering reporting inform this skill; do not reproduce Fowler's or Gergely Orosz's distinctive voice or perform their personas.

For drafting and substantial revisions, read [Prose examples](references/prose-examples.md). For a narrow copy edit, use the editing pass below; consult the examples if the problem is structural.

## Develop the argument

Identify the reader's question and the answer the piece can support. Infer these from the request where possible. Ask only when a missing answer would change the piece materially. A short essay needs a developed claim, not a survey of everything the author knows. Treat an unspecified one-pager as roughly 450–600 words, not a required template.

Start where the explanation starts: a precise observation, a definition the argument needs, or a small example. Do not automatically invent a failure story or manufacture a hook. Hypotheticals can begin with 'Suppose' or 'Imagine'; do not present them as reported incidents.

Explain enough of the example to make the conclusion checkable. Name the input, behavior, and consequence when they matter. If a refund example depends on distinguishing transactions, show which information permits that distinction. Do not substitute 'the right tool' or 'the correct result' for explaining correctness.

Let each paragraph advance the same argument. Introduce a qualification when it changes a recommendation, rather than appending a ritual caveat. A technical essay should explain the mechanism; a leadership piece should identify the relevant decision, constraint, and people affected. Avoid a compulsory paragraph about business implications.

Maintain stable terms. If 'server', 'client', 'model', and 'agent' refer to different parts, preserve those distinctions. Repeating the accurate noun is better than rotating synonyms.

## Evidence and judgment

Distinguish supplied facts, sourced observations, hypothetical examples, and your recommendations. Never invent experience, interviews, numbers, quotations, or consensus. Do not add numerical detail just to make a sentence sound concrete. First-person judgment is possible when appropriate to the assignment; first-person experience requires the user's evidence.

Verify technical and time-sensitive claims with primary sources. Place links on the specific claims they support, using short descriptive anchor text. Avoid repeatedly ending paragraphs with the same publication's title. Do not borrow a source's authority for your own recommendation, or remove necessary attribution merely to make the page look cleaner.

State uncertainty where the evidence is weak and explain its consequence. Do not sprinkle 'may', 'can', or 'potentially' through supported statements as a substitute for deciding what is true.

## Edit out formulaic prose

These editing rules incorporate the local no-ai-slop skill. The relevant guidance is included here so this skill does not depend on a separate installation. Provenance: `/Users/prathmesh/.claude/skills/no-ai-slop/SKILL.md` and its `eval.md`.

Read the whole draft before changing it. Preserve the user's meaning, useful asides, humor, bluntness, and honest uncertainty. Make the minimum effective edit to existing prose; do not make every paragraph equally polished or short.

- Replace dramatic binaries ('This isn't X. It's Y.'), negative lists, faux-insight claims ('what everyone misses'), colon reveals, and question-and-answer setups with the actual claim. Keep necessary technical distinctions and real questions.
- Remove commentary about the prose itself: 'this is the gap', 'this is central', 'the release question becomes concrete'. Explain the gap or state the decision directly.
- Delete stacked punch lines and repeated sentence scaffolds. Three consecutive 'Perhaps' sentences usually need one sentence that connects causes to consequences. Do not mechanically vary sentence lengths or ban all fragments.
- Replace inflated verbs and nominalizations with ordinary actions. Cut promotional uses of 'leverage', 'empower', 'streamline', 'transformative', 'robust', and 'game changer'. Preserve precise technical terms such as 'evaluation harness', direct quotations, and identifiers.
- Replace vague claims of importance with the relevant fact. Cut trailing clauses such as 'highlighting the importance of' unless they explain a mechanism. Name a source for 'experts agree' or remove it.
- Keep specific details already supported by the draft. Do not turn a concrete failure into 'reliability challenges', or change the author's opinion to make it safer or more balanced.
- Use prose for connected reasoning. Avoid decorative bold, tiny sections, and bullets inserted merely to break up a page. Use punctuation for syntax; avoid clusters of em dashes and dramatic colons.
- Delete a recap or clever final line if it adds no new information. End at the last useful consequence, limitation, or action. Do not replace a weak kicker with a more polished slogan.

## Final read

Check the actual sentences, not a numerical 'human' score:

1. Can the reader follow how the evidence or example supports the claim? Repair missing reasoning before polishing words.
2. Does each paragraph add a fact, mechanism, consequence, or necessary qualification? Cut portable advice that could appear unchanged in an unrelated essay.
3. Have editing changes preserved the user's claims, details, and recognizable voice? Do not invent evidence or flatten character to satisfy the rules.
4. Are the named formulaic patterns gone without introducing choppy prose or uniform paragraph shapes?
5. Does the final sentence say something the reader still needed to know?

Return the requested writing. For edits, include a brief 'What changed' note unless the user requests only the text. For a detection-only request, quote each problematic line, name the pattern, and suggest a short fix; do not rewrite or claim to determine AI authorship.
