/**
 * Where an organization admin turns credential export back on. A refusal under
 * the organization's credential export policy ends with it, so the member who
 * was refused, or the admin they ask, can find the switch.
 *
 * It names the Organization settings label (`OrganizationSecuritySection`)
 * and matches the backend's `CREDENTIAL_EXPORT_SETTING_HINT`, which ends the
 * backend's own refusals. Change all three together.
 */
export const CREDENTIAL_EXPORT_SETTING_HINT =
  "Ask an organization admin to turn on Allow credential export in Organization settings under Security.";
