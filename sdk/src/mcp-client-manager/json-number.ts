function decimal(value: number) {
  const [mantissa, exponent = "0"] = String(value).split("e");
  const [whole, fraction = ""] = mantissa.split(".");
  return {
    coefficient: BigInt(whole + fraction),
    exponent: Number(exponent) - fraction.length,
  };
}

/** Canonical finite JSON numbers: decimal divisibility without binary rounding. */
export function isNumericMultipleOf(value: number, step: number): boolean {
  if (!Number.isFinite(value) || !Number.isFinite(step) || step <= 0)
    return false;
  const a = decimal(value);
  const b = decimal(step);
  const shift = a.exponent - b.exponent;
  return shift >= 0
    ? (a.coefficient * 10n ** BigInt(shift)) % b.coefficient === 0n
    : a.coefficient % (b.coefficient * 10n ** BigInt(-shift)) === 0n;
}
