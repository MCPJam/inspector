# Prose examples and editorial decisions

These are close readings of specific passages, not templates for imitating an author's voice. Use the general explanatory techniques and original wording. Do not copy their cadence, anecdotes, metaphors, or first-person authority.

## Martin Fowler: Technical Debt

Source: [Technical Debt](https://martinfowler.com/bliki/TechnicalDebt.html), 21 May 2019. Locate the opening definition, the module example, and the paragraph about stable code.

Short excerpt: “The two day difference is the interest on the debt.”

The preceding example compares a four-day feature with a six-day feature. The next paragraph introduces a five-day cleanup and asks whether future work repays that cost. Later, Fowler identifies where the analogy fails: untouched code does not incur the same cost merely because time passes.

Editorial lesson: give an abstraction a mechanism the reader can inspect. If an analogy supports a recommendation, specify where it stops supporting it. Hypothetical arithmetic demonstrates reasoning, not measured productivity. Never copy these numbers into a claim about actual teams.

## Martin Fowler: Monolith First

Source: [Monolith First](https://martinfowler.com/bliki/MonolithFirst.html), 3 June 2015. Locate the service-boundary discussion and the final two paragraphs.

Short excerpt: “Although the evidence is sparse”

Fowler ties an architectural recommendation to the difficulty of choosing stable boundaries early. He then considers the counterargument and makes the limits of his anecdotal evidence explicit. The qualification affects how strongly the reader should apply the advice.

Editorial lesson: name the condition behind a recommendation. Replace decorative balance with a circumstance that could change the decision. Never inherit the author's field experience or describe his 2015 observations as current industry data.

## Martin Fowler: Tell Dont Ask

Source: [Tell Dont Ask](https://martinfowler.com/bliki/TellDontAsk.html), 5 September 2013. Locate the opening definition, the monitor code, and the discussion of query methods.

Short excerpt: “Things that are tightly coupled should be in the same component.”

The example moves alarm behavior into a monitor object. Fowler explains the coupling that motivates the move, then discusses how taking the principle too literally can make useful queries harder to express.

Editorial lesson: make a recommendation intelligible before examining its limits. A slogan cannot do the explanatory work of showing which responsibility moves, why it belongs there, and when the move would hurt clarity.

## Repairs from the MCP evaluation essay

The following edits are original examples, not Fowler quotations. New drafting may introduce clearly hypothetical details; editing an existing user's account may not invent them.

### Stacked punch lines

Before: “Every tool worked. The task failed.”

After: “The refund tool accepted a valid transaction ID, but the agent supplied the ID of the charge the customer wanted to keep.”

The revision explains the failure. Use it only when that behavior is established in the scenario; otherwise establish the scenario first.

### Announcing a distinction instead of explaining it

Before: “This is the gap MCP evaluation testing needs to address.”

After: “An evaluation can check which transaction the agent selected by comparing the resulting refund with the transaction specified in the test fixture.”

The revision names an observable check. It earns its space only if the preceding paragraph has not already explained that check.

### Repetitive scaffolding and loose causality

Before: “Perhaps the lookup omitted transaction timestamps. Perhaps an argument named `id` left the agent to infer whether it meant a customer ID or a payment ID.”

After: “Inspect the lookup response first. If it omits the information needed to distinguish the charges, the agent cannot reliably select one. If that information is present, check how the agent mapped the selected charge to the refund argument.”

This turns a list of guesses into a diagnostic sequence. For a short essay, retain only the branch needed by its argument.

### A recap disguised as a conclusion

Before: “That is a stronger basis for shipping than a successful tool call.”

Edit: delete it. If an operational implication is still missing, add that implication in plain prose, such as: “Keep the ambiguous-charge case in the suite when you revise the lookup response.” Only add this sentence if the essay has established why that case matters.

## Using the lessons together

Develop a specific claim, show why it holds, and qualify it only where the qualification changes the reader's decision. Apply the no-ai-slop editing pass without shaving off the explanation. Shorter sentences cannot compensate for an example that leaves the crucial behavior unspecified.
