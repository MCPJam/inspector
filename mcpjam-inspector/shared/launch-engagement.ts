import { z } from "zod";

export const LAUNCH_ID = "platform-launch-2026-09";

// A closed vocabulary prevents the public telemetry endpoint from becoming a
// free-form log sink. No user IDs, paths, URLs, or user content are accepted.
export const launchEngagementSchema = z
  .object({
    event_id: z.string().uuid(),
    launch_id: z.literal(LAUNCH_ID),
    action: z.enum([
      "shown",
      "opened",
      "feature_selected",
      "video_requested",
      "feature_navigated",
      "dismissed",
      "closed",
    ]),
    feature: z.enum([
      "launch-video",
      "swarms",
      "user-testing",
      "evals",
      "ci-cd",
    ]),
    presentation: z.enum(["card", "launcher", "collapsed"]),
    prior_status: z.enum(["unseen", "seen", "dismissed"]),
    audience: z.enum(["guest", "signed_in"]),
    close_reason: z.enum(["dismiss", "back_to_work", "navigate"]).optional(),
    duration_ms: z.number().int().min(0).max(86_400_000).optional(),
  })
  .strict()
  .superRefine((event, ctx) => {
    for (const field of ["close_reason", "duration_ms"] as const) {
      if ((event.action === "closed") !== (event[field] !== undefined)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [field],
          message: "Close metadata is required only for closed events",
        });
      }
    }
  });

export type LaunchEngagement = z.infer<typeof launchEngagementSchema>;
