---
"@mcpjam/inspector": patch
---

Pressing Enter in the accuracy field reports one edit, not two

Enter leaves the field by blurring it, and blurring is what commits — so
committing before the blur as well filed the same edit twice. The test that
covered Enter only checked the value it reported, which is why the duplicate
went unnoticed; it now pins the call count too.
