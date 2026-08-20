---
"@mcpjam/sdk": minor
---

Add the browser-safe package primitives the OpenAI plugin-package checks need:
image dimensions, `agents/openai.yaml`, listing text, and brand-colour contrast.

`sdk/src/openai-readiness/package/`:

- **`image-dimensions.ts`** decodes PNG, JPEG, WebP and SVG dimensions straight
  from the bytes, because the listing rules are about pixels and every library
  that reads them is Node-only or a native binding — this has to run in a
  browser bundle validating a package before anything is uploaded. Each decoder
  REFUSES with a reason rather than falling back to a default: a plausible guess
  would produce a dimension check that passed on a file whose dimensions were
  never read. JPEG walks marker segments (fill bytes and payload-less standalone
  markers included) rather than reading a fixed offset, and WebP handles all
  three of `VP8 `, `VP8L` and `VP8X`, so alpha and animated icons are not
  silently refused.
- **`openai-agent-metadata.ts`** parses the interface/policy/dependencies
  document with the existing `yaml` dependency. The flat frontmatter parser in
  `plugin-bundle` is deliberately not reused: handed a nested document it does
  not fail, it returns a shape with things missing — which grades as "field
  absent" when the truth is "we could not read it".
- **`supported-text.ts`** finds control characters and the invisible U+2028 /
  U+2029 separators, reporting rather than sanitising: the portal validates what
  was uploaded, so a preflight that cleaned the text would report a pass on text
  that will be rejected.
- **`color.ts`** grades a brand colour against BOTH ChatGPT backgrounds and
  takes the worse ratio. A colour that clears the threshold on white and fails
  on the dark surface is invisible to half the users, so picking one background
  would pass it.

SVG is parsed with `@xmldom/xmldom` rather than a regex — a pattern matches a
width inside a comment, inside a nested `<rect>`, and inside CDATA — and any
parser diagnostic counts as malformed, since the parser recovers from unclosed
tags by design and listening only for fatal errors would accept documents that
are not well-formed XML.
