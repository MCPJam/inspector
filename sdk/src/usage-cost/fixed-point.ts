/**
 * Money arithmetic in femto-dollars (1e-15 USD) on BigInt. Per-token rates are
 * around 1e-7 USD, so floating-point products and long sums drift in the last
 * digits; integer units keep a call's parts summing exactly to its total and a
 * trace's calls summing exactly to the trace. Results leave as plain numbers
 * because JSON and Convex store numbers; only display rounds them. Converting a
 * stored amount back is exact below about $9 and within 1e-14 USD above it,
 * far below any displayed digit.
 */
const FEMTO_PER_USD = 1_000_000_000_000_000n;
const FEMTO_PER_USD_NUMBER = 1e15;
/** USD per million tokens → femto-dollars per token is a factor of 1e9. */
const FEMTO_PER_TOKEN_PER_USD_PER_MTOK = 1e9;
/** USD per thousand requests → femto-dollars per request is a factor of 1e12. */
const FEMTO_PER_REQUEST_PER_USD_PER_K = 1e12;

export type Femto = bigint;

export function usdToFemto(usd: number): Femto {
  return BigInt(Math.round(usd * FEMTO_PER_USD_NUMBER));
}

export function femtoToUsd(femto: Femto): number {
  const whole = femto / FEMTO_PER_USD;
  const fraction = femto % FEMTO_PER_USD;
  return Number(whole) + Number(fraction) / FEMTO_PER_USD_NUMBER;
}

export function tokenCostFemto(
  tokens: number,
  usdPerMillionTokens: number
): Femto {
  const perToken = BigInt(
    Math.round(usdPerMillionTokens * FEMTO_PER_TOKEN_PER_USD_PER_MTOK)
  );
  return BigInt(Math.round(tokens)) * perToken;
}

export function requestCostFemto(
  requests: number,
  usdPerThousandRequests: number
): Femto {
  const perRequest = BigInt(
    Math.round(usdPerThousandRequests * FEMTO_PER_REQUEST_PER_USD_PER_K)
  );
  return BigInt(Math.round(requests)) * perRequest;
}
