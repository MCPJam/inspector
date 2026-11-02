---
"@mcpjam/sdk": minor
---

Grade Claude lazy authentication using the protected call's challenge and rediscovered metadata. Input-validation errors stay inconclusive instead of being graded as unsupported authentication. A step-up probe answered with a 2xx error instead of a 403 `insufficient_scope` challenge now fails the step-up check rather than reading as already authorized.
