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

  // --- Tool execution (paired) ---
  execute_tool: { source: "client" },
  execute_tool_server: { source: "server" },

  // --- Eval runs (paired) ---
  eval_suite_run_started: { source: "client" },
  eval_suite_run_started_server: { source: "server" },

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
  chat_model_selector_clicked: { source: "client" },
  chat_options_plus_clicked: { source: "client" },
  chat_starter_prompt_clicked: { source: "client" },
  chat_tab_viewed: { source: "client" },
  chat_voice_input_recording_canceled: { source: "client" },
  chat_voice_input_recording_started: { source: "client" },
  chat_voice_input_recording_stopped: { source: "client" },
  chatbox_bootstrap_silent_failure: { source: "client" },
  chatbox_bootstrap_silent_success: { source: "client" },
  chatbox_bootstrap_started: { source: "client" },
  chatbox_generate_personas_completed: { source: "client" },
  chatbox_generate_personas_started: { source: "client" },
  chatbox_simulate_sessions_completed: { source: "client" },
  chatbox_simulate_sessions_started: { source: "client" },
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
  computer_start_limit_hit: { source: "client" },
  computer_terminal_opened: { source: "client" },
  connect_host_overlay_add_clicked: { source: "client" },
  connect_host_overlay_opened: { source: "client" },
  connect_host_overlay_quick_added: { source: "client" },
  connect_host_overlay_saved_as_new: { source: "client" },
  connect_host_overlay_swapped: { source: "client" },
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
  move_server_to_project_clicked: { source: "client" },
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
