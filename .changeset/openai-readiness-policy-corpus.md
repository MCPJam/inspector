---
"@mcpjam/sdk": minor
---

Add the OpenAI plugin-directory policy corpus, its drift plumbing, and the typed
portal-error catalog.

`sdk/src/openai-readiness/` now carries the foundations the check lanes will be
built on:

- **`manifest.ts`** pins the documented page set across two hosts. The plugins
  corpus is hashed over each page's `.md` twin rather than its rendered HTML —
  no navigation chrome, no build hash, so the digest moves when the prose moves
  and at no other time. Every entry ships `revision: null` until the sync runs;
  a fabricated hash would make an unaudited corpus look audited.
- **`types.ts`** models seven lanes, the four public submission shapes, and two
  staged rollups. The submission mode is a REQUIRED grading input rather than
  something inferred from which inputs a run happens to hold, and the two stages
  let a run be honestly `ready` at `technical-preflight` while `incomplete` at
  `submission-ready` — which is exactly what a server check with no submission
  profile is.
- **`profile.ts`** holds every host constant exactly once.
- **`portal-errors.ts`** transcribes the documented submission errors as a typed
  catalog whose limits REFERENCE `profile.ts` rather than restating it. Checks
  cite catalog entries; findings group them for presentation only, so a readable
  finding never drops a documented code.

Sync plumbing moves to `scripts/lib/policy-manifest-sync.mjs`, shared by both
publishers. `scripts/sync-claude-policy-manifest.mjs` becomes a thin entry over
it with unchanged behaviour. The OpenAI entry adds a signal the per-page hashes
are blind to: it diffs the live `llms.txt` against the pinned page set, so a
requirement landing on a page nobody pinned is drift even when every pinned page
is byte-identical. A new weekly `openai-policy-drift` workflow runs it
independently of the Claude one, so neither corpus can mask the other.

Note that the corpus ships unsnapshotted: filling `PAGE_REVISIONS` requires
network access to the docs hosts, and the never-fabricate-a-hash rule means the
first `npm run openai-policy:sync` in an environment with that access is what
pins it. Until then `isOpenAIPolicyCorpusVerified()` reports `false` and every
citation carries `revision: null`, so a grade says so about itself.
