// XAA (Cross-App Access / ID-JAG) mock-IdP mint. Node-only (crypto/fs); do not
// re-export from the browser entry. The inspector server and the CLI both
// consume the mint from here; the XAA *flow* state machine stays in the
// inspector client.
export {
  XAA_IDP_KID,
  NEGATIVE_TEST_MODES,
  DEFAULT_NEGATIVE_TEST_MODE,
  isNegativeTestMode,
  type NegativeTestMode,
} from "./constants.js";
export {
  initXAAIdpKeyPair,
  getXAAIssuerUrl,
  getXAAIdpPrivateKey,
  getXAAIdpPublicKeyObject,
  getXAAIdpJwks,
  resetXAAIdpKeyPairForTests,
  setXaaIdpLogger,
  type XAAIdpJwk,
  type XaaIdpLogger,
} from "./mint/keypair.js";
export {
  issueIdJag,
  issueNegativeIdJag,
  issueMockIdToken,
  issueAuthorizationCode,
  issueAccessToken,
  verifyXaaJwt,
  XAA_CODE_JWT_TYP,
  XAA_ACCESS_TOKEN_TYP,
  type IssueIdJagParams,
  type IssueMockIdTokenParams,
  type IssueAuthorizationCodeParams,
  type IssueAccessTokenParams,
} from "./mint/signer.js";
export { buildJwtBearerBody } from "./mint/jwt-bearer.js";
