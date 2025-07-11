import {
  ClientRequest,
  ResourceReference,
  PromptReference,
  CreateMessageRequest,
  CreateMessageResult,
  ElicitRequest,
} from "@modelcontextprotocol/sdk/types.js";
import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";
import { StdErrNotification } from "./lib/types/notificationTypes";
import "./App.css";

// Components
import HistoryAndNotifications from "./components/History";
import Sidebar from "./components/Sidebar/Sidebar";
import Tabs from "./components/Tabs";
import ClientFormSection from "./components/ClientFormSection";
import StarGitHubModal from "./components/StarGitHubModal";
import AuthDebugger from "./components/AuthDebugger";
import ConsoleTab from "./components/ConsoleTab";
import PingTab from "./components/PingTab";
import PromptsTab from "./components/PromptsTab";
import ResourcesTab from "./components/ResourcesTab";
import RootsTab from "./components/RootsTab";
import SamplingTab from "./components/SamplingTab";
import ToolsTab from "./components/ToolsTab";
import ChatTab from "./components/chat/ChatTab";
import SettingsTab from "./components/settings/SettingsTab";

// Context
import { McpClientContext } from "@/context/McpClientContext";

// Hooks
import { useServerState } from "./hooks/useServerState";
import { useConnectionState } from "./hooks/useConnectionState";
import { useMCPOperations } from "./hooks/useMCPOperations";
import { useConfigState } from "./hooks/useConfigState";

// Utils
import {
  handleRootsChange,
  MCPHelperDependencies,
} from "./lib/utils/mcp/mcpHelpers";

import ElicitationModal, {
  ElicitationResponse,
} from "./components/ElicitationModal";

// Imported hooks and services
import { useServerManagement } from "./hooks/app/useServerManagement";
import { useOAuthHandlers } from "./hooks/app/useOAuthHandlers";
import { useLocalStoragePersistence } from "./hooks/app/useLocalStoragePersistence";
import { useAppEffects } from "./hooks/app/useAppEffects";
import { createMCPRequestService } from "./services/mcpRequestService";
import {
  renderOAuthCallback,
  renderOAuthDebugCallback,
  renderServerNotConnected,
  renderServerNoCapabilities,
} from "./utils/renderHelpers";

