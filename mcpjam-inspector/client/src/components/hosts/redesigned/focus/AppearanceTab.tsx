import { useId } from "react";
import { Button } from "@mcpjam/design-system/button";
import { Input } from "@mcpjam/design-system/input";
import { cn } from "@/lib/utils";
import type { HostConfigInputV2 } from "@/lib/host-config-v2";
import {
  resolveEffectiveHostStyle,
  type ChatUiOverride,
} from "@/lib/host-styles";
import { HOST_TEMPLATES } from "@/lib/host-templates";
import { FieldRow, FocusBlock, SegmentedControl } from "./primitives";

interface AppearanceTabProps {
  draft: HostConfigInputV2;
  onDraftChange: (
    updater: (prev: HostConfigInputV2) => HostConfigInputV2,
  ) => void;
}

const DEFAULT_DOTS_COLOR = "#F2735B";

/**
 * Sparse-merge a `ChatUiOverride` patch onto the draft. Drops keys whose
 * value becomes `undefined`; if the resulting object is empty, sets
 * `chatUiOverride: undefined` (the "inherit from preset" sentinel
 * `resolveEffectiveHostStyle` keys on). Mirrors the reset semantics
 * `hostCapabilitiesOverride` already uses.
 */
function patchChatUiOverride(
  draft: HostConfigInputV2,
  patch: Partial<ChatUiOverride>,
): HostConfigInputV2 {
  const next = { ...(draft.chatUiOverride ?? {}), ...patch };
  const cleaned = Object.fromEntries(
    Object.entries(next).filter(([, v]) => v !== undefined),
  ) as ChatUiOverride;
  return {
    ...draft,
    chatUiOverride:
      Object.keys(cleaned).length === 0 ? undefined : cleaned,
  };
}

