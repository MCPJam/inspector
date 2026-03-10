export type SdkErrorOptions = {
  cause?: unknown;
};

export class SdkError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    options?: SdkErrorOptions
  ) {
    super(message, options);
    this.name = "SdkError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export type EvalReportingErrorOptions = SdkErrorOptions & {
  statusCode?: number;
  endpoint?: string;
  attemptCount?: number;
};

export class EvalReportingError extends SdkError {
  public readonly statusCode?: number;
  public readonly endpoint?: string;
  public readonly attemptCount?: number;

  constructor(message: string, options: EvalReportingErrorOptions = {}) {
    super(message, "EVAL_REPORTING_ERROR", options);
    this.name = "EvalReportingError";
    this.statusCode = options.statusCode;
    this.endpoint = options.endpoint;
    this.attemptCount = options.attemptCount;
  }
}
