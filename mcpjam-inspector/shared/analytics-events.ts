/**
 * Shared analytics event registry.
 *
 * Every product analytics event name lives here, typed, with its
 * authoritative capture source. Client code sends events through
 * `client/src/lib/analytics.ts#track`, which only accepts names from this
 * registry; server code sends through `server/utils/analytics.ts` the same
 * way. Free-string `posthog.capture("...")` calls are frozen by the ratchet
 * test in `client/src/lib/__tests__/analytics-ratchet.test.ts` — new call
 * sites must register here and use `track()`.
 *
 * `source` marks the ONE authoritative capture point for the event:
 *  - "client": fired from the browser (reaches PostHog via the /relay proxy)
 *  - "server": fired from the Hono server / backend (cannot be ad-blocked)
 *
 * Server twins: while a client event migrates to server-side capture, the
 * server fires `<name>_server` in parallel. The client/server pair ratio per
 * platform IS the live ad-block rate (see the block-rate dashboard). After
 * the parallel-run window, the server event takes the canonical name and the
 * client twin is deleted.
 *
 * Events are migrated into this registry incrementally, area by area — the
 * ratchet test keeps unmigrated legacy call sites frozen at their current
 * files in the meantime.
 */

export const ANALYTICS_EVENTS = {
  // --- Chat (paired: client event + server twin) ---
  send_message: { source: "client" },
  send_message_server: { source: "server" },
  // Client-only by design: the twin is deliberately absent. A rewind re-sends
  // through the normal turn path, so the server already counts it as
  // `send_message_server`; an `edit_message_server` would double-count the same
  // inference. `ChatTabV2.tsx` relies on there being no twin to reconcile
  // against when a rewind is refused.
  edit_message: { source: "client" },

  // --- Tool execution (paired) ---
  execute_tool: { source: "client" },
  execute_tool_server: { source: "server" },

  // --- Eval runs (paired) ---
  eval_suite_run_started: { source: "client" },
  eval_suite_run_started_server: { source: "server" },

  // --- Public API agent surface (server-authoritative; no client twin) ---
  api_agent_turn_completed: { source: "server" },
  /**
   * One agent Playground turn finished (`POST /v1/chat-sessions/messages`).
   * Outcome/count/duration only — the messages and tool payloads on that
   * route are customer conversation content and never ride an event.
   */
  api_chat_session_turn_completed: { source: "server" },

  // --- Directory readiness (server-authoritative; no client twin) ---
  /**
   * A hosted readiness run was accepted. Fired from the v1 start route, which
   * is the only way a hosted run is created, so it covers every surface that
   * ever starts one (REST, MCP worker, agent approval, chat, CLI) without
   * instrumenting each.
   *
   * `deduped` is why this fires on a replay too: a retried start that returned
   * an existing run is a real request the caller made, and counting only fresh
   * runs would understate demand while hiding a client that retries badly.
   *
   * The SERVER URL IS NEVER SENT — it names somebody's private endpoint, and
   * no launch question needs it.
   */
  directory_readiness_run_started_server: { source: "server" },
  /**
   * A hosted readiness run reached a terminal state. Fired from the detached
   * worker, so it is attributed through `captureServerEventForActor` to the
   * identity resolved back when the request still existed.
   *
   * Carries the THREE AXES separately, because collapsing them is the exact
   * misreading the product exists to prevent: `status` is whether the run
   * completed, `overall_status` is the grade, and `llm_observation_status` /
   * `llm_observation_reason` are whether the optional paid pass ran. A run can
   * be `completed` + `not-ready` + `billing-blocked` and all three matter.
   *
   * NO REPORT CONTENTS. Findings carry the raw observation behind a verdict;
   * an analytics pipeline is the last place that belongs.
   */
  directory_readiness_run_finished_server: { source: "server" },
  /**
   * One `GET /projects/{p}/sessions` search, emitted from the proxy route —
   * the chokepoint every surface (in-app chat, MCP worker, REST, CLI) funnels
   * through, so one event covers all four instead of four instrumentations
   * that could drift.
   *
   * Exists to answer ONE question: does lexical search suffice, or is semantic
   * search worth building? The signal is `scope`, `itemCount`, and whether the
   * caller pages or re-queries. The QUERY STRING is never sent — search terms
   * are user content and can carry names or secrets someone pasted in.
   *
   * RE-QUERY ANALYSIS FROM THIS EVENT IS AN APPROXIMATION, and reading it as
   * exact will overstate what it shows. `distinct_id` plus timestamps identify
   * NEARBY SEARCHES BY THE SAME CREDENTIAL, not true refinement chains: no
   * conversation identity crosses the proxy, so two agents working in parallel
   * under one API key look identical to one agent refining its query. Use it
   * for order-of-magnitude reads ("are zero-result searches common?"), not for
   * precise funnels. If that coarseness turns out to block the
   * semantic-search decision, the named follow-up is a privacy-safe
   * per-conversation search-attempt id — deliberately NOT built now, because
   * it is a new identifier crossing a public boundary and should not be minted
   * on the chance it might be useful.
   */
  api_sessions_search: { source: "server" },

  // --- Skills (exemplar migrated area) ---
  skill_deleted: { source: "client" },
  skill_promoted: { source: "client" },
  skill_viewed: { source: "client" },
  skill_uploaded: { source: "client" },
  skill_injected: { source: "client" },
  skill_loaded: { source: "client" },

  // --- Auth / activation funnel (migrated) ---
  login_button_clicked: { source: "client" },
  sign_up_button_clicked: { source: "client" },
  signup_occupation_submitted: { source: "client" },

  // --- Billing / revenue funnel (migrated) ---
  billing_upsell_gate_viewed: { source: "client" },
  credit_topup_checkout_started: { source: "client" },
  credit_topup_checkout_failed: { source: "client" },
  credit_topup_return_cancelled: { source: "client" },
  credit_topup_return_success: { source: "client" },

  // --- Migrated raw-capture call sites (track() migration) ---
  add_server_button_clicked: { source: "client" },
  app_builder_send_message: { source: "client" },
  app_builder_tab_viewed: { source: "client" },
  app_builder_tool_executed: { source: "client" },
  app_launched: { source: "client" },
  cancel_button_clicked: { source: "client" },
  chat_attachment_button_clicked: { source: "client" },
  chat_cleared: { source: "client" },
  // "Change protocol version" on the chat error banner, shown when a
  // connection pins an MCP protocol version the server doesn't offer; props:
  // location, has_host_id (false ⇒ the link fell back to the clients list).
  change_protocol_version_clicked: { source: "client" },
  chat_model_selector_clicked: { source: "client" },
  chat_model_selector_manage_org_models_clicked: { source: "client" },
  chat_options_plus_clicked: { source: "client" },
  // Every starter-chip surface fires this one event; props: prompt (chip
  // text), location: chat_tab | playground_single | playground_compare.
  chat_starter_prompt_clicked: { source: "client" },
  chat_tab_viewed: { source: "client" },
  chat_voice_input_recording_canceled: { source: "client" },
  chat_voice_input_recording_started: { source: "client" },
  chat_voice_input_recording_stopped: { source: "client" },
  scenario_bootstrap_silent_failure: { source: "client" },
  scenario_bootstrap_silent_success: { source: "client" },
  scenario_bootstrap_started: { source: "client" },
  client_builder_viewed: { source: "client" },
  client_config_saved: { source: "client" },
  client_created: { source: "client" },
  client_deleted: { source: "client" },
  client_selected: { source: "client" },
  compare_model_completed: { source: "client" },
  compare_run_started: { source: "client" },
  compare_run_tab_changed: { source: "client" },
  compare_run_view_opened: { source: "client" },
  compat_cta_clicked: { source: "client" },
  computer_chat_attachment_uploaded: { source: "client" },
  computer_start_limit_hit: { source: "client" },
  computer_terminal_opened: { source: "client" },
  // --- Local computer engine ("This machine") ---
  // Content-free by construction: props are enums/booleans only. NEVER a
  // command, a path, a workspace dir, an OS username, or a consent token.
  // computer_engine_selected: the user moved the Local⇄Cloud toggle {engine}.
  // local_computer_consent_gate_shown: the consent gate rendered.
  // local_computer_consent_granted / _denied: Allow / "Use cloud instead" —
  //   the only two affordances on the gate.
  // local_computer_consent_reauthorized: "Forget & re-authorize" (the stale-
  //   capability recovery path).
  // local_terminal_unavailable: the local terminal could not be offered
  //   {reason} — an enum, never a node-pty error string.
  computer_engine_selected: { source: "client" },
  local_computer_consent_denied: { source: "client" },
  local_computer_consent_gate_shown: { source: "client" },
  local_computer_consent_granted: { source: "client" },
  local_computer_consent_reauthorized: { source: "client" },
  local_terminal_unavailable: { source: "client" },
  connect_host_overlay_add_clicked: { source: "client" },
  connect_host_overlay_opened: { source: "client" },
  connect_host_overlay_quick_added: { source: "client" },
  connect_host_overlay_saved_as_new: { source: "client" },
  connect_host_overlay_swapped: { source: "client" },
  // Connect's primary tab switcher (Servers | Client | Computer | Skills).
  // Skills moved out of the sidebar into this switcher, so this replaces the
  // `sidebar_nav_clicked` signal for skills entries.
  connect_view_selected: { source: "client" },
  connecting_server: { source: "client" },
  connection_switch_toggled: { source: "client" },
  copy_agent_brief_clicked: { source: "client" },
  create_test_case_button_clicked: { source: "client" },
  create_tunnel_button_clicked: { source: "client" },
  credit_topup_cta_clicked: { source: "client" },
  credit_topup_history_viewed: { source: "client" },
  credit_topup_receipt_opened: { source: "client" },
  edit_server_clicked: { source: "client" },
  eval_excalidraw_quickstart_clicked: { source: "client" },
  eval_excalidraw_quickstart_completed: { source: "client" },
  eval_export_modal_copied: { source: "client" },
  eval_export_modal_downloaded: { source: "client" },
  eval_export_modal_opened: { source: "client" },
  eval_generate_negative_tests_button_clicked: { source: "client" },
  eval_generate_tests_button_clicked: { source: "client" },
  eval_generate_tests_completed: { source: "client" },
  eval_run_insights_opened: { source: "client" },
  eval_setup_next_step_button_clicked: { source: "client" },
  eval_setup_start_eval_run_button_clicked: { source: "client" },
  eval_suite_created: { source: "client" },
  eval_suite_duplicated: { source: "client" },
  eval_suite_run_start_requests_completed: { source: "client" },
  eval_suite_server_changed: { source: "client" },
  eval_test_case_created: { source: "client" },
  eval_test_case_deleted: { source: "client" },
  eval_test_case_duplicated: { source: "client" },
  eval_test_case_edited: { source: "client" },
  eval_test_case_run_completed: { source: "client" },
  eval_test_case_run_started: { source: "client" },
  eval_tests_generated_from_sidebar: { source: "client" },
  evals_cross_host_viewed: { source: "client" },
  evaluate_tab_viewed: { source: "client" },
  export_server_clicked: { source: "client" },
  generate_tests_button_clicked: { source: "client" },
  guest_refresh_failure: { source: "client" },
  guest_refresh_success: { source: "client" },
  host_capabilities_dialog_opened: { source: "client" },
  host_catalog_degraded: { source: "client" },
  hosted_model_catalog_degraded: { source: "client" },
  hosted_provider_logo_missing: { source: "client" },
  host_compat_tab_viewed: { source: "client" },
  host_context_dialog_opened: { source: "client" },
  host_theme_toggled: { source: "client" },
  host_toolbar_capability_toggled: { source: "client" },
  host_toolbar_csp_changed: { source: "client" },
  host_toolbar_device_changed: { source: "client" },
  host_toolbar_locale_changed: { source: "client" },
  host_toolbar_opened: { source: "client" },
  host_toolbar_timezone_changed: { source: "client" },
  import_json_button_clicked: { source: "client" },
  interactive_signin_required: { source: "client" },
  logger_cleared: { source: "client" },
  logger_collapsed: { source: "client" },
  logger_copy_clicked: { source: "client" },
  logger_download_clicked: { source: "client" },
  logger_log_level_changed: { source: "client" },
  logger_search_used: { source: "client" },
  logger_source_filter_changed: { source: "client" },
  mcpjam_agent_back: { source: "client" },
  mcpjam_agent_message_sent: { source: "client" },
  mcpjam_agent_new_chat: { source: "client" },
  mcpjam_agent_panel_closed: { source: "client" },
  mcpjam_agent_panel_handoff: { source: "client" },
  mcpjam_agent_panel_handoff_skipped: { source: "client" },
  mcpjam_agent_panel_opened: { source: "client" },
  mcpjam_agent_panel_resized: { source: "client" },
  mcpjam_agent_response_error: { source: "client" },
  mcpjam_agent_response_finished: { source: "client" },
  mcpjam_agent_resume: { source: "client" },
  mcpjam_agent_submit: { source: "client" },
  mcpjam_agent_suggested_prompt: { source: "client" },
  mcpjam_agent_tour_launch_skipped: { source: "client" },
  mcpjam_agent_tour_launched: { source: "client" },
  move_server_to_project_clicked: { source: "client" },
  /**
   * A connected server was offered to the organization's registry from the
   * server card's menu. Fires on the CLICK, before the eligibility refusal —
   * how often people reach for it and are told a header-authed server cannot
   * be shared is the thing worth knowing.
   */
  share_server_to_org_registry_clicked: { source: "client" },
  /**
   * A callback arrived with a pending server name but no stored flow session,
   * so it could not be completed and the user was asked to reauthorize.
   *
   * Expected to be rare and to spike briefly around a deploy that changes the
   * stored session shape. A sustained rate means something is clearing flow
   * state that should not be.
   */
  oauth_callback_no_session_recovery: { source: "client" },
  oauth_debugger_error_boundary: { source: "client" },
  oauth_flow_tab_next_step_button_clicked: { source: "client" },
  oauth_flow_tab_viewed: { source: "client" },
  ollama_running: { source: "client" },
  onboarding_completed: { source: "client" },
  onboarding_connect_excalidraw_auto: { source: "client" },
  onboarding_connect_excalidraw_clicked: { source: "client" },
  onboarding_connect_excalidraw_error: { source: "client" },
  onboarding_connect_excalidraw_success: { source: "client" },
  onboarding_first_run_eligible: { source: "client" },
  playground_compare_lead_promoted: { source: "client" },
  playground_left_rail_tab_changed: { source: "client" },
  playground_right_rail_tab_changed: { source: "client" },
  playground_tab_viewed: { source: "client" },
  playground_tool_run_clicked: { source: "client" },
  playground_tools_pane_tab_changed: { source: "client" },
  playground_tools_refresh_clicked: { source: "client" },
  // --- Free-plan limit walls (PlanLimitDialog) ---
  // One impression per opening, then explicit user actions and checkout
  // outcomes. `limit_kind` distinguishes which cap was hit so we can compare
  // which wall converts. Person data comes from the global identified profile,
  // not duplicated PII in these events.
  plan_limit_dialog_shown: { source: "client" },
  plan_limit_sign_in_clicked: { source: "client" },
  plan_limit_buy_credits_clicked: { source: "client" },
  plan_limit_byok_clicked: { source: "client" },
  plan_limit_interval_selected: { source: "client" },
  plan_limit_upgrade_clicked: { source: "client" },
  plan_limit_upgrade_failed: { source: "client" },
  plan_limit_upgrade_resolved: { source: "client" },
  plan_limit_upgrade_returned: { source: "client" },
  plan_limit_dialog_dismissed: { source: "client" },
  plan_limit_enterprise_cta_clicked: { source: "client" },
  plan_limit_upgrade_requested: { source: "client" },
  credit_topup_dialog_shown: { source: "client" },
  credit_topup_package_selected: { source: "client" },
  credit_topup_dialog_dismissed: { source: "client" },
  // --- OpenAI plugin import (Connect "Add plugin", INS-2) ---
  // Props are built by `client/src/lib/plugins/plugin-analytics.ts`, which
  // exists to keep bundle paths, server URLs, env/header names, and plugin
  // display names OUT of these payloads: counts, closed enums, stable codes,
  // and a bundle-hash prefix only.
  add_plugin_button_clicked: { source: "client" },
  plugin_component_configured: { source: "client" },
  plugin_disabled: { source: "client" },
  plugin_import_completed: { source: "client" },
  plugin_import_failed: { source: "client" },
  plugin_import_previewed: { source: "client" },
  plugin_import_started: { source: "client" },
  plugin_uninstalled: { source: "client" },
  plugin_version_upgraded: { source: "client" },
  project_invite_sent: { source: "client" },
  project_member_removed: { source: "client" },
  project_members_facepile_clicked: { source: "client" },
  project_share_button_clicked: { source: "client" },
  project_visibility_changed: { source: "client" },
  reconnect_server_clicked: { source: "client" },
  refresh_tools_clicked: { source: "client" },
  remove_server_clicked: { source: "client" },
  run_all_cases_button_clicked: { source: "client" },
  run_selected_case_button_clicked: { source: "client" },
  save_api_key: { source: "client" },
  save_tool_button_clicked: { source: "client" },
  saved_request_item_loaded: { source: "client" },
  server_card_clicked: { source: "client" },
  server_detail_modal_closed: { source: "client" },
  server_detail_modal_connect_clicked: { source: "client" },
  server_detail_modal_disconnect_clicked: { source: "client" },
  server_detail_modal_opened: { source: "client" },
  servers_tab_viewed: { source: "client" },
  share_dialog_opened: { source: "client" },
  sidebar_nav_clicked: { source: "client" },
  stateless_protocol_connect: { source: "client" },
  suite_viewed: { source: "client" },
  swarm_create_generate_completed: { source: "client" },
  swarm_create_generate_started: { source: "client" },
  swarm_create_launched: { source: "client" },
  swarm_generate_journeys_completed: { source: "client" },
  swarm_generate_journeys_started: { source: "client" },
  swarm_generate_persona_completed: { source: "client" },
  swarm_generate_persona_started: { source: "client" },
  tools_tab_viewed: { source: "client" },
  trace_raw_copied: { source: "client" },
  trace_span_clicked: { source: "client" },
  trace_view_mode_changed: { source: "client" },
  tunnel_closed: { source: "client" },
  tunnel_created: { source: "client" },
  tunnel_rotated: { source: "client" },
  update_server_button_clicked: { source: "client" },
  xaa_flow_completed: { source: "client" },
  xaa_flow_started: { source: "client" },
  xaa_resource_app_saved: { source: "client" },
  xaa_tab_viewed: { source: "client" },
  playground_compare_host_removed: { source: "client" },
  playground_compare_host_added: { source: "client" },

  // --- UI-only agent chat: ui_* tool + turn outcomes ---
  // Props are ids/names/booleans/counts/durations ONLY — never message
  // text, tool args, tool outputs, URLs, headers, or env values.
  // agent_turn_completed: one agent-chat turn finished (model/provider,
  //   ui-tool counts, token counts, duration, had_error).
  // ui_navigation_rejected: resolveUiNavigationTarget refused a segment
  //   (reason: unknown | hosted_blocked).
  // ui_tool_call_started / ui_tool_call_completed: lifecycle of one ui_*
  //   client-fulfilled tool call (outcome, approval, structured error code,
  //   duplicate-call detection).
  // agent_ask_user_resolved: one clarifying question settled. Payload:
  //   location, outcome (selected | freeText | dismissed), option_count,
  //   time_to_answer_ms, and — on a dismissal only — dismiss_reason
  //   (new_message | stopped | session_evicted).
  //   The ask-threshold tuning signal: a high freeText share means the
  //   model's options are wrong; a high dismissed share means it is
  //   over-asking. The question, its labels, and any free-text answer are
  //   the user's own words and are NEVER emitted.
  agent_ask_user_resolved: { source: "client" },
  agent_turn_completed: { source: "client" },
  ui_navigation_rejected: { source: "client" },
  ui_tool_call_completed: { source: "client" },
  ui_tool_call_started: { source: "client" },

  // --- Home: shared Slack Connect channel card ---
  // Flag-dark (`shared-slack-channel-enabled`). Props: location ("home"),
  // state (none | provisioning | invite_sent | pending_admin_approval |
  // active | invite_declined | invite_expired | error).
  home_shared_slack_card_viewed: { source: "client" },
  home_shared_slack_provision_clicked: { source: "client" },
  home_shared_slack_invite_opened: { source: "client" },
  home_shared_slack_retry_clicked: { source: "client" },
  home_shared_slack_channel_opened: { source: "client" },
} as const satisfies Record<string, { source: "client" | "server" }>;

export type AnalyticsEventName = keyof typeof ANALYTICS_EVENTS;

type EventNamesBySource<S extends "client" | "server"> = {
  [K in AnalyticsEventName]: (typeof ANALYTICS_EVENTS)[K]["source"] extends S
    ? K
    : never;
}[AnalyticsEventName];

/**
 * Event names whose authoritative source is the browser. The client `track()`
 * wrapper accepts only these, so server-authoritative twins (e.g.
 * `send_message_server`) can't be emitted from the client and corrupt the
 * client/server block-rate ratio.
 */
export type ClientAnalyticsEventName = EventNamesBySource<"client">;

/** Event names whose authoritative source is the server. */
export type ServerAnalyticsEventName = EventNamesBySource<"server">;
