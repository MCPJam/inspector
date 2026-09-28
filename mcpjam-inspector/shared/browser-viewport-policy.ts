/** Interactive JPEG defaults shared by streamed browser viewers. */
export const BROWSER_VIEWPORT_POLICY = {
  quality: 85,
  maxFrameBytes: 256 * 1024,
  minIntervalMs: 100,
  inputIntervalMs: 33,
  inputBoostWindowMs: 1_500,
} as const;

/** Opt-in bound; unnegotiated readers retain the original 256 KiB limit. */
export const SHARP_JPEG_MAX_BYTES = 2 * 1024 * 1024;
export const SHARP_STREAM_FEATURE = "sharp-stream-v1";
export function jpegFrameLimit(sharp: boolean): number {
  return sharp ? SHARP_JPEG_MAX_BYTES : BROWSER_VIEWPORT_POLICY.maxFrameBytes;
}

export const JPEG_RECOVERY_POLICY = {
  qualities: [85, 75, 65, 55, 40],
  probeMs: 10_000,
  maxProbeMs: 60_000,
} as const;

export const STREAM_CONGESTION_POLICY = {
  badSamples: 3,
  goodSamples: 5,
  badLoss: 0.1,
  goodLoss: 0.02,
  drainMs: 25,
  intervalMs: 200,
  inputIntervalMs: 100,
} as const;

export interface JpegDeliveryStats {
  maxFps: number;
  reason: "default" | "congestion";
}
