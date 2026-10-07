/**
 * A submission profile that satisfies every Muse declaration, for the
 * submission and runner suites. A plain module, not a test file, so importing
 * it does not re-register another suite's tests.
 */

import type { MuseSubmissionProfile } from "../../src/muse-readiness/submission-profile.js";

export const COMPLETE_PROFILE: MuseSubmissionProfile = {
  overview: {
    intendedUsers: "Travellers booking short stays",
    supportedTasks: ["search rooms", "book a room", "cancel a booking"],
    browserImprovement:
      "Live availability and one-step booking with the user's saved payment method.",
    restrictions: "US and Canada only; account required for booking.",
  },
  privacyPolicyUrl: "https://cedar.example/privacy",
  termsUrl: "https://cedar.example/terms",
  supportContact: "support@cedar.example",
  securityContact: "https://cedar.example/security",
  documentationUrl: "https://cedar.example/docs/mcp",
  documentationCovers: [
    "setup-instructions",
    "inputs-and-outputs",
    "read-write-classifications",
    "sensitive-designations",
    "permissions",
    "side-effects",
    "status-handling",
    "errors",
    "rate-limits",
  ],
  authentication: {
    method: "oauth",
    scopes: ["stays.read", "stays.book"],
    readOnlyScopes: ["stays.read"],
    credentialsEnvironment: "test",
  },
  testAccount: {
    signInInstructions:
      "Sign in with the reviewer account supplied in the portal.",
    requiredPermissions: "stays.read and stays.book",
    representativeTestData:
      "Three listings in Portland with open December dates.",
    limits: "none",
    accessibleThroughoutReview: true,
  },
  transactions: {
    hasTransactionTools: true,
    noChargeTestPath:
      "The test account uses Stripe test mode; card 4242 4242 4242 4242.",
  },
  toolClassifications: { search_rooms: "read", book_room: "sensitive-write" },
  attestations: {
    businessVerificationProvided: true,
    brandAssetsAuthorized: true,
    maintainerNamed: true,
    dataProcessingQuestionnaireCompleted: true,
    acceptsDeveloperTerms: true,
  },
};
