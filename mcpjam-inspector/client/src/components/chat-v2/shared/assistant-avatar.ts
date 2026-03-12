import type { ModelDefinition } from "@/shared/types";
import type { SandboxHostStyle } from "@/lib/sandbox-host-style";
import { getProviderLogoFromModel } from "@/components/chat-v2/shared/chat-helpers";

type ThemeMode = "light" | "dark" | "system";

interface AssistantAvatarOptions {
  model: ModelDefinition;
  themeMode: ThemeMode;
  sandboxHostStyle: SandboxHostStyle | null;
}

export interface AssistantAvatarDescriptor {
  logoSrc: string | null;
  logoAlt: string | null;
  avatarClasses: string;
  ariaLabel: string;
}

const DEFAULT_AVATAR_CLASSES = "border-border/40 bg-muted/40";

export function getAssistantAvatarDescriptor({
  model,
  themeMode,
  sandboxHostStyle,
}: AssistantAvatarOptions): AssistantAvatarDescriptor {
  if (sandboxHostStyle !== null) {
    return {
      logoSrc: null,
      logoAlt: null,
      avatarClasses: DEFAULT_AVATAR_CLASSES,
      ariaLabel: "Assistant",
    };
  }

  return {
    logoSrc: getProviderLogoFromModel(model, themeMode),
    logoAlt: `${model.id} logo`,
    avatarClasses: DEFAULT_AVATAR_CLASSES,
    ariaLabel: `${model.name} assistant`,
  };
}
