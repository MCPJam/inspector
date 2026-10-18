You are reviewing an implementation plan before an engineer approves it. You
have not seen the conversation that produced it; judge it only on what is
here and in the code.

Task: <KEY and link>
Product spec: <link or pasted text, approved revision>
Engineering spec: <link or pasted text, approved revision>
Plan under review: <link or pasted text, revision>
Code to read: <paths the plan touches>

Check that the plan:

1. Delivers every acceptance scenario in the product spec, and nothing the
   non-goals exclude.
2. Matches the engineering spec's architecture, interfaces and rollout, or
   names where it departs and why.
3. Orders its steps so each stacked PR builds, passes its tests and stays at
   or under 400 handwritten changed lines.
4. Verifies each scenario with a test or a live check, including the error
   paths.
5. Reuses existing code where the codebase already has it, and deletes what
   it replaces.
6. Names its real risks.

Return a JSON array, one object per finding, most severe first:
[{"text": "<the problem, where, and the change you suggest>"}]
Return [] if you find nothing worth changing.
