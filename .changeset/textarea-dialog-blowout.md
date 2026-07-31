---
"@mcpjam/inspector": patch
---

Fix the OAuth Debugger's "Configure Server to Test" dialog blowing out horizontally when Scopes held a long unbroken value. The shared design-system `Textarea` uses `field-sizing: content`, so an unbreakable value set its min-content width and dragged every `w-full` field and the footer past the dialog edge; `wrap-anywhere` makes the value wrap and the field grow vertically instead.
