---
"@mcpjam/sdk": minor
---

Extract the XAA (Cross-App Access / ID-JAG) mock-IdP mint into `@mcpjam/sdk` (node entry only). New exports: the ID-JAG/id-token/access-token/code signer (`issueIdJag`, `issueNegativeIdJag`, `issueMockIdToken`, `issueAuthorizationCode`, `issueAccessToken`, `verifyXaaJwt`), the RS256 keypair/JWKS manager (`initXAAIdpKeyPair`, `getXAAIdpJwks`, `getXAAIssuerUrl`, `setXaaIdpLogger`, …), `buildJwtBearerBody`, and the negative-test constants. Pure `crypto`/`fs`; the inspector server now consumes the mint from the SDK. Enables a headless XAA flow for the CLI.
