/**
 * Microsoft 365 Copilot assistant-message header.
 *
 * Matches the real Copilot UI captured via Chrome DevTools:
 *
 *   <div role="article">
 *     <h6 class="…__accessibleHeading">Copilot said:</h6>      (sr-only)
 *     <div class="…__avatar">[mascot SVG]</div>                (24×28)
 *     <div class="…__name">Copilot</div>                       (semibold)
 *     <div class="…__disclaimer"/>                             (empty)
 *   </div>
 *
 * Computed styles (filtered down to the host-relevant ones):
 *   container: display: flex; column-gap: 8px; row-gap: 8px;
 *              flex-wrap: wrap; font-family: "Segoe Sans", "Segoe UI",
 *              system-ui, sans-serif; font-size: 16px; line-height: 28px;
 *              color: --colorNeutralForeground2 (theme-dependent);
 *   avatar:    display: flex; align-items: center; (24×28 box wrapping
 *              the 24×24 SVG; SVG uses fill="currentColor")
 *   name:      font-weight: 600 (semibold); font-family: "Segoe UI"
 *              (drops the "Segoe Sans" prefix from the container);
 *              text-wrap: nowrap; inherits color/size/line-height.
 *
 * Mascot path is inlined (verbatim from the real Copilot `<svg>` markup)
 * and uses `fill="currentColor"` so the icon inherits the header's text
 * color rather than the brand gradient. We intentionally do NOT reuse
 * the colored PNG that ships at `/copilot_logo.png` for this avatar —
 * the picker pill uses that, but the thread header wants a monochromatic
 * mark that blends with the surrounding text.
 */

import { useChatboxHostTheme } from "@/contexts/chatbox-client-style-context";

const COPILOT_MARK_PATH =
  "M4.69405 17.2446C5.24991 17.2627 5.50461 17.4556 5.6798 17.688C5.91739 18.0031 6.0556 18.4507 6.24191 19.0835L6.25254 19.1196C6.41716 19.6792 6.63012 20.4032 7.07658 20.9706C7.58358 21.615 8.33343 22.0002 9.4036 22.0002H16.6324C18.1221 22.0002 19.2187 21.0356 20.0072 19.8691C20.8004 18.6957 21.3883 17.1702 21.8439 15.71L21.8455 15.7048C22.3662 14.0356 23.0272 11.9171 23.0027 10.2054C22.9903 9.33711 22.8024 8.4521 22.2166 7.78023C21.6119 7.08669 20.7049 6.75631 19.5545 6.75631H19.3132C18.7574 6.73817 18.5027 6.54526 18.3275 6.3129C18.0899 5.9978 17.9517 5.55021 17.7654 4.9174L17.7548 4.88124C17.5901 4.32166 17.3772 3.59772 16.9307 3.03026C16.4237 2.38586 15.6739 2.00073 14.6037 2.00073H7.37493C5.88524 2.00073 4.78863 2.96529 4.00007 4.13181C3.20688 5.30519 2.61901 6.83073 2.16344 8.29091L2.16184 8.29605C1.64105 9.96526 0.980067 12.0838 1.00457 13.7955C1.017 14.6638 1.20489 15.5488 1.79069 16.2207C2.39539 16.9142 3.30237 17.2446 4.45284 17.2446H4.69405ZM3.59537 8.73766C4.0389 7.31606 4.57492 5.95983 5.24277 4.97187C5.91525 3.97706 6.61685 3.50073 7.37493 3.50073H12.0042C11.8121 3.84482 11.6504 4.22569 11.505 4.61844C11.3066 5.15403 11.1225 5.75722 10.9335 6.37676L10.8914 6.51476C10.1409 8.97183 9.20203 12.1374 8.59718 14.1874C8.33206 15.0859 7.52308 15.71 6.59332 15.7432H4.60686C4.59139 15.7432 4.57602 15.7437 4.56078 15.7446H4.45284C3.58706 15.7446 3.15609 15.5042 2.92129 15.2349C2.66759 14.9439 2.51443 14.474 2.50441 13.774C2.48404 12.3508 3.0512 10.4818 3.59537 8.73766ZM18.7645 19.029C18.092 20.0238 17.3904 20.5002 16.6324 20.5002H12.0031C12.1952 20.1561 12.3569 19.7752 12.5023 19.3825C12.7007 18.8469 12.8848 18.2437 13.0738 17.6241L13.1159 17.4861C13.8664 15.0291 14.8053 11.8635 15.4101 9.81354C15.6752 8.915 16.4842 8.29091 17.414 8.2577H19.4004C19.4159 8.2577 19.4313 8.25723 19.4465 8.25631H19.5545C20.4202 8.25631 20.8512 8.4967 21.086 8.766C21.3397 9.05698 21.4929 9.52689 21.5029 10.2269C21.5233 11.6501 20.9561 13.5191 20.4119 15.2632C19.9684 16.6848 19.4324 18.0411 18.7645 19.029ZM10.4645 15.7432H9.47628C9.72189 15.408 9.9133 15.0272 10.0359 14.6118C10.3021 13.7095 10.6328 12.592 10.9834 11.4147L11.4676 9.80142C11.7427 8.88514 12.5861 8.2577 13.5428 8.2577H14.531C14.2854 8.59287 14.094 8.97365 13.9714 9.38906C13.7052 10.2913 13.3745 11.4089 13.0239 12.5862L12.5397 14.1995C12.2646 15.1158 11.4212 15.7432 10.4645 15.7432ZM13.5428 6.7577C13.118 6.7577 12.7063 6.83083 12.3217 6.96673L12.364 6.82816C12.5575 6.19441 12.7291 5.63197 12.9116 5.13945C13.1069 4.61208 13.2965 4.21677 13.4999 3.93822C13.5469 3.87377 13.6781 3.75776 13.9058 3.6561C14.1242 3.55856 14.3738 3.50073 14.6037 3.50073C15.2609 3.50073 15.5571 3.71022 15.7518 3.95776C15.9974 4.26993 16.1425 4.71607 16.3265 5.34103L16.3495 5.41956C16.4677 5.82259 16.6105 6.30927 16.8437 6.7577H13.5428ZM10.4645 17.2432C10.8893 17.2432 11.301 17.1701 11.6856 17.0342L11.6433 17.1727C11.4498 17.8065 11.2782 18.3689 11.0957 18.8614C10.9004 19.3888 10.7108 19.7841 10.5074 20.0627C10.4604 20.1271 10.3292 20.2431 10.1015 20.3448C9.88305 20.4423 9.63346 20.5002 9.4036 20.5002C8.7464 20.5002 8.45021 20.2907 8.25546 20.0431C8.00986 19.731 7.86484 19.2848 7.68084 18.6599L7.65778 18.5813C7.53959 18.1783 7.39685 17.6916 7.16357 17.2432H10.4645Z";