const App = () => {
  const serverState = useServerState();
  const mcpOperations = useMCPOperations();
  const connectionState = useConnectionState(
    mcpOperations.addRequestHistory,
    mcpOperations.addClientLog,
  );
  const configState = useConfigState();
  console.log("🔧 serverState", serverState);
  // Refs
  const rootsRef = useRef(mcpOperations.roots);
  const nextRequestId = useRef(0);

  // States
  const [currentPage, setCurrentPage] = useState<string>(() => {
    const hash = window.location.hash.slice(1);
    return hash || "tools";
  });
  const [isSidebarExpanded, setIsSidebarExpanded] = useState(true);
  const [showStarModal, setShowStarModal] = useState(false);
  const { addClientLog } = mcpOperations;

  // Handle hash changes for navigation
  useEffect(() => {
    const handleHashChange = () => {
      const hash = window.location.hash.slice(1);
      if (hash) {
        setCurrentPage(hash);
      }
    };

    window.addEventListener("hashchange", handleHashChange);
    return () => window.removeEventListener("hashchange", handleHashChange);
  }, []);

  // Handle GitHub star modal timing
  useEffect(() => {
    const hasSeenStarModal = localStorage.getItem("hasSeenStarModal");
    if (hasSeenStarModal) {
      return;
    }

    const timer = setTimeout(() => {
      setShowStarModal(true);
    }, 15000);

    return () => clearTimeout(timer);
  }, []);

  const handleCloseStarModal = () => {
    setShowStarModal(false);
    localStorage.setItem("hasSeenStarModal", "true");
  };

  // Callbacks for connection
  const onStdErrNotification = useCallback(
    (notification: StdErrNotification) => {
      mcpOperations.setStdErrNotifications((prev) => [...prev, notification]);
    },
    [mcpOperations],
  );

  const onPendingRequest = useCallback(
    (
      request: CreateMessageRequest,
      resolve: (result: CreateMessageResult) => void,
      reject: (error: Error) => void,
    ) => {
      mcpOperations.setPendingSampleRequests((prev) => [
        ...prev,
        { id: nextRequestId.current++, request, resolve, reject },
      ]);
    },
    [mcpOperations],
  );

  const onElicitationRequest = useCallback(
    (
      request: ElicitRequest,
      resolve: (result: ElicitationResponse) => void,
    ) => {
      mcpOperations.setPendingElicitationRequest({
        id: nextRequestId.current++,
        message: request.params.message,
        requestedSchema: request.params.requestedSchema,
        resolve,
      });
    },
    [mcpOperations],
  );

  const getRootsCallback = useCallback(() => rootsRef.current, []);

  // Server management functions
  const {
    handleRemoveServer,
    handleEditClient,
    handleConnectServer,
    saveClients,
    handleAddServer,
  } = useServerManagement(
    serverState,
    connectionState,
    configState,
    mcpOperations,
    onStdErrNotification,
    onPendingRequest,
    onElicitationRequest,
    getRootsCallback,
  );

  // OAuth handlers
  const oauthHandlers = useOAuthHandlers(
    serverState,
    configState,
    handleAddServer,
  );

  // Now use the extracted OAuth handlers
  const { onOAuthConnect, onOAuthDebugConnect } = oauthHandlers;

  // Use localStorage persistence helper
  useLocalStoragePersistence(serverState);

  // Use additional app effects
  useAppEffects(
    serverState,
    connectionState,
    configState,
    mcpOperations,
    onStdErrNotification,
    onPendingRequest,
    onElicitationRequest,
    getRootsCallback,
    rootsRef,
    addClientLog,
  );

  // Connection info
  const serverCapabilities = connectionState.getServerCapabilities(
    serverState.selectedServerName,
  );
  const requestHistory = mcpOperations.getRequestHistory();
  const currentClient = connectionState.getCurrentClient(
    serverState.selectedServerName,
  );

  // MCP operation wrappers
  const makeRequest = useCallback(
    async (request: ClientRequest) => {
      return await mcpOperations.makeRequest(
        connectionState.mcpAgent,
        serverState.selectedServerName,
        request,
      );
    },
    [mcpOperations, connectionState.mcpAgent, serverState.selectedServerName],
  );

  const handleCompletion = useCallback(
    async (
      ref: ResourceReference | PromptReference,
      argName: string,
      value: string,
      signal?: AbortSignal,
    ) => {
      return await mcpOperations.handleCompletion(
        connectionState.mcpAgent,
        serverState.selectedServerName,
        ref,
        argName,
        value,
        signal,
      );
    },
    [mcpOperations, connectionState.mcpAgent, serverState.selectedServerName],
  );

  const completionsSupported =
    connectionState.mcpAgent?.getClient(serverState.selectedServerName)
      ?.completionsSupported || false;

  // Create MCP request service
  const mcpRequestService = createMCPRequestService(makeRequest, mcpOperations);
  const { sendMCPRequest } = mcpRequestService;

  const handleRootsChangeWrapper = async () => {
    if (!connectionState.mcpAgent || serverState.selectedServerName === "all")
      return;

    const client = connectionState.mcpAgent.getClient(
      serverState.selectedServerName,
    );
    if (client) {
      return handleRootsChange({
        makeRequest: client.makeRequest.bind(client),
      } as MCPHelperDependencies);
    }
  };

  // Tab rendering function
  const renderCurrentPage = () => {
    switch (currentPage) {
      case "resources":
        return (
          <ResourcesTab
            resources={mcpOperations.resources}
            resourceTemplates={mcpOperations.resourceTemplates}
            listResources={() => {
              mcpOperations.clearError("resources");
              mcpOperations.listResources(
                connectionState.mcpAgent,
                serverState.selectedServerName,
              );
            }}
            clearResources={() => {
              mcpOperations.setResources([]);
              mcpOperations.setNextResourceCursor(undefined);
            }}
            listResourceTemplates={() => {
              mcpOperations.clearError("resources");
              mcpOperations.listResourceTemplates(
                connectionState.mcpAgent,
                serverState.selectedServerName,
              );
            }}
            clearResourceTemplates={() => {
              mcpOperations.setResourceTemplates([]);
              mcpOperations.setNextResourceTemplateCursor(undefined);
            }}
            readResource={(uri) => {
              mcpOperations.clearError("resources");
              mcpOperations.readResource(
                connectionState.mcpAgent,
                serverState.selectedServerName,
                uri,
              );
            }}
            selectedResource={mcpOperations.selectedResource}
            setSelectedResource={(resource) => {
              mcpOperations.clearError("resources");
              mcpOperations.setSelectedResource(resource);
            }}
            resourceSubscriptionsSupported={
              serverCapabilities?.resources?.subscribe || false
            }
            resourceSubscriptions={mcpOperations.resourceSubscriptions}
            subscribeToResource={(uri) => {
              mcpOperations.clearError("resources");
              mcpOperations.subscribeToResource(
                connectionState.mcpAgent,
                serverState.selectedServerName,
                uri,
              );
            }}
            unsubscribeFromResource={(uri) => {
              mcpOperations.clearError("resources");
              mcpOperations.unsubscribeFromResource(
                connectionState.mcpAgent,
                serverState.selectedServerName,
                uri,
              );
            }}
            handleCompletion={handleCompletion}
            completionsSupported={completionsSupported}
            resourceContent={mcpOperations.resourceContent}
            nextCursor={mcpOperations.nextResourceCursor}
            nextTemplateCursor={mcpOperations.nextResourceTemplateCursor}
            error={mcpOperations.errors.resources}
            selectedServerName={serverState.selectedServerName}
          />
        );
      case "prompts":
        return (
          <PromptsTab
            prompts={mcpOperations.prompts}
            listPrompts={() => {
              mcpOperations.clearError("prompts");
              mcpOperations.listPrompts(
                connectionState.mcpAgent,
                serverState.selectedServerName,
              );
            }}
            clearPrompts={() => {
              mcpOperations.setPrompts([]);
              mcpOperations.setNextPromptCursor(undefined);
            }}
            getPrompt={(name, args) => {
              mcpOperations.clearError("prompts");
              mcpOperations.getPrompt(
                connectionState.mcpAgent,
                serverState.selectedServerName,
                name,
                args,
              );
            }}
            selectedPrompt={mcpOperations.selectedPrompt}
            setSelectedPrompt={(prompt) => {
              mcpOperations.clearError("prompts");
              mcpOperations.setSelectedPrompt(prompt);
              mcpOperations.setPromptContent("");
            }}
            handleCompletion={handleCompletion}
            completionsSupported={completionsSupported}
            promptContent={mcpOperations.promptContent}
            nextCursor={mcpOperations.nextPromptCursor}
            error={mcpOperations.errors.prompts}
            selectedServerName={serverState.selectedServerName}
          />
        );
      case "tools":
        return (
          <ToolsTab
            tools={mcpOperations.tools}
            listTools={() => {
              mcpOperations.clearError("tools");
              mcpOperations.listTools(
                connectionState.mcpAgent,
                serverState.selectedServerName,
              );
            }}
            clearTools={() => {
              mcpOperations.setTools([]);
              mcpOperations.setNextToolCursor(undefined);
            }}
            callTool={async (name, params) => {
              mcpOperations.clearError("tools");
              mcpOperations.setToolResult(null);
              await mcpOperations.callTool(
                connectionState.mcpAgent,
                serverState.selectedServerName,
                name,
                params,
              );
            }}
            selectedTool={mcpOperations.selectedTool}
            setSelectedTool={(tool) => {
              mcpOperations.clearError("tools");
              mcpOperations.setSelectedTool(tool);
              mcpOperations.setToolResult(null);
            }}
            toolResult={mcpOperations.toolResult}
            nextCursor={mcpOperations.nextToolCursor}
            error={mcpOperations.errors.tools}
            connectionStatus={
              connectionState.getConnectionStatus() as
                | "connected"
                | "disconnected"
                | "error"
                | "error-connecting-to-proxy"
            }
            selectedServerName={serverState.selectedServerName}
          />
        );
      case "chat":
        return (
          <ChatTab
            mcpAgent={connectionState.mcpAgent}
            updateTrigger={connectionState.sidebarUpdateTrigger}
          />
        );
      case "console":
        return <ConsoleTab />;
      case "ping":
        return (
          <PingTab
            onPingClick={() => {
              void sendMCPRequest(
                {
                  method: "ping" as const,
                },
                z.object({}),
              );
            }}
          />
        );
      case "sampling":
        return (
          <SamplingTab
            pendingRequests={mcpOperations.pendingSampleRequests}
            onApprove={mcpOperations.handleApproveSampling}
            onReject={mcpOperations.handleRejectSampling}
          />
        );
      case "roots":
        return (
          <RootsTab
            roots={mcpOperations.roots}
            setRoots={mcpOperations.setRoots}
            onRootsChange={handleRootsChangeWrapper}
          />
        );
      case "auth":
        return (
          <AuthDebugger
            serverUrl={(() => {
              const currentConfig =
                serverState.serverConfigs[serverState.selectedServerName];
              return currentConfig &&
                "url" in currentConfig &&
                currentConfig.url
                ? currentConfig.url.toString()
                : "";
            })()}
            onBack={() => setCurrentPage("resources")}
            authState={configState.authState}
            updateAuthState={configState.updateAuthState}
          />
        );
      case "settings":
        return <SettingsTab />;
      default:
        return null;
    }
  };

  // Render OAuth callback components
  if (window.location.pathname === "/oauth/callback") {
    return renderOAuthCallback(onOAuthConnect);
  }

  if (window.location.pathname === "/oauth/callback/debug") {
    return renderOAuthDebugCallback(onOAuthDebugConnect);
  }

  const renderTabs = () => {
    // Show ClientFormSection when creating or editing a client
    if (serverState.isCreatingClient || serverState.editingClientName) {
      return (
        <ClientFormSection
          isCreating={serverState.isCreatingClient}
          editingClientName={serverState.editingClientName}
          clientFormName={serverState.clientFormName}
          setClientFormName={serverState.setClientFormName}
          clientFormConfig={serverState.clientFormConfig}
          setClientFormConfig={serverState.setClientFormConfig}
          config={configState.config}
          setConfig={configState.setConfig}
          bearerToken={configState.bearerToken}
          setBearerToken={configState.setBearerToken}
          headerName={configState.headerName}
          setHeaderName={configState.setHeaderName}
          onSave={saveClients}
          onCancel={serverState.handleCancelClientForm}
        />
      );
    }

    // Check connection state and capabilities
    const isNotConnected =
      !connectionState.mcpAgent ||
      currentClient?.connectionStatus !== "connected";
    const hasNoCapabilities =
      !serverCapabilities?.resources &&
      !serverCapabilities?.prompts &&
      !serverCapabilities?.tools;

    return (
      <div className="flex-1 flex flex-col overflow-auto p-6">
        {isNotConnected
          ? renderServerNotConnected()
          : hasNoCapabilities
            ? renderServerNoCapabilities(sendMCPRequest)
            : renderCurrentPage()}
      </div>
    );
  };

  return (
    <McpClientContext.Provider value={currentClient}>
      <div className="h-screen bg-gradient-to-br from-slate-50/50 to-slate-100/50 dark:from-slate-900/50 dark:to-slate-800/50 flex overflow-hidden app-container">
        {/* Sidebar - Full Height Left Side */}
        <Sidebar
          mcpAgent={connectionState.mcpAgent}
          selectedServerName={serverState.selectedServerName}
          onServerSelect={serverState.setSelectedServerName}
          onRemoveServer={handleRemoveServer}
          onConnectServer={handleConnectServer}
          onDisconnectServer={connectionState.disconnectServer}
          onCreateClient={serverState.handleCreateClient}
          onEditClient={handleEditClient}
          updateTrigger={connectionState.sidebarUpdateTrigger}
          isExpanded={isSidebarExpanded}
          onToggleExpanded={() => setIsSidebarExpanded(!isSidebarExpanded)}
        />

        {/* Main Content Area - Right Side */}
        <div className="flex-1 flex flex-col overflow-hidden">
          {/* Horizontal Tabs */}
          <Tabs
            currentPage={currentPage}
            onPageChange={(page) => {
              setCurrentPage(page);
              serverState.handleCancelClientForm();
            }}
            serverCapabilities={serverCapabilities}
            pendingSampleRequests={mcpOperations.pendingSampleRequests}
            shouldDisableAll={!connectionState.mcpAgent}
          />

          {/* Main Content */}
          <div className="flex-1 flex flex-col overflow-hidden overflow-y-auto">
            {renderTabs()}
          </div>

          {/* History Panel */}
          <HistoryAndNotifications
            requestHistory={requestHistory}
            toolResult={mcpOperations.toolResult}
            clientLogs={mcpOperations.getClientLogs()}
            onClearHistory={mcpOperations.clearRequestHistory}
            onClearLogs={mcpOperations.clearClientLogs}
          />
        </div>
        <ElicitationModal
          request={mcpOperations.pendingElicitationRequest}
          onClose={mcpOperations.handleCloseElicitationModal}
        />
      </div>

      {/* GitHub Star Modal */}
      <StarGitHubModal isOpen={showStarModal} onClose={handleCloseStarModal} />
    </McpClientContext.Provider>
  );
};

export default App;
