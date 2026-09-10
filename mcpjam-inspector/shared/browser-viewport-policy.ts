/** Interactive JPEG defaults shared by streamed browser viewers. */
export const BROWSER_VIEWPORT_POLICY = {
  quality: 75,
  maxFrameBytes: 256 * 1024,
  minIntervalMs: 100,
  inputIntervalMs: 33,
  inputBoostWindowMs: 1_500,
} as const;
