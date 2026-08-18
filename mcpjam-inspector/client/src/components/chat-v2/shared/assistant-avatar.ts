import type { ModelDefinition } from "@/shared/types";
import {
  getScenarioHostLabel,
  getScenarioHostLogo,
  type ScenarioHostStyle,
} from "@/lib/scenario-client-style";
import { getProviderLogo } from "@/lib/provider-registry";

type ThemeMode = "light" | "dark" | "system";

interface AssistantAvatarOptions {
  model: ModelDefinition;
  themeMode: ThemeMode;
  scenarioHostStyle: ScenarioHostStyle | null;
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
  scenarioHostStyle,
}: AssistantAvatarOptions): AssistantAvatarDescriptor {
  if (scenarioHostStyle !== null) {
    const hostLabel = getScenarioHostLabel(scenarioHostStyle);
    return {
      logoSrc: getScenarioHostLogo(
        scenarioHostStyle,
        undefined,
        themeMode === "dark" ? "dark" : "light"
      ),
      logoAlt: `${hostLabel} logo`,
      avatarClasses: `scenario-host-assistant-avatar ${DEFAULT_AVATAR_CLASSES}`,
      ariaLabel: `${hostLabel} assistant`,
    };
  }

  return {
    logoSrc: getProviderLogo(model.provider, themeMode),
    logoAlt: `${model.id} logo`,
    avatarClasses: DEFAULT_AVATAR_CLASSES,
    ariaLabel: `${model.name} assistant`,
  };
}
