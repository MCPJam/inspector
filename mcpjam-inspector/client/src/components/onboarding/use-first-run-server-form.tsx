/**
 * Form state for the first-run server details and authorization steps: the
 * URL, transport, and every authentication field that `AuthenticationSection`
 * edits, plus validation and the draft the parent saves and connects.
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import { AuthenticationSection } from "@/components/connection/shared/AuthenticationSection";
import { useConfidentialCimdCapability } from "@/hooks/use-confidential-cimd-capability";
import {
  getConfidentialCimdBlockReason,
  validateOAuthClientId,
  validateOAuthClientSecret,
} from "@/lib/server-form-validation";
import { XAA_PARTIAL_OVERRIDE_ERROR } from "@/lib/xaa/identity";
import type {
  ServerFormAuthType,
  ServerFormOAuthProtocolMode,
} from "@/shared/types.js";
import type { RegistrationMode, XaaClientAuthMethod } from "@/shared/xaa.js";

export interface FirstRunServerDraft {
  name: string;
  transport: "http" | "stdio";
  urlOrCommand: string;
  authentication: ServerFormAuthType;
  bearerToken?: string;
  oauthProtocolMode?: ServerFormOAuthProtocolMode;
  registrationMode?: RegistrationMode;
  oauthScopes?: string[];
  clientId?: string;
  clientSecret?: string;
  clearClientSecret?: boolean;
  /** Recovery-only metadata; the secret itself is never copied into the draft. */
  hasStoredClientSecret?: boolean;
  projectId?: string | null;
  hostedServerId?: string | null;
  oauthAllowPathScopedIssuer?: boolean;
  xaaClientAuth?: XaaClientAuthMethod;
  xaaAuthzIssuer?: string;
  xaaAllowPathScopedIssuer?: boolean;
  xaaSubject?: string;
  xaaEmail?: string;
}

