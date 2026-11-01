---
"@mcpjam/sdk": minor
"@mcpjam/cli": minor
---

Preserve each protected call's sign-in challenge across HTTP and auth-provider failures. Queue auth-provider operations per server so resetting one failed session cannot close another active call; cancelled queue waits end promptly. A rebuilt refresh-token connection starts from the newest rotated refresh token instead of the configured one. CLI errors report sign-in needed without opening a browser and omit credential-bearing URLs from login hints.

Compatibility: HTTP 401/403 use ClientHttpAuthentication/ClientHttpForbidden instead of ClientHttpNotImplemented. resources/read and prompts/get preserve these failures as SdkHttpError; callers matching numeric codes must update their handling. CLI JSON errors for a 401 now report `AUTH_REQUIRED` instead of `SERVER_UNREACHABLE` or `INTERNAL_ERROR`; the exit code is unchanged.
