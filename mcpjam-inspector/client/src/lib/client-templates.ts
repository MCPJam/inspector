/**
 * Host templates for the inspector UI.
 *
 * The seed logic (the 12 template configs + `emptyHostConfigInputV2`) now lives
 * in the SDK at `@mcpjam/sdk/host-config/templates` so the server `--template`
 * resolver and the CLI can mint the same host configs in Node. This module is
 * the thin browser-side adapter: it re-attaches the Vite logo assets (UI-only
 * metadata the SDK doesn't carry) and threads the Vite `__APP_VERSION__` build
 * constant into the seed call (the SDK takes it as `appVersion`; only the
 * mcpjam template reads it).
 *
 * Parity between the SDK seeds and the historical client seeds is locked by
 * `client/src/lib/__tests__/host-template-seed-parity.test.ts`.
 */
import {
  HOST_TEMPLATES as SDK_HOST_TEMPLATES,
  seedHostTemplate,
  CLAUDE_CODE_NATIVE_TOOLS,
  DEFAULT_HOST_TEMPLATE_ID,
} from "@mcpjam/sdk/host-config/templates";
import type {
  HostTemplateId,
  SeedHostTemplateOptions,
} from "@mcpjam/sdk/host-config/templates";
import type { HostConfigInputV2 } from "@/lib/client-config-v2";
import mcpjamLogo from "/mcp_jam.svg";
import claudeLogo from "/claude_logo.png";
import claudeCodeLogo from "/claude_code_logo.png";
import openaiLogo from "/openai_logo.png";
import mistralLogo from "/mistral_logo.png";
import gooseLogo from "/goose_logo.svg";
import cursorLogo from "/cursor_logo.png";
import codexLogo from "/codex-logo.svg";
import copilotLogo from "/copilot_logo.png";
import vscodeLogo from "/vscode_logo.svg";
import bedrockLogo from "/bedrock_logo.svg";
import n8nLogo from "/n8n_logo.svg";
import perplexityLogo from "/perplexity_logo.svg";

declare const __APP_VERSION__: string;

export { CLAUDE_CODE_NATIVE_TOOLS, DEFAULT_HOST_TEMPLATE_ID };
export type { HostTemplateId, SeedHostTemplateOptions };

/** UI logo per template id — the only metadata that stays browser-side. */
const LOGO_BY_ID: Record<HostTemplateId, string> = {
  mcpjam: mcpjamLogo,
  claude: claudeLogo,
  "claude-code": claudeCodeLogo,
  chatgpt: openaiLogo,
  mistral: mistralLogo,
  goose: gooseLogo,
  cursor: cursorLogo,
  codex: codexLogo,
  copilot: copilotLogo,
  vscode: vscodeLogo,
  agentcore: bedrockLogo,
  n8n: n8nLogo,
  perplexity: perplexityLogo,
};

export interface HostTemplate {
  id: HostTemplateId;
  label: string;
  description: string;
  logoSrc: string;
  seed: (opts?: SeedHostTemplateOptions) => HostConfigInputV2;
}

/**
 * Seed a host config from a template id. Delegates to the SDK seed (single
 * source of truth), stamping the inspector's build version. The result is the
 * strict client `HostConfigInputV2` (field-identical to the SDK shape).
 */
export function seedFromHostTemplate(
  id: HostTemplateId,
  opts?: SeedHostTemplateOptions,
): HostConfigInputV2 {
  return seedHostTemplate(id, {
    ...opts,
    appVersion: __APP_VERSION__,
  }) as unknown as HostConfigInputV2;
}

export const HOST_TEMPLATES: readonly HostTemplate[] = SDK_HOST_TEMPLATES.map(
  (template) => ({
    id: template.id,
    label: template.label,
    description: template.description,
    logoSrc: LOGO_BY_ID[template.id],
    seed: (opts?: SeedHostTemplateOptions) =>
      seedFromHostTemplate(template.id, opts),
  }),
);
