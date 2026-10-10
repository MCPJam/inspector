/**
 * Synthetic personal data for telemetry privacy tests. Every value is
 * distinctive enough that finding it anywhere in an outbound payload is a
 * failure, and none of it belongs to a real person or organization.
 *
 * Shared by the relay tests (server/routes/__tests__/relay-privacy.test.ts)
 * and the telemetry-enabled browser test (e2e/telemetry-privacy.browser.ts),
 * so both look for the same strings.
 */
export const SYNTHETIC_PII = {
  name: "Zelda Quixote-Fairweather",
  firstName: "Zelda",
  lastName: "Quixote-Fairweather",
  email: "zelda.quixote@acme-synthetic.example",
  organizationName: "Acme Synthetic Holdings",
  projectName: "quixote-billing-project",
  serverName: "quixote-billing-mcp",
  domText: "Invoice 4417 for Zelda Quixote-Fairweather",
  inputValue: "secret-input-zq-9f3a71",
  placeholder: "Search Acme Synthetic customers",
  title: "Zelda's billing dashboard",
  consoleMessage: "debug: loaded Zelda Quixote-Fairweather invoices",
  networkUrl: "/api/customers/quixote-billing-project",
  networkBody: '{"customer":"zelda.quixote@acme-synthetic.example"}',
  imageUrl: "https://cdn.acme-synthetic.example/avatars/zelda.png",
} as const;

/** The strings no restricted payload may contain, in any encoding. */
export const SYNTHETIC_PII_NEEDLES: readonly string[] = [
  SYNTHETIC_PII.name,
  SYNTHETIC_PII.lastName,
  SYNTHETIC_PII.email,
  SYNTHETIC_PII.organizationName,
  SYNTHETIC_PII.projectName,
  SYNTHETIC_PII.serverName,
  SYNTHETIC_PII.domText,
  SYNTHETIC_PII.inputValue,
  SYNTHETIC_PII.placeholder,
  SYNTHETIC_PII.title,
  SYNTHETIC_PII.consoleMessage,
  SYNTHETIC_PII.networkBody,
  SYNTHETIC_PII.imageUrl,
  "acme-synthetic",
];

/** The needles found in `text`. Empty means clean. */
export function findSyntheticPii(text: string): string[] {
  return SYNTHETIC_PII_NEEDLES.filter((needle) => text.includes(needle));
}
