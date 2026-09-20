# Platform launch announcement (BB-255)

Task: https://app.kestral.ai/workspace/yhNILB2/task/1Lc811Qi
Launch: https://www.mcpjam.com/blog/our-new-platform

Add a compact, clickable bottom-left announcement for everyone: the existing
swarm characters above a 2x2 feature grid. Opening it defaults to a click-to-play YouTube launch tab, followed by
Swarm, User Testing, Evaluate, and CI/CD tabs using supplied product images.
The announcement stays visible after opening; only explicit X dismissal hides it.
The centered compact Learn more CTA and product navigation actions use the shared
primary button. Neutral bordered tabs, the theme-aware MCPJam logo, and a subtle
primary-token orange dialog glow complete the user-approved design.
Feature actions navigate inside the app; CI/CD opens the current Evaluate tab,
following the existing What's new preview-to-detail pattern. Keep initial discovery
non-blocking, remember seen/dismissed status per launch in this browser across sign-in, and support keyboard navigation, small viewports,
reduced motion, and both themes.

Validation: announcement visibility/dismissal persistence; detail open/close and
keyboard focus; launch links and feature navigation; design checks and client checks.

## Engagement telemetry

PostHog event: `platform_launch_engagement` (through the shared `track` helper).
Axiom event: `launch.engagement` (validated POST to `/tlm/launch-engagement`).
Join individual deliveries with `event_id`; filter this launch by
`launch_id = platform-launch-2026-09` and use `action` for the funnel:
`shown → opened → feature_selected → feature_navigated`.
The `launch-video` feature identifies the opening tab and video requests.

Also records `video_requested`, `dismissed`, and `closed` (with modal duration
and dismiss/back-to-work/navigation reason). A video request is not proof of
playback. Events include feature, card presentation, prior
seen state, and guest/signed-in audience; Axiom values are client-reported,
not authenticated identity. PostHog keeps its existing anonymous/person identity.

Impressions fire once per mount after the trigger intersects the viewport, not
on rerenders or for dismissed cards. Both destinations honor PostHog opt-out
and the local-disable flag. Delivery is best-effort and never blocks UI; no
production-delivery assertion is made by local tests. The public Axiom route
uses the existing relay rate limit, a 2 KB body cap, and a strict field schema;
it accepts no free-form user content or credentials.

## Review fixes

Mount outside the mobile sidebar sheet and wait for hosted auth resolution before
recording audience. Keep the full announcement regardless of sidebar collapse, as
requested; the obsolete collapsed prop is removed. Swarm/User Testing remain
previewable but their actions are disabled when the sandbox rollout is off.
The telemetry endpoint requires close reason and duration only for closed events.
