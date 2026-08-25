---
"@mcpjam/inspector": patch
---

Fix the connect handoff telling a signed-in owner to sign in, forever.

Opening a `/connect/server/<token>` link while correctly signed in as the
account that created it showed "Sign in to finish connecting" — and clicking
Sign in came straight back to the same screen, with no way out.

`AuthKitProvider` swaps its `getAccessToken` when the client finishes
initializing; before that it is literally
`() => Promise.reject(new LoginRequiredError())`. The page claimed the token on
mount, and `bestEffortAccessToken` cannot tell that rejection from a genuinely
signed-out visitor — they are the same error — so the claim went out with no
bearer, the backend saw an anonymous caller, and refused `SIGN_IN_REQUIRED`.

It looped because signing in succeeds instantly for someone who already has a
session: AuthKit returns to the same URL (the handoff token is only stripped
after a claim succeeds), the page cold-mounts, and hydration races the claim
again. Every cold load of a handoff link is exactly the case that loses that
race, which is every load that matters.

The claim now waits for `useAuth().isLoading` to clear, the same gate the app
shell already applies in two places.