export function useFirstRunServerForm({
  open,
  connectionStatus,
  recoveryServerDraft,
  organizationId,
  isSignedIn,
  contentRef,
}: {
  open: boolean;
  connectionStatus: string;
  recoveryServerDraft?: FirstRunServerDraft;
  organizationId?: string | null;
  isSignedIn?: boolean;
  contentRef: RefObject<HTMLDivElement | null>;
}) {
  const hydratedRecoveryDraftKeyRef = useRef<string | null>(null);
  const [serverUrlOrCommand, setServerUrlOrCommand] = useState("");
  const [serverUrlError, setServerUrlError] = useState<string | null>(null);
  const [serverName, setServerName] = useState("");
  const [serverTransport, setServerTransport] = useState<"http" | "stdio">(
    "http",
  );
  const [serverAuthentication, setServerAuthentication] =
    useState<FirstRunServerDraft["authentication"]>("auto");
  const [bearerToken, setBearerToken] = useState("");
  const [bearerTokenError, setBearerTokenError] = useState<string | null>(null);
  const bearerTokenInputRef = useRef<HTMLInputElement>(null);
  const [oauthScopesInput, setOauthScopesInput] = useState("");
  const [oauthProtocolMode, setOauthProtocolMode] =
    useState<ServerFormOAuthProtocolMode>("auto");
  const [registrationMode, setRegistrationMode] =
    useState<RegistrationMode>("auto");
  const [oauthAllowPathScopedIssuer, setOauthAllowPathScopedIssuer] =
    useState(false);
  const [useCustomClientId, setUseCustomClientId] = useState(false);
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [clearClientCredentials, setClearClientCredentials] = useState(false);
  const [clearStoredClientSecret, setClearStoredClientSecret] = useState(false);
  const [hasStoredClientSecret, setHasStoredClientSecret] = useState(false);
  const [savedClientId, setSavedClientId] = useState("");
  const [clientIdError, setClientIdError] = useState<string | null>(null);
  const [clientSecretError, setClientSecretError] = useState<string | null>(
    null,
  );
  const [xaaConfigurationError, setXaaConfigurationError] = useState<
    string | null
  >(null);
  const [xaaClientAuth, setXaaClientAuth] =
    useState<XaaClientAuthMethod>("none");
  const [xaaAuthzIssuer, setXaaAuthzIssuer] = useState("");
  const [xaaAllowPathScopedIssuer, setXaaAllowPathScopedIssuer] =
    useState(false);
  const [xaaSubject, setXaaSubject] = useState("");
  const [xaaEmail, setXaaEmail] = useState("");
  const wantsConfidentialCimd =
    serverAuthentication === "xaa" &&
    registrationMode === "cimd" &&
    xaaClientAuth === "private_key_jwt";
  const confidentialCimdCapability = useConfidentialCimdCapability({
    // Probe before the private option is selected; the picker itself depends
    // on this capability becoming ready.
    enabled:
      open && serverAuthentication === "xaa" && registrationMode === "cimd",
    organizationId,
    isSignedIn,
  });
  const confidentialCimdBlockReason = getConfidentialCimdBlockReason(
    wantsConfidentialCimd,
    confidentialCimdCapability.status,
  );

  useEffect(() => {
    const recoveryDraftKey = recoveryServerDraft
      ? `${recoveryServerDraft.name}\u0000${recoveryServerDraft.urlOrCommand}`
      : null;
    if (
      connectionStatus !== "authorization-required" ||
      !recoveryServerDraft ||
      serverUrlOrCommand.trim() ||
      hydratedRecoveryDraftKeyRef.current === recoveryDraftKey
    ) {
      return;
    }

    hydratedRecoveryDraftKeyRef.current = recoveryDraftKey;
    setServerName((current) => current || recoveryServerDraft.name);
    setServerUrlOrCommand(
      (current) => current || recoveryServerDraft.urlOrCommand,
    );
    setServerTransport(recoveryServerDraft.transport);
    setServerAuthentication(recoveryServerDraft.authentication);
    setOauthProtocolMode(recoveryServerDraft.oauthProtocolMode ?? "auto");
    setRegistrationMode(recoveryServerDraft.registrationMode ?? "auto");
    setOauthScopesInput((recoveryServerDraft.oauthScopes ?? []).join(" "));
    setClientId(recoveryServerDraft.clientId ?? "");
    setSavedClientId(recoveryServerDraft.clientId ?? "");
    setHasStoredClientSecret(
      recoveryServerDraft.hasStoredClientSecret ?? false,
    );
    setClearStoredClientSecret(false);
    setUseCustomClientId(Boolean(recoveryServerDraft.clientId));
    setClientSecret(recoveryServerDraft.clientSecret ?? "");
    setClearClientCredentials(false);
    setOauthAllowPathScopedIssuer(
      recoveryServerDraft.oauthAllowPathScopedIssuer ?? false,
    );
    setXaaClientAuth(recoveryServerDraft.xaaClientAuth ?? "none");
    setXaaAuthzIssuer(recoveryServerDraft.xaaAuthzIssuer ?? "");
    setXaaAllowPathScopedIssuer(
      recoveryServerDraft.xaaAllowPathScopedIssuer ?? false,
    );
    setXaaSubject(recoveryServerDraft.xaaSubject ?? "");
    setXaaEmail(recoveryServerDraft.xaaEmail ?? "");
  }, [connectionStatus, recoveryServerDraft, serverUrlOrCommand]);

  const resetServerDraft = useCallback(() => {
    setServerUrlOrCommand("");
    setServerUrlError(null);
    setServerName("");
    setServerTransport("http");
    setServerAuthentication("auto");
    setBearerToken("");
    setBearerTokenError(null);
    setOauthScopesInput("");
    setOauthProtocolMode("auto");
    setRegistrationMode("auto");
    setOauthAllowPathScopedIssuer(false);
    setUseCustomClientId(false);
    setClientId("");
    setClientSecret("");
    setClearClientCredentials(false);
    setClearStoredClientSecret(false);
    setHasStoredClientSecret(false);
    setSavedClientId("");
    setClientIdError(null);
    setClientSecretError(null);
    setXaaConfigurationError(null);
    setXaaClientAuth("none");
    setXaaAuthzIssuer("");
    setXaaAllowPathScopedIssuer(false);
    setXaaSubject("");
    setXaaEmail("");
  }, []);

  const changeServerAuthentication = useCallback(
    (value: ServerFormAuthType) => {
      if (
        (serverAuthentication === "auto" ||
          serverAuthentication === "oauth" ||
          serverAuthentication === "xaa") &&
        value !== "auto" &&
        value !== "oauth" &&
        value !== "xaa"
      ) {
        setClientId("");
        setClientSecret("");
        setClearClientCredentials(true);
      }
      setServerAuthentication(value);
      setBearerTokenError(null);
      setClientIdError(null);
      setClientSecretError(null);
      setXaaConfigurationError(null);
    },
    [serverAuthentication],
  );

  const validateSelectedAuthentication = useCallback(() => {
    setBearerTokenError(null);
    setClientIdError(null);
    setClientSecretError(null);
    setXaaConfigurationError(null);

    if (serverTransport === "stdio") return true;

    if (serverAuthentication === "bearer" && !bearerToken.trim()) {
      setBearerTokenError("Enter a bearer token to continue.");
      bearerTokenInputRef.current?.focus();
      return false;
    }

    const usesPreregisteredCredentials =
      serverAuthentication === "xaa"
        ? registrationMode === "auto" || registrationMode === "preregistered"
        : (serverAuthentication === "oauth" ||
            serverAuthentication === "auto") &&
          registrationMode === "preregistered";
    const clientIdValidation = usesPreregisteredCredentials
      ? validateOAuthClientId(clientId)
      : null;
    if (clientIdValidation) {
      setClientIdError(clientIdValidation);
      window.setTimeout(() => {
        contentRef.current
          ?.querySelector<HTMLInputElement>('input[aria-required="true"]')
          ?.focus();
      }, 0);
      return false;
    }
    const clientSecretValidation = usesPreregisteredCredentials
      ? validateOAuthClientSecret(clientSecret)
      : null;
    if (clientSecretValidation) {
      setClientSecretError(clientSecretValidation);
      return false;
    }
    if (serverAuthentication !== "xaa") return true;
    if ((xaaSubject.trim() === "") !== (xaaEmail.trim() === "")) {
      setXaaConfigurationError(XAA_PARTIAL_OVERRIDE_ERROR);
      return false;
    }
    if (confidentialCimdBlockReason) {
      setXaaConfigurationError(confidentialCimdBlockReason);
      return false;
    }
    return true;
  }, [
    bearerToken,
    clientId,
    clientSecret,
    confidentialCimdBlockReason,
    registrationMode,
    serverAuthentication,
    serverTransport,
    xaaEmail,
    xaaSubject,
  ]);

  const buildServerDraft = useCallback(
    (name: string, urlOrCommand: string): FirstRunServerDraft => ({
      name,
      transport: serverTransport,
      urlOrCommand,
      authentication:
        serverTransport === "stdio" ? "none" : serverAuthentication,
      bearerToken:
        serverTransport === "http"
          ? bearerToken.trim() || undefined
          : undefined,
      oauthProtocolMode,
      registrationMode,
      oauthScopes: oauthScopesInput
        .split(/\s+/)
        .map((scope) => scope.trim())
        .filter(Boolean),
      clientId: clearClientCredentials ? "" : clientId.trim() || undefined,
      clientSecret: clearClientCredentials
        ? undefined
        : clientSecret || undefined,
      hasStoredClientSecret:
        hasStoredClientSecret &&
        !clearClientCredentials &&
        !clearStoredClientSecret &&
        clientId === savedClientId,
      clearClientSecret: clearClientCredentials || clearStoredClientSecret,
      oauthAllowPathScopedIssuer,
      xaaClientAuth,
      xaaAuthzIssuer: xaaAuthzIssuer.trim() || undefined,
      xaaAllowPathScopedIssuer,
      xaaSubject: xaaSubject.trim() || undefined,
      xaaEmail: xaaEmail.trim() || undefined,
    }),
    [
      bearerToken,
      clientId,
      clientSecret,
      clearClientCredentials,
      clearStoredClientSecret,
      hasStoredClientSecret,
      oauthAllowPathScopedIssuer,
      oauthProtocolMode,
      oauthScopesInput,
      registrationMode,
      serverAuthentication,
      serverTransport,
      savedClientId,
      xaaAllowPathScopedIssuer,
      xaaAuthzIssuer,
      xaaClientAuth,
      xaaEmail,
      xaaSubject,
    ],
  );

  const authenticationSection = (
    <AuthenticationSection
      serverUrl={serverUrlOrCommand}
      authType={serverAuthentication as ServerFormAuthType}
      onAuthTypeChange={changeServerAuthentication}
      showAuthSettings
      bearerToken={bearerToken}
      onBearerTokenChange={(value) => {
        setBearerToken(value);
        setBearerTokenError(null);
      }}
      bearerTokenError={bearerTokenError}
      bearerTokenInputRef={bearerTokenInputRef}
      oauthScopesInput={oauthScopesInput}
      onOauthScopesChange={setOauthScopesInput}
      oauthProtocolMode={oauthProtocolMode}
      onOauthProtocolModeChange={setOauthProtocolMode}
      registrationMode={registrationMode}
      onOauthRegistrationModeChange={(value) => {
        if (registrationMode === "preregistered" && value !== "preregistered") {
          setClientId("");
          setClientSecret("");
          setClearClientCredentials(true);
        } else if (value === "preregistered") {
          setClearClientCredentials(false);
        }
        setRegistrationMode(value);
      }}
      oauthAllowPathScopedIssuer={oauthAllowPathScopedIssuer}
      onOauthAllowPathScopedIssuerChange={setOauthAllowPathScopedIssuer}
      useCustomClientId={useCustomClientId}
      onUseCustomClientIdChange={setUseCustomClientId}
      clientId={clientId}
      onClientIdChange={(value) => {
        setClientId(value);
        if (hasStoredClientSecret && value !== savedClientId) {
          setClearStoredClientSecret(true);
        }
        if (value.trim()) setClearClientCredentials(false);
        setClientIdError(null);
      }}
      clientSecret={clientSecret}
      onClientSecretChange={(value) => {
        setClientSecret(value);
        if (value.trim()) setClearStoredClientSecret(false);
        if (value.trim()) setClearClientCredentials(false);
        setClientSecretError(null);
      }}
      hasStoredClientSecret={
        hasStoredClientSecret && clientId === savedClientId
      }
      clearClientSecret={clearClientCredentials || clearStoredClientSecret}
      onClearClientSecret={() => setClearStoredClientSecret(true)}
      onUndoClearClientSecret={() => setClearStoredClientSecret(false)}
      projectId={recoveryServerDraft?.projectId}
      hostedServerId={recoveryServerDraft?.hostedServerId}
      clientIdError={clientIdError}
      clientSecretError={clientSecretError}
      xaaClientAuth={xaaClientAuth}
      onXaaClientAuthChange={setXaaClientAuth}
      confidentialCimdStatus={confidentialCimdCapability.status}
      confidentialCimdBlockReason={confidentialCimdBlockReason}
      onRetryConfidentialCimd={confidentialCimdCapability.retry}
      xaaAuthzIssuer={xaaAuthzIssuer}
      onXaaAuthzIssuerChange={setXaaAuthzIssuer}
      xaaAllowPathScopedIssuer={xaaAllowPathScopedIssuer}
      onXaaAllowPathScopedIssuerChange={setXaaAllowPathScopedIssuer}
      xaaSubject={xaaSubject}
      onXaaSubjectChange={setXaaSubject}
      xaaEmail={xaaEmail}
      onXaaEmailChange={setXaaEmail}
    />
  );

  return {
    serverUrlOrCommand,
    setServerUrlOrCommand,
    serverUrlError,
    setServerUrlError,
    serverName,
    setServerName,
    serverTransport,
    setServerTransport,
    serverAuthentication,
    xaaConfigurationError,
    resetServerDraft,
    validateSelectedAuthentication,
    buildServerDraft,
    authenticationSection,
  };
}
