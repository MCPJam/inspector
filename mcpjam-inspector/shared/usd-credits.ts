/**
 * Dollars → whole credits, decided on the DIGITS rather than on a float.
 *
 * One implementation for both paths that write a spend budget: the console,
 * which has the string an admin typed, and the v1 route, which has a JSON
 * number. They must agree — a cap saved from the UI and the same cap set
 * through the API are the same cap — and they cannot agree while each does
 * its own rounding.
 *
 * WHY NOT `Math.round(usd * 100)`. Binary float64 has no exact `1.005`; it
 * holds 1.00499999999999989, so the product lands just under the half-cent
 * and rounds down to a cap one cent below what was asked for. Nudging by
 * `Number.EPSILON` does not fix it either — epsilon is the gap at 1.0, so the
 * correction is already too small by `10.075`, which still rounds to 1007.
 * The gap scales with magnitude; a fixed correction cannot.
 *
 * So the cents are read off the decimal text, where the intended number still
 * exists, and the third decimal decides the half-cent exactly as written.
 */
export function usdStringToCredits(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  // Plain decimal only. An exponent form has no fixed cent position to read,
  // and a sign is not a budget.
  const match = /^(\d*)(?:\.(\d*))?$/.exec(trimmed);
  if (!match || (match[1] === "" && (match[2] ?? "") === "")) {
    // Not plain-decimal. `Number` still decides validity, and a negative or
    // non-finite value is refused.
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed) || parsed < 0) return null;
    return Math.round(parsed * 100);
  }
  const whole = match[1] === "" ? "0" : match[1];
  const fraction = match[2] ?? "";
  const cents = Number(whole) * 100 + Number((fraction + "00").slice(0, 2));
  if (!Number.isFinite(cents)) return null;
  const roundUp = (fraction[2] ?? "0") >= "5";
  return cents + (roundUp ? 1 : 0);
}

/**
 * The same conversion for a caller who could only send a NUMBER.
 *
 * `String(n)` is the shortest decimal that round-trips to the same double, so
 * it recovers the digits the sender wrote — `String(10.075)` is `"10.075"` —
 * and the digit-based rule above then applies unchanged. This is why the
 * route needs no epsilon and no magnitude special-casing.
 */
export function usdNumberToCredits(usd: number): number | null {
  if (!Number.isFinite(usd) || usd < 0) return null;
  return usdStringToCredits(String(usd));
}

/** Credits (1¢ each) → a dollar string, for a form field. */
export function creditsToUsdString(credits: number): string {
  return (credits / 100).toFixed(2);
}