export function AppearanceTab({ draft, onDraftChange }: AppearanceTabProps) {
  const reactId = useId();
  const override = draft.chatUiOverride;
  const indicator = override?.indicator;
  const indicatorKind: "dots" | "image" = indicator?.kind ?? "dots";
  const hasOverride = override !== undefined;

  // Derive control values from the override, defaulting to dispatcher
  // defaults when the user hasn't picked anything yet. Editing any field
  // promotes that subset onto the persisted override; untouched fields
  // continue to inherit from the preset.
  const dotsColor =
    indicator?.kind === "dots" ? (indicator.color ?? DEFAULT_DOTS_COLOR) : DEFAULT_DOTS_COLOR;
  const dotsCount: 1 | 2 | 3 =
    indicator?.kind === "dots" && (indicator.count === 1 || indicator.count === 2 || indicator.count === 3)
      ? indicator.count
      : 3;
  const imageSrc = indicator?.kind === "image" ? indicator.src : "";
  const imageAnimation: "spin" | "pulse" | "none" =
    indicator?.kind === "image" ? (indicator.animation ?? "pulse") : "pulse";

  // Resolve the *actually-rendered* indicator component the same way the
  // chat surface does, so the preview matches reality:
  //   - No override → the preset's bespoke component (ChatGptDotIndicator
  //     for ChatGPT, ClaudeMarkIndicator for Claude, etc.)
  //   - Override.indicator set → the synthesized HostIndicatorDispatch
  //     wrapper for that IndicatorDef
  // Earlier versions hardcoded 3 orange dots as the "no override" preview,
  // which lied about what the chat would actually show on save.
  const PreviewIndicator = resolveEffectiveHostStyle({
    hostStyle: draft.hostStyle,
    chatUiOverride: draft.chatUiOverride,
  }).chatUi.loadingIndicator;

  return (
    <div className="flex flex-col gap-3">
      {hasOverride ? (
        <div className="flex justify-end">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() =>
              onDraftChange((d) => ({ ...d, chatUiOverride: undefined }))
            }
            className="text-[12px] text-muted-foreground hover:text-foreground"
          >
            Reset to preset
          </Button>
        </div>
      ) : null}

      <FocusBlock
        title="Logo"
        subtitle="Brand logo shown in pickers and chat chrome. Pick a preset or paste a URL. Leave blank to inherit from the preset."
      >
        <FieldRow
          label="Preset"
          control={
            <div className="flex flex-wrap items-center gap-1.5">
              {HOST_TEMPLATES.map((tpl) => {
                const active = override?.logoSrc === tpl.logoSrc;
                return (
                  <button
                    key={tpl.id}
                    type="button"
                    aria-label={tpl.label}
                    aria-pressed={active}
                    title={tpl.label}
                    onClick={() =>
                      onDraftChange((d) =>
                        patchChatUiOverride(d, { logoSrc: tpl.logoSrc }),
                      )
                    }
                    className={cn(
                      "inline-flex size-8 items-center justify-center rounded-md border bg-muted/30 transition-colors",
                      active
                        ? "border-foreground/60 ring-2 ring-foreground/40"
                        : "border-border hover:border-foreground/40",
                    )}
                  >
                    <img
                      src={tpl.logoSrc}
                      alt=""
                      className="h-5 w-5 object-contain"
                    />
                  </button>
                );
              })}
            </div>
          }
        />
        <FieldRow
          label="Logo URL"
          control={
            <Input
              id={`${reactId}-logo`}
              type="url"
              value={override?.logoSrc ?? ""}
              placeholder="https://example.com/logo.svg"
              onChange={(e) =>
                onDraftChange((d) =>
                  patchChatUiOverride(d, {
                    logoSrc: e.target.value.trim() === "" ? undefined : e.target.value,
                  }),
                )
              }
              className="h-8 w-72 text-[12px]"
            />
          }
        />
        {override?.logoSrc ? (
          <div className="flex items-center gap-2">
            <span className="text-[11px] text-muted-foreground">Preview</span>
            <img
              src={override.logoSrc}
              alt=""
              className="h-6 w-6 rounded border border-border bg-muted/30 object-contain"
            />
          </div>
        ) : null}
      </FocusBlock>

      <FocusBlock
        title="Loading indicator"
        subtitle="Shown while the agent is thinking. Pick dots for branded color spots or image for a custom mark."
      >
        <FieldRow
          label="Kind"
          control={
            <SegmentedControl
              ariaLabel="Indicator kind"
              value={indicatorKind}
              onChange={(next) => {
                if (next === "dots") {
                  onDraftChange((d) =>
                    patchChatUiOverride(d, {
                      indicator: { kind: "dots", color: dotsColor, count: dotsCount },
                    }),
                  );
                } else {
                  onDraftChange((d) =>
                    patchChatUiOverride(d, {
                      indicator: { kind: "image", src: imageSrc, animation: imageAnimation },
                    }),
                  );
                }
              }}
              options={[
                { value: "dots", label: "Dots" },
                { value: "image", label: "Image" },
              ]}
            />
          }
        />

        {indicatorKind === "dots" ? (
          <>
            <FieldRow
              label="Color"
              control={
                <input
                  type="color"
                  value={dotsColor}
                  onChange={(e) =>
                    onDraftChange((d) =>
                      patchChatUiOverride(d, {
                        indicator: {
                          kind: "dots",
                          color: e.target.value,
                          count: dotsCount,
                        },
                      }),
                    )
                  }
                  aria-label="Dot color"
                  className="h-7 w-12 cursor-pointer rounded border border-border bg-transparent p-0.5"
                />
              }
            />
            <FieldRow
              label="Count"
              control={
                <SegmentedControl
                  ariaLabel="Dot count"
                  value={String(dotsCount) as "1" | "2" | "3"}
                  onChange={(next) =>
                    onDraftChange((d) =>
                      patchChatUiOverride(d, {
                        indicator: {
                          kind: "dots",
                          color: dotsColor,
                          count: Number(next) as 1 | 2 | 3,
                        },
                      }),
                    )
                  }
                  options={[
                    { value: "1", label: "1" },
                    { value: "2", label: "2" },
                    { value: "3", label: "3" },
                  ]}
                />
              }
            />
          </>
        ) : (
          <>
            <FieldRow
              label="Image URL"
              control={
                <Input
                  id={`${reactId}-image-src`}
                  type="url"
                  value={imageSrc}
                  placeholder="https://example.com/spinner.svg"
                  onChange={(e) =>
                    onDraftChange((d) =>
                      patchChatUiOverride(d, {
                        indicator: {
                          kind: "image",
                          src: e.target.value,
                          animation: imageAnimation,
                        },
                      }),
                    )
                  }
                  className="h-8 w-72 text-[12px]"
                />
              }
            />
            <FieldRow
              label="Animation"
              control={
                <SegmentedControl
                  ariaLabel="Image animation"
                  value={imageAnimation}
                  onChange={(next) =>
                    onDraftChange((d) =>
                      patchChatUiOverride(d, {
                        indicator: {
                          kind: "image",
                          src: imageSrc,
                          animation: next,
                        },
                      }),
                    )
                  }
                  options={[
                    { value: "pulse", label: "Pulse" },
                    { value: "spin", label: "Spin" },
                    { value: "none", label: "None" },
                  ]}
                />
              }
            />
          </>
        )}

        <div className="mt-1 flex items-center gap-2">
          <span className="text-[11px] text-muted-foreground">Preview</span>
          <span
            data-testid="appearance-indicator-preview"
            className="inline-flex items-center justify-center rounded border border-border bg-muted/30 px-2 py-1"
          >
            <PreviewIndicator />
          </span>
        </div>
      </FocusBlock>
    </div>
  );
}
