---
"@mcpjam/sdk": minor
---

Single-source the client-registration vocabulary shared by the OAuth flows and the XAA debugger: new `RegistrationStrategy` (`preregistered | cimd | dcr`), `RegistrationMode` (`auto | …`), `AuthMethod` (`auto | oauth | xaa | bearer | none`), plus `REGISTRATION_STRATEGIES`, `AUTH_METHODS`, defaults, and `normalizeRegistrationStrategy` / `normalizeRegistrationMode` / `normalizeAuthMethod` (the strategy/mode normalizers accept the legacy `pre_registered` spelling as an alias). The XAA engine now uses these types with the canonical `preregistered` spelling; the never-published `XAA_REGISTRATION_STRATEGIES` / `XaaRegistrationStrategy` / `DEFAULT_XAA_REGISTRATION_STRATEGY` / `normalizeXaaRegistrationStrategy` names are removed. `OAuthRegistrationStrategy` / `OAuthRegistrationMode` are unchanged but deprecated in favor of the shared types.
