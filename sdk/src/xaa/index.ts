// XAA (Cross-App Access / ID-JAG) mock-IdP mint. Node-only (crypto/fs); do not
// re-export from the browser entry. The inspector server and the CLI both
// consume the mint from here; the XAA *flow* state machine stays in the
// inspector client.
export {
  XAA_IDP_KID,
  NEGATIVE_TEST_MODES,
  DEFAULT_NEGATIVE_TEST_MODE,
  isNegativeTestMode,
  IDENTITY_ASSERTION_FORMATS,
  DEFAULT_IDENTITY_ASSERTION_FORMAT,
  normalizeIdentityAssertionFormat,
  SUBJECT_IDENTIFIER_FORMATS,
  DEFAULT_SUBJECT_IDENTIFIER_FORMAT,
  normalizeSubjectIdentifierFormat,
  type NegativeTestMode,
  type IdentityAssertionFormat,
  type SubjectIdentifierFormat,
} from "./constants.js";
export {
  REGISTRATION_STRATEGIES,
  DEFAULT_REGISTRATION_STRATEGY,
  DEFAULT_REGISTRATION_MODE,
  normalizeRegistrationStrategy,
  normalizeRegistrationMode,
  normalizeAuthMethod,
  AUTH_METHODS,
  type RegistrationStrategy,
  type RegistrationMode,
  type AuthMethod,
} from "../registration.js";
export { NEGATIVE_TEST_MODE_DETAILS } from "./negative-test-modes.js";
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
  validateXaaTokenExchangeSubject,
  XAA_CODE_JWT_TYP,
  XAA_ACCESS_TOKEN_TYP,
  XAA_RAS_CLIENT_ID_CLAIM,
  type IdJagSubjectId,
  type IssueIdJagParams,
  type IssueMockIdTokenParams,
  type IssueAuthorizationCodeParams,
  type IssueAccessTokenParams,
  type XaaTokenExchangeSubject,
} from "./mint/signer.js";
export {
  issueMockSamlAssertion,
  verifyMockSamlAssertion,
  decodeSamlAssertionSubjectUnsafe,
  SAML_NAMEID_FORMAT_PERSISTENT,
  type IssueMockSamlAssertionParams,
  type IssuedMockSamlAssertion,
  type SamlAssertionSubject,
  type UnsafeSamlAssertionSubject,
  type VerifiedSamlAssertionSubject,
  type VerifyMockSamlAssertionExpectations,
} from "./mint/saml.js";
export {
  handleXaaAuthenticate,
  handleXaaJsonTokenExchange,
  handleXaaTokenExchangeGrant,
  type XaaAuthenticateParams,
  type XaaJsonTokenExchangeParams,
  type XaaMintHandlerResult,
} from "./mint/handlers.js";
export {
  buildJwtBearerBody,
  buildJwtBearerRequest,
  type XaaTokenEndpointAuthMethod,
} from "./mint/jwt-bearer.js";
export {
  canonicalizeMcpResource,
  buildProtectedResourceMetadataCandidates,
  buildAuthorizationServerMetadataCandidates,
  buildIssuerPublicationCandidates,
  XAA_AS_METADATA_NAMES,
} from "./discovery.js";
export {
  buildMcpInitializeRequest,
  evaluateMcpInitializeResponse,
  mcpInitializeExtensionEvidence,
  MCP_INIT_ID,
  MCP_PROTOCOL_VERSION,
  XAA_MCP_EXTENSION,
  type McpInitializeRequest,
} from "./mcp-init.js";
export { createInProcessXaaExecutor } from "./in-process-executor.js";
export type { InProcessXaaExecutorOptions } from "./in-process-executor.js";
export { runXaaFlow } from "./run-xaa-flow.js";
export type {
  XaaCapabilityEvidence,
  XaaFlowConfig,
  XaaFlowResult,
  XaaFlowStep,
  XaaRedemptionResult,
} from "./run-xaa-flow.js";
