import type { ModelDefinition } from "@/shared/types";
import {
  getChatboxHostLabel,
  getChatboxHostLogo,
  type ChatboxHostStyle,
} from "@/lib/chatbox-host-style";
import { getProviderLogoFromModel } from "@/components/chat-v2/shared/chat-helpers";

type ThemeMode = "light" | "dark" | "system";

interface AssistantAvatarOptions {
  model: ModelDefinition;
  themeMode: ThemeMode;
  chatboxHostStyle: ChatboxHostStyle | null;
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
  chatboxHostStyle,
}: AssistantAvatarOptions): AssistantAvatarDescriptor {
  if (chatboxHostStyle !== null) {
    const hostLabel = getChatboxHostLabel(chatboxHostStyle);
    return {
      logoSrc: getChatboxHostLogo(chatboxHostStyle),
      logoAlt: `${hostLabel} logo`,
      avatarClasses: `chatbox-host-assistant-avatar ${DEFAULT_AVATAR_CLASSES}`,
      ariaLabel: `${hostLabel} assistant`,
    };
  }

  return {
    logoSrc: getProviderLogoFromModel(model, themeMode),
    logoAlt: `${model.id} logo`,
    avatarClasses: DEFAULT_AVATAR_CLASSES,
    ariaLabel: `${model.name} assistant`,
  };
}
