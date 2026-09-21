/** Preserve admission codes across provisioning so callers never classify prose. */
export class BrowserAdmissionError extends Error {
  constructor(
    readonly refusal: {
      error: string;
      status: number;
      code?: string;
      limit?: number;
      retryAfterMs?: number;
    },
  ) {
    super(refusal.error);
    this.name = "BrowserAdmissionError";
  }
}
