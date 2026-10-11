import { z } from "zod";

const id = z.string().min(1).max(256);
export type PluginOnboardingConversation = "current" | "new";
/** A user-selected immutable version, never browser-supplied skill content. */
export const pluginOnboardingIntentSchema = z.strictObject({
  pluginVersionId: id,
});
export type PluginOnboardingIntent = z.infer<
  typeof pluginOnboardingIntentSchema
>;

export function readPluginOnboardingIntent(
  messages: readonly { role: string; metadata?: unknown }[],
): PluginOnboardingIntent | undefined {
  const message = [...messages]
    .reverse()
    .find((entry) => entry.role === "user");
  const metadata = message?.metadata;
  if (
    !metadata ||
    typeof metadata !== "object" ||
    Array.isArray(metadata) ||
    !Object.hasOwn(metadata, "pluginOnboarding")
  )
    return undefined;
  return pluginOnboardingIntentSchema.parse(
    (metadata as Record<string, unknown>).pluginOnboarding,
  );
}

/** Read-only packaged onboarding spec. It is content, never permission to run a turn. */
export const pluginOnboardingSpecSchema = z
  .strictObject({
    pluginId: id,
    pluginVersionId: id,
    name: z.string().min(1).max(256),
    bundleHash: z.string().min(1).max(256),
    onboarding: z.strictObject({
      componentId: id,
      modelRef: id,
      materializedSkillId: id,
    }),
    skill: z.strictObject({
      skillId: id,
      name: z.string().min(1).max(256),
      description: z.string().max(4096),
      content: z.string().max(1024 * 1024),
      contentHash: z.string().min(1).max(256),
    }),
    files: z
      .array(
        z.strictObject({
          skillId: id,
          path: z.string().min(1).max(4096),
          size: z.number().int().nonnegative(),
          url: z.string().max(8192).nullable(),
        }),
      )
      .max(512),
  })
  .superRefine((spec, ctx) => {
    if (
      spec.onboarding.materializedSkillId !== spec.skill.skillId ||
      spec.files.some((file) => file.skillId !== spec.skill.skillId)
    )
      ctx.addIssue({
        code: "custom",
        message: "Onboarding skill identity mismatch",
      });
  });
export type PluginOnboardingSpec = z.infer<typeof pluginOnboardingSpecSchema>;
