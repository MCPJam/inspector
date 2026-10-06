---
"@mcpjam/sdk": minor
---

`@mcpjam/sdk/platform` now says which platform feature each operation belongs to. `OPERATION_FEATURES` maps every operation, deprecated aliases included, to its feature (`null` when released), and `PLATFORM_FEATURES` names each feature. Given the feature availability the platform reports, `isOperationAvailable(name, features)` and `disabledOperations(features)` say what a caller can use. Both fail closed: a feature that is not reported as on counts as off.
