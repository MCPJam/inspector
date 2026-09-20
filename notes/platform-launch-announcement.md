# Platform launch announcement (BB-255)

Task: https://app.kestral.ai/workspace/yhNILB2/task/1Lc811Qi
Launch: https://www.mcpjam.com/blog/our-new-platform

Add a compact, clickable bottom-left announcement for everyone: the existing
swarm characters above a 2x2 feature grid. Opening it reveals illustrated
Swarm, User Testing, Evals, and CI/CD tabs, with an optional launch video.
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

Also records `video_requested`, `dismissed`, and `closed` (with modal duration
and dismiss/back-to-work/navigation reason). A video request is not proof of
playback. Events include feature, card/launcher/collapsed presentation, prior
seen state, and guest/signed-in audience; Axiom values are client-reported,
not authenticated identity. PostHog keeps its existing anonymous/person identity.

Impressions fire once per mount after the trigger intersects the viewport, not
on rerenders or for dismissed cards. Both destinations honor PostHog opt-out
and the local-disable flag. Delivery is best-effort and never blocks UI; no
production-delivery assertion is made by local tests. The public Axiom route
uses the existing relay rate limit, a 2 KB body cap, and a strict field schema;
it accepts no free-form user content or credentials.