const COPILOT_HEADER_FONT_FAMILY =
  '"Segoe Sans", "Segoe UI", "Segoe UI Web (West European)", -apple-system, BlinkMacSystemFont, Roboto, "Helvetica Neue", sans-serif';

// Name uses --fontFamilyBase (no "Segoe Sans" prefix) — re-targets the
// system Segoe UI face rather than the brand Segoe Sans one.
const COPILOT_NAME_FONT_FAMILY =
  '"Segoe UI", "Segoe UI Web (West European)", -apple-system, BlinkMacSystemFont, Roboto, "Helvetica Neue", sans-serif';

// --colorNeutralForeground2 from Copilot's Fluent palette, per theme.
// Dark = #d6d6d6 (captured from the real product's DevTools dump).
// Light = #424242 (Fluent's standard secondary-text token; matches the
// charcoal "Copilot" wordmark in M365's light surface).
const COPILOT_TEXT_COLOR_DARK = "#d6d6d6";
const COPILOT_TEXT_COLOR_LIGHT = "#424242";

/**
 * Renders the "Copilot" name + mascot row above an assistant message,
 * faithful to the markup the real product ships. Kept inert (no
 * interactions, no model/api dependencies) so it can be dropped above
 * any assistant message bubble.
 */
export function CopilotMessageHeader() {
  // The chatbox host theme follows the host config's `hostContext.theme`
  // (light/dark). Defaults to dark when no chatbox context is mounted —
  // matches the rest of the inspector's chat shell fallback.
  const chatboxHostTheme = useChatboxHostTheme();
  const color =
    chatboxHostTheme === "light"
      ? COPILOT_TEXT_COLOR_LIGHT
      : COPILOT_TEXT_COLOR_DARK;

  return (
    <div
      data-testid="copilot-message-header"
      data-theme={chatboxHostTheme ?? "dark"}
      role="article"
      style={{
        display: "flex",
        alignItems: "center",
        columnGap: 8,
        rowGap: 8,
        flexWrap: "wrap",
        fontFamily: COPILOT_HEADER_FONT_FAMILY,
        fontSize: 16,
        lineHeight: "28px",
        color,
      }}
    >
      {/* sr-only — mirrors the real Copilot a11y heading.
          Tailwind's `sr-only` would do, but inlining keeps this component
          independent of the project's utility classes. */}
      <h6
        style={{
          position: "absolute",
          width: 1,
          height: 1,
          padding: 0,
          margin: -1,
          overflow: "hidden",
          clip: "rect(0, 0, 0, 0)",
          whiteSpace: "nowrap",
          border: 0,
        }}
      >
        Copilot said:
      </h6>
      <div
        data-testid="copilot-message-header-avatar"
        style={{
          display: "flex",
          alignItems: "center",
          width: 24,
          height: 28,
        }}
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="24"
          height="24"
          viewBox="0 0 24 24"
          fill="none"
          aria-label="Copilot's Logo"
          role="img"
        >
          <path d={COPILOT_MARK_PATH} fill="currentColor" />
        </svg>
      </div>
      <div
        data-testid="copilot-message-header-name"
        style={{
          fontFamily: COPILOT_NAME_FONT_FAMILY,
          fontWeight: 600,
          fontSize: "inherit",
          lineHeight: "inherit",
          color: "inherit",
          alignContent: "center",
          whiteSpace: "nowrap",
        }}
      >
        Copilot
      </div>
    </div>
  );
}
