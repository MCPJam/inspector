(globalThis.TURBOPACK = globalThis.TURBOPACK || []).push([typeof document === "object" ? document.currentScript : undefined, {

"[project]/src/lib/utils.ts [app-client] (ecmascript)": ((__turbopack_context__) => {
"use strict";

var { k: __turbopack_refresh__, m: module } = __turbopack_context__;
{
__turbopack_context__.s({
    "cn": ()=>cn,
    "formatCurrency": ()=>formatCurrency,
    "formatTimeRemaining": ()=>formatTimeRemaining,
    "getInitials": ()=>getInitials,
    "getTimeBreakdown": ()=>getTimeBreakdown
});
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$clsx$2f$dist$2f$clsx$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/clsx/dist/clsx.mjs [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$tailwind$2d$merge$2f$dist$2f$bundle$2d$mjs$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/tailwind-merge/dist/bundle-mjs.mjs [app-client] (ecmascript)");
;
;
function cn() {
    for(var _len = arguments.length, inputs = new Array(_len), _key = 0; _key < _len; _key++){
        inputs[_key] = arguments[_key];
    }
    return (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$tailwind$2d$merge$2f$dist$2f$bundle$2d$mjs$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["twMerge"])((0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$clsx$2f$dist$2f$clsx$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["clsx"])(inputs));
}
const getInitials = (str)=>{
    if (typeof str !== "string" || !str.trim()) return "?";
    return str.trim().split(/\s+/).filter(Boolean).map((word)=>word[0]).join("").toUpperCase() || "?";
};
function formatCurrency(amount, opts) {
    const { currency = "USD", locale = "en-US", minimumFractionDigits, maximumFractionDigits, noDecimals } = opts !== null && opts !== void 0 ? opts : {};
    const formatOptions = {
        style: "currency",
        currency,
        minimumFractionDigits: noDecimals ? 0 : minimumFractionDigits,
        maximumFractionDigits: noDecimals ? 0 : maximumFractionDigits
    };
    return new Intl.NumberFormat(locale, formatOptions).format(amount);
}
function formatTimeRemaining(timeLeftMs) {
    if (timeLeftMs <= 0) return "Expired";
    const days = Math.floor(timeLeftMs / (1000 * 60 * 60 * 24));
    const hours = Math.floor(timeLeftMs % (1000 * 60 * 60 * 24) / (1000 * 60 * 60));
    const minutes = Math.floor(timeLeftMs % (1000 * 60 * 60) / (1000 * 60));
    const seconds = Math.floor(timeLeftMs % (1000 * 60) / 1000);
    const parts = [];
    if (days > 0) parts.push("".concat(days, "d"));
    if (hours > 0) parts.push("".concat(hours, "h"));
    if (minutes > 0) parts.push("".concat(minutes, "m"));
    if (seconds > 0 || parts.length === 0) parts.push("".concat(seconds, "s"));
    return parts.join(" ") + " remaining";
}
function getTimeBreakdown(timeLeftMs) {
    const days = Math.floor(timeLeftMs / (1000 * 60 * 60 * 24));
    const hours = Math.floor(timeLeftMs % (1000 * 60 * 60 * 24) / (1000 * 60 * 60));
    const minutes = Math.floor(timeLeftMs % (1000 * 60 * 60) / (1000 * 60));
    const seconds = Math.floor(timeLeftMs % (1000 * 60) / 1000);
    return {
        days,
        hours,
        minutes,
        seconds,
        isExpired: timeLeftMs <= 0,
        isExpiringSoon: timeLeftMs <= 300000
    };
}
if (typeof globalThis.$RefreshHelpers$ === 'object' && globalThis.$RefreshHelpers !== null) {
    __turbopack_context__.k.registerExports(module, globalThis.$RefreshHelpers$);
}
}}),
"[project]/src/lib/chat-utils.ts [app-client] (ecmascript)": ((__turbopack_context__) => {
"use strict";

var { k: __turbopack_refresh__, m: module } = __turbopack_context__;
{
__turbopack_context__.s({
    "cn": ()=>cn,
    "createMessage": ()=>createMessage,
    "debounce": ()=>debounce,
    "formatFileSize": ()=>formatFileSize,
    "formatMessageDate": ()=>formatMessageDate,
    "formatTimestamp": ()=>formatTimestamp,
    "generateId": ()=>generateId,
    "isValidFileType": ()=>isValidFileType,
    "sanitizeText": ()=>sanitizeText,
    "scrollToBottom": ()=>scrollToBottom,
    "truncateText": ()=>truncateText
});
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$clsx$2f$dist$2f$clsx$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/clsx/dist/clsx.mjs [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$tailwind$2d$merge$2f$dist$2f$bundle$2d$mjs$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/tailwind-merge/dist/bundle-mjs.mjs [app-client] (ecmascript)");
;
;
function cn() {
    for(var _len = arguments.length, inputs = new Array(_len), _key = 0; _key < _len; _key++){
        inputs[_key] = arguments[_key];
    }
    return (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$tailwind$2d$merge$2f$dist$2f$bundle$2d$mjs$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["twMerge"])((0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$clsx$2f$dist$2f$clsx$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["clsx"])(inputs));
}
function generateId() {
    return Math.random().toString(36).substr(2, 9);
}
function sanitizeText(text) {
    // Basic sanitization - in production you might want more robust sanitization
    return text.trim();
}
function formatTimestamp(date) {
    return new Intl.DateTimeFormat("en-US", {
        hour: "numeric",
        minute: "2-digit",
        hour12: true
    }).format(date);
}
function formatMessageDate(date) {
    const now = new Date();
    const diffInMs = now.getTime() - date.getTime();
    const diffInDays = Math.floor(diffInMs / (1000 * 60 * 60 * 24));
    if (diffInDays === 0) {
        return formatTimestamp(date);
    } else if (diffInDays === 1) {
        return "Yesterday ".concat(formatTimestamp(date));
    } else if (diffInDays < 7) {
        return "".concat(diffInDays, " days ago");
    } else {
        return new Intl.DateTimeFormat("en-US", {
            month: "short",
            day: "numeric",
            year: date.getFullYear() !== now.getFullYear() ? "numeric" : undefined
        }).format(date);
    }
}
function createMessage(role, content, attachments) {
    return {
        id: generateId(),
        role,
        content,
        timestamp: new Date(),
        attachments,
        metadata: {
            createdAt: new Date().toISOString()
        }
    };
}
function isValidFileType(file) {
    const allowedTypes = [
        "text/plain",
        "application/pdf",
        "image/jpeg",
        "image/jpg",
        "image/png",
        "image/gif",
        "image/webp",
        "application/json",
        "text/csv",
        "application/vnd.ms-excel",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    ];
    return allowedTypes.includes(file.type);
}
function formatFileSize(bytes) {
    if (bytes === 0) return "0 B";
    const k = 1024;
    const sizes = [
        "B",
        "KB",
        "MB",
        "GB"
    ];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}
function truncateText(text, maxLength) {
    if (text.length <= maxLength) return text;
    return text.substring(0, maxLength) + "...";
}
function scrollToBottom(element) {
    if (element) {
        element.scrollTop = element.scrollHeight;
    } else {
        window.scrollTo(0, document.body.scrollHeight);
    }
}
function debounce(func, wait) {
    let timeout;
    return function() {
        for(var _len = arguments.length, args = new Array(_len), _key = 0; _key < _len; _key++){
            args[_key] = arguments[_key];
        }
        clearTimeout(timeout);
        timeout = setTimeout(()=>func(...args), wait);
    };
}
if (typeof globalThis.$RefreshHelpers$ === 'object' && globalThis.$RefreshHelpers !== null) {
    __turbopack_context__.k.registerExports(module, globalThis.$RefreshHelpers$);
}
}}),
"[project]/src/lib/types.ts [app-client] (ecmascript)": ((__turbopack_context__) => {
"use strict";

var { k: __turbopack_refresh__, m: module } = __turbopack_context__;
{
__turbopack_context__.s({
    "Model": ()=>Model,
    "SUPPORTED_MODELS": ()=>SUPPORTED_MODELS,
    "getModelById": ()=>getModelById,
    "isModelSupported": ()=>isModelSupported
});
var Model = /*#__PURE__*/ function(Model) {
    Model["CLAUDE_OPUS_4_0"] = "claude-opus-4-0";
    Model["CLAUDE_SONNET_4_0"] = "claude-sonnet-4-0";
    Model["CLAUDE_3_7_SONNET_LATEST"] = "claude-3-7-sonnet-latest";
    Model["CLAUDE_3_5_SONNET_LATEST"] = "claude-3-5-sonnet-latest";
    Model["CLAUDE_3_5_HAIKU_LATEST"] = "claude-3-5-haiku-latest";
    Model["O3_MINI"] = "o3-mini";
    Model["O3"] = "o3";
    Model["O4_MINI"] = "o4-mini";
    Model["GPT_4_1"] = "gpt-4.1";
    Model["GPT_4_1_MINI"] = "gpt-4.1-mini";
    Model["GPT_4_1_NANO"] = "gpt-4.1-nano";
    Model["GPT_4O"] = "gpt-4o";
    Model["GPT_4O_MINI"] = "gpt-4o-mini";
    Model["GPT_4_TURBO"] = "gpt-4-turbo";
    Model["GPT_4"] = "gpt-4";
    Model["GPT_3_5_TURBO"] = "gpt-3.5-turbo";
    Model["O1"] = "o1";
    return Model;
}({});
const SUPPORTED_MODELS = [
    {
        id: "claude-opus-4-0",
        name: "Claude Opus 4",
        provider: "anthropic"
    },
    {
        id: "claude-sonnet-4-0",
        name: "Claude Sonnet 4",
        provider: "anthropic"
    },
    {
        id: "claude-3-7-sonnet-latest",
        name: "Claude Sonnet 3.7",
        provider: "anthropic"
    },
    {
        id: "claude-3-5-sonnet-latest",
        name: "Claude Sonnet 3.5",
        provider: "anthropic"
    },
    {
        id: "claude-3-5-haiku-latest",
        name: "Claude Haiku 3.5",
        provider: "anthropic"
    },
    {
        id: "o3-mini",
        name: "O3 Mini",
        provider: "openai"
    },
    {
        id: "o3",
        name: "O3",
        provider: "openai"
    },
    {
        id: "o4-mini",
        name: "O4 Mini",
        provider: "openai"
    },
    {
        id: "gpt-4.1",
        name: "GPT-4.1",
        provider: "openai"
    },
    {
        id: "gpt-4.1-mini",
        name: "GPT-4.1 Mini",
        provider: "openai"
    },
    {
        id: "gpt-4.1-nano",
        name: "GPT-4.1 Nano",
        provider: "openai"
    },
    {
        id: "gpt-4o",
        name: "GPT-4o",
        provider: "openai"
    },
    {
        id: "gpt-4o-mini",
        name: "GPT-4o Mini",
        provider: "openai"
    },
    {
        id: "gpt-4-turbo",
        name: "GPT-4 Turbo",
        provider: "openai"
    },
    {
        id: "gpt-4",
        name: "GPT-4",
        provider: "openai"
    },
    {
        id: "gpt-3.5-turbo",
        name: "GPT-3.5 Turbo",
        provider: "openai"
    },
    {
        id: "o1",
        name: "O1",
        provider: "openai"
    }
];
const getModelById = (id)=>{
    return SUPPORTED_MODELS.find((model)=>model.id === id);
};
const isModelSupported = (id)=>{
    return SUPPORTED_MODELS.some((model)=>model.id === id);
};
if (typeof globalThis.$RefreshHelpers$ === 'object' && globalThis.$RefreshHelpers !== null) {
    __turbopack_context__.k.registerExports(module, globalThis.$RefreshHelpers$);
}
}}),
"[project]/src/lib/ollama-utils.ts [app-client] (ecmascript)": ((__turbopack_context__) => {
"use strict";

var { k: __turbopack_refresh__, m: module } = __turbopack_context__;
{
__turbopack_context__.s({
    "OllamaClient": ()=>OllamaClient,
    "detectOllamaModels": ()=>detectOllamaModels,
    "ollamaClient": ()=>ollamaClient
});
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f40$swc$2f$helpers$2f$esm$2f$_define_property$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/@swc/helpers/esm/_define_property.js [app-client] (ecmascript)");
;
class OllamaClient {
    setBaseUrl(baseUrl) {
        this.baseUrl = baseUrl;
    }
    async isOllamaRunning() {
        try {
            const response = await fetch("".concat(this.baseUrl, "/api/version"), {
                method: "GET",
                signal: AbortSignal.timeout(3000)
            });
            return response.ok;
        } catch (error) {
            return false;
        }
    }
    async getAvailableModels() {
        try {
            const response = await fetch("".concat(this.baseUrl, "/api/tags"), {
                method: "GET",
                signal: AbortSignal.timeout(5000)
            });
            if (!response.ok) {
                return [];
            }
            const data = await response.json();
            return data.models.map((model)=>model.name);
        } catch (error) {
            console.warn("Failed to fetch Ollama models:", error);
            return [];
        }
    }
    async checkModelExists(modelName) {
        const availableModels = await this.getAvailableModels();
        return availableModels.some((model)=>model === modelName || model.startsWith("".concat(modelName, ":")));
    }
    async getFilteredAvailableModels(supportedModels) {
        const availableModels = await this.getAvailableModels();
        return supportedModels.filter((supportedModel)=>availableModels.some((availableModel)=>availableModel === supportedModel || availableModel.startsWith("".concat(supportedModel, ":"))));
    }
    constructor(baseUrl = "http://localhost:11434"){
        (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f40$swc$2f$helpers$2f$esm$2f$_define_property$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["_"])(this, "baseUrl", void 0);
        this.baseUrl = baseUrl;
    }
}
const ollamaClient = new OllamaClient();
const detectOllamaModels = async (baseUrl)=>{
    // Use a temporary client with the provided base URL if given
    const client = baseUrl ? new OllamaClient(baseUrl) : ollamaClient;
    const isRunning = await client.isOllamaRunning();
    if (!isRunning) {
        return {
            isRunning: false,
            availableModels: []
        };
    }
    const availableModels = await client.getAvailableModels();
    return {
        isRunning: true,
        availableModels
    };
};
if (typeof globalThis.$RefreshHelpers$ === 'object' && globalThis.$RefreshHelpers !== null) {
    __turbopack_context__.k.registerExports(module, globalThis.$RefreshHelpers$);
}
}}),
"[project]/src/lib/date-utils.ts [app-client] (ecmascript)": ((__turbopack_context__) => {
"use strict";

var { k: __turbopack_refresh__, m: module } = __turbopack_context__;
{
__turbopack_context__.s({
    "formatDate": ()=>formatDate
});
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$date$2d$fns$2f$format$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$locals$3e$__ = __turbopack_context__.i("[project]/node_modules/date-fns/format.mjs [app-client] (ecmascript) <locals>");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$date$2d$fns$2f$parseISO$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/date-fns/parseISO.mjs [app-client] (ecmascript)");
;
const formatDate = function(date) {
    let formatString = arguments.length > 1 && arguments[1] !== void 0 ? arguments[1] : "HH:mm:ss.SSS";
    const dateToFormat = typeof date === "string" ? (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$date$2d$fns$2f$parseISO$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["parseISO"])(date) : date;
    return (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$date$2d$fns$2f$format$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__$3c$locals$3e$__["format"])(dateToFormat, formatString);
};
if (typeof globalThis.$RefreshHelpers$ === 'object' && globalThis.$RefreshHelpers !== null) {
    __turbopack_context__.k.registerExports(module, globalThis.$RefreshHelpers$);
}
}}),
"[project]/src/lib/theme-utils.ts [app-client] (ecmascript)": ((__turbopack_context__) => {
"use strict";

var { k: __turbopack_refresh__, m: module } = __turbopack_context__;
{
__turbopack_context__.s({
    "updateThemeMode": ()=>updateThemeMode,
    "updateThemePreset": ()=>updateThemePreset
});
function updateThemeMode(value) {
    const doc = document.documentElement;
    doc.classList.add("disable-transitions");
    doc.classList.toggle("dark", value === "dark");
    requestAnimationFrame(()=>{
        doc.classList.remove("disable-transitions");
    });
}
function updateThemePreset(value) {
    document.documentElement.setAttribute("data-theme-preset", value);
}
if (typeof globalThis.$RefreshHelpers$ === 'object' && globalThis.$RefreshHelpers !== null) {
    __turbopack_context__.k.registerExports(module, globalThis.$RefreshHelpers$);
}
}}),
"[project]/src/lib/mcp-oauth.ts [app-client] (ecmascript)": ((__turbopack_context__) => {
"use strict";

var { k: __turbopack_refresh__, m: module } = __turbopack_context__;
{
/**
 * Clean OAuth implementation using only the official MCP SDK
 */ __turbopack_context__.s({
    "clearOAuthData": ()=>clearOAuthData,
    "getStoredTokens": ()=>getStoredTokens,
    "handleOAuthCallback": ()=>handleOAuthCallback,
    "initiateOAuth": ()=>initiateOAuth,
    "refreshOAuthTokens": ()=>refreshOAuthTokens,
    "waitForTokens": ()=>waitForTokens
});
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f40$swc$2f$helpers$2f$esm$2f$_define_property$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/@swc/helpers/esm/_define_property.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f40$modelcontextprotocol$2f$sdk$2f$dist$2f$esm$2f$client$2f$auth$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/@modelcontextprotocol/sdk/dist/esm/client/auth.js [app-client] (ecmascript)");
;
;
/**
 * Simple localStorage-based OAuth provider for MCP
 */ class MCPOAuthProvider {
    get redirectUrl() {
        return this.redirectUri;
    }
    get clientMetadata() {
        return {
            client_name: "MCP Inspector - ".concat(this.serverName),
            client_uri: "https://github.com/modelcontextprotocol/inspector",
            redirect_uris: [
                this.redirectUri
            ],
            grant_types: [
                "authorization_code",
                "refresh_token"
            ],
            response_types: [
                "code"
            ],
            token_endpoint_auth_method: "client_secret_post",
            scope: "mcp:*"
        };
    }
    clientInformation() {
        const stored = localStorage.getItem("mcp-client-".concat(this.serverName));
        return stored ? JSON.parse(stored) : undefined;
    }
    async saveClientInformation(clientInformation) {
        localStorage.setItem("mcp-client-".concat(this.serverName), JSON.stringify(clientInformation));
    }
    tokens() {
        const stored = localStorage.getItem("mcp-tokens-".concat(this.serverName));
        return stored ? JSON.parse(stored) : undefined;
    }
    async saveTokens(tokens) {
        localStorage.setItem("mcp-tokens-".concat(this.serverName), JSON.stringify(tokens));
    }
    async redirectToAuthorization(authorizationUrl) {
        // Store server name for callback recovery
        console.log("Setting mcp-oauth-pending to:", this.serverName);
        localStorage.setItem("mcp-oauth-pending", this.serverName);
        window.location.href = authorizationUrl.toString();
    }
    async saveCodeVerifier(codeVerifier) {
        localStorage.setItem("mcp-verifier-".concat(this.serverName), codeVerifier);
    }
    codeVerifier() {
        const verifier = localStorage.getItem("mcp-verifier-".concat(this.serverName));
        if (!verifier) {
            throw new Error("Code verifier not found");
        }
        return verifier;
    }
    async invalidateCredentials(scope) {
        switch(scope){
            case "all":
                localStorage.removeItem("mcp-tokens-".concat(this.serverName));
                localStorage.removeItem("mcp-client-".concat(this.serverName));
                localStorage.removeItem("mcp-verifier-".concat(this.serverName));
                break;
            case "client":
                localStorage.removeItem("mcp-client-".concat(this.serverName));
                break;
            case "tokens":
                localStorage.removeItem("mcp-tokens-".concat(this.serverName));
                break;
            case "verifier":
                localStorage.removeItem("mcp-verifier-".concat(this.serverName));
                break;
        }
    }
    constructor(serverName){
        (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f40$swc$2f$helpers$2f$esm$2f$_define_property$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["_"])(this, "serverName", void 0);
        (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f40$swc$2f$helpers$2f$esm$2f$_define_property$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["_"])(this, "redirectUri", void 0);
        this.serverName = serverName;
        this.redirectUri = "".concat(window.location.origin, "/oauth/callback");
    }
}
async function initiateOAuth(options) {
    try {
        var _options_scopes;
        const provider = new MCPOAuthProvider(options.serverName);
        // Store server URL for callback recovery
        localStorage.setItem("mcp-serverUrl-".concat(options.serverName), options.serverUrl);
        localStorage.setItem("mcp-oauth-pending", options.serverName);
        const result = await (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f40$modelcontextprotocol$2f$sdk$2f$dist$2f$esm$2f$client$2f$auth$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["auth"])(provider, {
            serverUrl: options.serverUrl,
            scope: ((_options_scopes = options.scopes) === null || _options_scopes === void 0 ? void 0 : _options_scopes.join(" ")) || "mcp:*"
        });
        if (result === "REDIRECT") {
            return {
                success: true
            };
        }
        if (result === "AUTHORIZED") {
            const tokens = provider.tokens();
            if (tokens) {
                const serverConfig = createServerConfig(options.serverUrl, tokens);
                return {
                    success: true,
                    serverConfig
                };
            }
        }
        return {
            success: false,
            error: "OAuth flow failed"
        };
    } catch (error) {
        return {
            success: false,
            error: error instanceof Error ? error.message : "Unknown OAuth error"
        };
    }
}
async function handleOAuthCallback(authorizationCode) {
    try {
        // Get pending server name from localStorage
        const serverName = localStorage.getItem("mcp-oauth-pending");
        if (!serverName) {
            throw new Error("No pending OAuth flow found");
        }
        // Get server URL
        const serverUrl = localStorage.getItem("mcp-serverUrl-".concat(serverName));
        if (!serverUrl) {
            throw new Error("Server URL not found for OAuth callback");
        }
        const provider = new MCPOAuthProvider(serverName);
        const result = await (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f40$modelcontextprotocol$2f$sdk$2f$dist$2f$esm$2f$client$2f$auth$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["auth"])(provider, {
            serverUrl,
            authorizationCode,
            scope: "mcp:*"
        });
        if (result === "AUTHORIZED") {
            const tokens = provider.tokens();
            if (tokens) {
                // Clean up pending state
                localStorage.removeItem("mcp-oauth-pending");
                const serverConfig = createServerConfig(serverUrl, tokens);
                return {
                    success: true,
                    serverConfig,
                    serverName
                };
            }
        }
        return {
            success: false,
            error: "Token exchange failed"
        };
    } catch (error) {
        return {
            success: false,
            error: error instanceof Error ? error.message : "Unknown callback error"
        };
    }
}
function getStoredTokens(serverName) {
    const stored = localStorage.getItem("mcp-tokens-".concat(serverName));
    return stored ? JSON.parse(stored) : undefined;
}
async function waitForTokens(serverName) {
    let timeoutMs = arguments.length > 1 && arguments[1] !== void 0 ? arguments[1] : 5000;
    const startTime = Date.now();
    while(Date.now() - startTime < timeoutMs){
        const tokens = getStoredTokens(serverName);
        if (tokens === null || tokens === void 0 ? void 0 : tokens.access_token) {
            return tokens;
        }
        await new Promise((resolve)=>setTimeout(resolve, 100));
    }
    throw new Error("Timeout waiting for tokens for server: ".concat(serverName));
}
async function refreshOAuthTokens(serverName) {
    try {
        const provider = new MCPOAuthProvider(serverName);
        const existingTokens = provider.tokens();
        if (!(existingTokens === null || existingTokens === void 0 ? void 0 : existingTokens.refresh_token)) {
            return {
                success: false,
                error: "No refresh token available"
            };
        }
        // Get server URL
        const serverUrl = localStorage.getItem("mcp-serverUrl-".concat(serverName));
        if (!serverUrl) {
            return {
                success: false,
                error: "Server URL not found for token refresh"
            };
        }
        const result = await (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f40$modelcontextprotocol$2f$sdk$2f$dist$2f$esm$2f$client$2f$auth$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["auth"])(provider, {
            serverUrl,
            scope: "mcp:*"
        });
        if (result === "AUTHORIZED") {
            const tokens = provider.tokens();
            if (tokens) {
                const serverConfig = createServerConfig(serverUrl, tokens);
                return {
                    success: true,
                    serverConfig
                };
            }
        }
        return {
            success: false,
            error: "Token refresh failed"
        };
    } catch (error) {
        return {
            success: false,
            error: error instanceof Error ? error.message : "Unknown refresh error"
        };
    }
}
function clearOAuthData(serverName) {
    localStorage.removeItem("mcp-tokens-".concat(serverName));
    localStorage.removeItem("mcp-client-".concat(serverName));
    localStorage.removeItem("mcp-verifier-".concat(serverName));
    localStorage.removeItem("mcp-serverUrl-".concat(serverName));
}
/**
 * Creates MCP server configuration with OAuth tokens
 */ function createServerConfig(serverUrl, tokens) {
    return {
        url: new URL(serverUrl),
        requestInit: {
            headers: tokens.access_token ? {
                Authorization: "Bearer ".concat(tokens.access_token)
            } : {}
        },
        oauth: tokens
    };
}
if (typeof globalThis.$RefreshHelpers$ === 'object' && globalThis.$RefreshHelpers !== null) {
    __turbopack_context__.k.registerExports(module, globalThis.$RefreshHelpers$);
}
}}),
"[project]/src/hooks/use-logger.ts [app-client] (ecmascript)": ((__turbopack_context__) => {
"use strict";

var { k: __turbopack_refresh__, m: module } = __turbopack_context__;
{
__turbopack_context__.s({
    "LOG_LEVELS": ()=>LOG_LEVELS,
    "LoggerUtils": ()=>LoggerUtils,
    "useLogger": ()=>useLogger,
    "useLoggerState": ()=>useLoggerState
});
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$build$2f$polyfills$2f$process$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = /*#__PURE__*/ __turbopack_context__.i("[project]/node_modules/next/dist/build/polyfills/process.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f40$swc$2f$helpers$2f$esm$2f$_define_property$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/@swc/helpers/esm/_define_property.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/next/dist/compiled/react/index.js [app-client] (ecmascript)");
;
var _s = __turbopack_context__.k.signature(), _s1 = __turbopack_context__.k.signature();
;
const LOG_LEVELS = {
    error: 0,
    warn: 1,
    info: 2,
    debug: 3,
    trace: 4
};
const LOG_COLORS = {
    error: "#ef4444",
    warn: "#f59e0b",
    info: "#3b82f6",
    debug: "#8b5cf6",
    trace: "#6b7280"
};
// Global logger state
class LoggerState {
    setConfig(config) {
        this.config = {
            ...this.config,
            ...config
        };
        this.notifyListeners();
    }
    getConfig() {
        return {
            ...this.config
        };
    }
    addEntry(entry) {
        this.buffer.push(entry);
        // Maintain buffer size limit
        if (this.buffer.length > this.config.maxBufferSize) {
            this.buffer = this.buffer.slice(-this.config.maxBufferSize);
        }
        this.notifyListeners();
    }
    getEntries() {
        return [
            ...this.buffer
        ];
    }
    getFilteredEntries(level, context) {
        let entries = this.buffer;
        if (level) {
            entries = entries.filter((entry)=>entry.level === level);
        }
        if (context) {
            const contextLower = context.toLowerCase();
            entries = entries.filter((entry)=>entry.context.toLowerCase().includes(contextLower));
        }
        return entries;
    }
    clearBuffer() {
        this.buffer = [];
        this.notifyListeners();
    }
    subscribe(listener) {
        this.listeners.add(listener);
        return ()=>this.listeners.delete(listener);
    }
    notifyListeners() {
        this.listeners.forEach((listener)=>listener());
    }
    shouldLog(level) {
        return LOG_LEVELS[level] <= LOG_LEVELS[this.config.level];
    }
    constructor(){
        (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f40$swc$2f$helpers$2f$esm$2f$_define_property$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["_"])(this, "config", {
            level: "info",
            enableConsole: true,
            maxBufferSize: 1000
        });
        (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f40$swc$2f$helpers$2f$esm$2f$_define_property$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["_"])(this, "buffer", []);
        (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f40$swc$2f$helpers$2f$esm$2f$_define_property$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["_"])(this, "listeners", new Set());
    }
}
const loggerState = new LoggerState();
// Set initial config based on environment
if ("TURBOPACK compile-time truthy", 1) {
    const isDevelopment = ("TURBOPACK compile-time value", "development") === "development";
    loggerState.setConfig({
        level: ("TURBOPACK compile-time truthy", 1) ? "debug" : "TURBOPACK unreachable",
        enableConsole: true
    });
}
function useLogger() {
    let context = arguments.length > 0 && arguments[0] !== void 0 ? arguments[0] : "Unknown";
    _s();
    const createLogFunction = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useCallback"])({
        "useLogger.useCallback[createLogFunction]": (level)=>({
                "useLogger.useCallback[createLogFunction]": (message, data, error)=>{
                    if (!loggerState.shouldLog(level)) {
                        return;
                    }
                    const timestamp = new Date().toISOString();
                    const entry = {
                        timestamp,
                        level,
                        context,
                        message,
                        data,
                        error
                    };
                    loggerState.addEntry(entry);
                    // Console output if enabled
                    const config = loggerState.getConfig();
                    if (config.enableConsole) {
                        outputToConsole(entry);
                    }
                }
            })["useLogger.useCallback[createLogFunction]"]
    }["useLogger.useCallback[createLogFunction]"], [
        context
    ]);
    const logger = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useMemo"])({
        "useLogger.useMemo[logger]": ()=>({
                error: createLogFunction("error"),
                warn: createLogFunction("warn"),
                info: createLogFunction("info"),
                debug: createLogFunction("debug"),
                trace: createLogFunction("trace"),
                context
            })
    }["useLogger.useMemo[logger]"], [
        createLogFunction,
        context
    ]);
    return logger;
}
_s(useLogger, "iU/5TBS9J00s8U245mgiUZSyY6c=");
function outputToConsole(entry) {
    const { timestamp, level, context, message, data, error } = entry;
    const time = new Date(timestamp).toLocaleTimeString();
    const color = LOG_COLORS[level];
    const contextStyle = "color: ".concat(color, "; font-weight: bold;");
    const messageStyle = "color: ".concat(color, ";");
    const args = [
        "%c[".concat(time, "] %c").concat(level.toUpperCase(), " %c[").concat(context, "] %c").concat(message),
        "color: #6b7280;",
        contextStyle,
        "color: #6b7280;",
        messageStyle
    ];
    if (data !== undefined) {
        args.push("\nData:", data);
    }
    if (error) {
        args.push("\nError:", error);
    }
    const consoleMethod = level === "error" ? console.error : level === "warn" ? console.warn : level === "debug" ? console.debug : console.log;
    consoleMethod(...args);
}
const LoggerUtils = {
    setLevel: (level)=>{
        loggerState.setConfig({
            level
        });
    },
    getLevel: ()=>{
        return loggerState.getConfig().level;
    },
    setConsoleEnabled: (enabled)=>{
        loggerState.setConfig({
            enableConsole: enabled
        });
    },
    isConsoleEnabled: ()=>{
        return loggerState.getConfig().enableConsole;
    },
    getAllEntries: ()=>{
        return loggerState.getEntries();
    },
    getFilteredEntries: (level, context)=>{
        return loggerState.getFilteredEntries(level, context);
    },
    clearLogs: ()=>{
        loggerState.clearBuffer();
    },
    subscribeToLogs: (callback)=>{
        return loggerState.subscribe(callback);
    },
    getConfig: ()=>{
        return loggerState.getConfig();
    },
    setConfig: (config)=>{
        loggerState.setConfig(config);
    }
};
function useLoggerState() {
    _s1();
    const [, forceUpdate] = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useState"])({});
    (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useEffect"])({
        "useLoggerState.useEffect": ()=>{
            const unsubscribe = loggerState.subscribe({
                "useLoggerState.useEffect.unsubscribe": ()=>{
                    forceUpdate({});
                }
            }["useLoggerState.useEffect.unsubscribe"]);
            return ({
                "useLoggerState.useEffect": ()=>{
                    unsubscribe();
                }
            })["useLoggerState.useEffect"];
        }
    }["useLoggerState.useEffect"], []);
    return {
        entries: loggerState.getEntries(),
        config: loggerState.getConfig(),
        setConfig: loggerState.setConfig.bind(loggerState),
        clearBuffer: loggerState.clearBuffer.bind(loggerState),
        getFilteredEntries: loggerState.getFilteredEntries.bind(loggerState)
    };
}
_s1(useLoggerState, "MbSebPoDkonI3jUouUZURnbmv7M=");
if (typeof globalThis.$RefreshHelpers$ === 'object' && globalThis.$RefreshHelpers !== null) {
    __turbopack_context__.k.registerExports(module, globalThis.$RefreshHelpers$);
}
}}),
"[project]/src/hooks/use-ai-provider-keys.ts [app-client] (ecmascript)": ((__turbopack_context__) => {
"use strict";

var { k: __turbopack_refresh__, m: module } = __turbopack_context__;
{
__turbopack_context__.s({
    "useAiProviderKeys": ()=>useAiProviderKeys
});
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/next/dist/compiled/react/index.js [app-client] (ecmascript)");
var _s = __turbopack_context__.k.signature();
"use client";
;
const STORAGE_KEY = "mcp-inspector-provider-tokens";
const defaultTokens = {
    anthropic: "",
    openai: "",
    ollama: "local",
    ollamaBaseUrl: "http://localhost:11434"
};
function useAiProviderKeys() {
    _s();
    const [tokens, setTokens] = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useState"])(defaultTokens);
    const [isInitialized, setIsInitialized] = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useState"])(false);
    // Load tokens from localStorage on mount
    (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useEffect"])({
        "useAiProviderKeys.useEffect": ()=>{
            if ("TURBOPACK compile-time truthy", 1) {
                try {
                    const stored = localStorage.getItem(STORAGE_KEY);
                    if (stored) {
                        const parsedTokens = JSON.parse(stored);
                        setTokens(parsedTokens);
                    }
                } catch (error) {
                    console.warn("Failed to load provider tokens from localStorage:", error);
                }
                setIsInitialized(true);
            }
        }
    }["useAiProviderKeys.useEffect"], []);
    // Save tokens to localStorage whenever they change
    (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useEffect"])({
        "useAiProviderKeys.useEffect": ()=>{
            if (isInitialized && "object" !== "undefined") {
                try {
                    localStorage.setItem(STORAGE_KEY, JSON.stringify(tokens));
                } catch (error) {
                    console.warn("Failed to save provider tokens to localStorage:", error);
                }
            }
        }
    }["useAiProviderKeys.useEffect"], [
        tokens,
        isInitialized
    ]);
    const setToken = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useCallback"])({
        "useAiProviderKeys.useCallback[setToken]": (provider, token)=>{
            setTokens({
                "useAiProviderKeys.useCallback[setToken]": (prev)=>({
                        ...prev,
                        [provider]: token
                    })
            }["useAiProviderKeys.useCallback[setToken]"]);
        }
    }["useAiProviderKeys.useCallback[setToken]"], []);
    const clearToken = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useCallback"])({
        "useAiProviderKeys.useCallback[clearToken]": (provider)=>{
            setTokens({
                "useAiProviderKeys.useCallback[clearToken]": (prev)=>({
                        ...prev,
                        [provider]: ""
                    })
            }["useAiProviderKeys.useCallback[clearToken]"]);
        }
    }["useAiProviderKeys.useCallback[clearToken]"], []);
    const clearAllTokens = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useCallback"])({
        "useAiProviderKeys.useCallback[clearAllTokens]": ()=>{
            setTokens(defaultTokens);
        }
    }["useAiProviderKeys.useCallback[clearAllTokens]"], []);
    const hasToken = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useCallback"])({
        "useAiProviderKeys.useCallback[hasToken]": (provider)=>{
            var _tokens_provider;
            return Boolean((_tokens_provider = tokens[provider]) === null || _tokens_provider === void 0 ? void 0 : _tokens_provider.trim());
        }
    }["useAiProviderKeys.useCallback[hasToken]"], [
        tokens
    ]);
    const getToken = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useCallback"])({
        "useAiProviderKeys.useCallback[getToken]": (provider)=>{
            return tokens[provider] || "";
        }
    }["useAiProviderKeys.useCallback[getToken]"], [
        tokens
    ]);
    const getOllamaBaseUrl = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useCallback"])({
        "useAiProviderKeys.useCallback[getOllamaBaseUrl]": ()=>{
            return tokens.ollamaBaseUrl || defaultTokens.ollamaBaseUrl;
        }
    }["useAiProviderKeys.useCallback[getOllamaBaseUrl]"], [
        tokens.ollamaBaseUrl
    ]);
    const setOllamaBaseUrl = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useCallback"])({
        "useAiProviderKeys.useCallback[setOllamaBaseUrl]": (url)=>{
            setTokens({
                "useAiProviderKeys.useCallback[setOllamaBaseUrl]": (prev)=>({
                        ...prev,
                        ollamaBaseUrl: url
                    })
            }["useAiProviderKeys.useCallback[setOllamaBaseUrl]"]);
        }
    }["useAiProviderKeys.useCallback[setOllamaBaseUrl]"], []);
    return {
        tokens,
        setToken,
        clearToken,
        clearAllTokens,
        hasToken,
        getToken,
        getOllamaBaseUrl,
        setOllamaBaseUrl
    };
}
_s(useAiProviderKeys, "OkGWT/UPOQdWWZeK0n4yRydd/9w=");
if (typeof globalThis.$RefreshHelpers$ === 'object' && globalThis.$RefreshHelpers !== null) {
    __turbopack_context__.k.registerExports(module, globalThis.$RefreshHelpers$);
}
}}),
"[project]/src/hooks/use-chat.ts [app-client] (ecmascript)": ((__turbopack_context__) => {
"use strict";

var { k: __turbopack_refresh__, m: module } = __turbopack_context__;
{
__turbopack_context__.s({
    "useChat": ()=>useChat
});
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/next/dist/compiled/react/index.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$chat$2d$utils$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/lib/chat-utils.ts [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$types$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/lib/types.ts [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$hooks$2f$use$2d$ai$2d$provider$2d$keys$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/hooks/use-ai-provider-keys.ts [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$ollama$2d$utils$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/lib/ollama-utils.ts [app-client] (ecmascript)");
var _s = __turbopack_context__.k.signature();
"use client";
;
;
;
;
;
function useChat() {
    let options = arguments.length > 0 && arguments[0] !== void 0 ? arguments[0] : {};
    _s();
    const { getToken, hasToken, tokens, getOllamaBaseUrl } = (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$hooks$2f$use$2d$ai$2d$provider$2d$keys$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useAiProviderKeys"])();
    const { initialMessages = [], serverConfigs, systemPrompt, onMessageSent, onMessageReceived, onError, onModelChange } = options;
    const [state, setState] = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useState"])({
        messages: initialMessages,
        isLoading: false,
        connectionStatus: "disconnected"
    });
    const [input, setInput] = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useState"])("");
    const [status, setStatus] = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useState"])("idle");
    const [model, setModel] = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useState"])(null);
    const [ollamaModels, setOllamaModels] = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useState"])([]);
    const [isOllamaRunning, setIsOllamaRunning] = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useState"])(false);
    const [elicitationRequest, setElicitationRequest] = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useState"])(null);
    const [elicitationLoading, setElicitationLoading] = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useState"])(false);
    const abortControllerRef = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useRef"])(null);
    const messagesRef = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useRef"])(state.messages);
    console.log("model", model);
    (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useEffect"])({
        "useChat.useEffect": ()=>{
            messagesRef.current = state.messages;
        }
    }["useChat.useEffect"], [
        state.messages
    ]);
    // Check for Ollama models on mount and periodically
    (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useEffect"])({
        "useChat.useEffect": ()=>{
            const checkOllama = {
                "useChat.useEffect.checkOllama": async ()=>{
                    const { isRunning, availableModels } = await (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$ollama$2d$utils$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["detectOllamaModels"])(getOllamaBaseUrl());
                    setIsOllamaRunning(isRunning);
                    // Convert string model names to ModelDefinition objects
                    const ollamaModelDefinitions = availableModels.map({
                        "useChat.useEffect.checkOllama.ollamaModelDefinitions": (modelName)=>({
                                id: modelName,
                                name: modelName,
                                provider: "ollama"
                            })
                    }["useChat.useEffect.checkOllama.ollamaModelDefinitions"]);
                    setOllamaModels(ollamaModelDefinitions);
                }
            }["useChat.useEffect.checkOllama"];
            checkOllama();
            // Check every 30 seconds for Ollama availability
            const interval = setInterval(checkOllama, 30000);
            return ({
                "useChat.useEffect": ()=>clearInterval(interval)
            })["useChat.useEffect"];
        }
    }["useChat.useEffect"], [
        getOllamaBaseUrl
    ]);
    (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useEffect"])({
        "useChat.useEffect": ()=>{
            // Only set a model if we don't have one or the current model is not available
            if (!model || !availableModels.some({
                "useChat.useEffect": (m)=>m.id === model.id
            }["useChat.useEffect"])) {
                if (isOllamaRunning && ollamaModels.length > 0) {
                    setModel(ollamaModels[0]);
                } else if (hasToken("anthropic")) {
                    const claudeModel = __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$types$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["SUPPORTED_MODELS"].find({
                        "useChat.useEffect.claudeModel": (m)=>m.id === __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$types$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["Model"].CLAUDE_3_5_SONNET_LATEST
                    }["useChat.useEffect.claudeModel"]);
                    if (claudeModel) setModel(claudeModel);
                } else if (hasToken("openai")) {
                    const gptModel = __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$types$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["SUPPORTED_MODELS"].find({
                        "useChat.useEffect.gptModel": (m)=>m.id === __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$types$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["Model"].GPT_4O
                    }["useChat.useEffect.gptModel"]);
                    if (gptModel) setModel(gptModel);
                } else {
                    setModel(null);
                }
            }
        }
    }["useChat.useEffect"], [
        tokens,
        ollamaModels,
        isOllamaRunning,
        hasToken,
        model
    ]);
    const currentApiKey = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useMemo"])({
        "useChat.useMemo[currentApiKey]": ()=>{
            if (model) {
                if (model.provider === "ollama") {
                    // For Ollama, return "local" if it's running and the model is available
                    return isOllamaRunning && ollamaModels.some({
                        "useChat.useMemo[currentApiKey]": (om)=>om.id === model.id || om.id.startsWith("".concat(model.id, ":"))
                    }["useChat.useMemo[currentApiKey]"]) ? "local" : "";
                }
                return getToken(model.provider);
            }
            return "";
        }
    }["useChat.useMemo[currentApiKey]"], [
        model,
        getToken,
        isOllamaRunning,
        ollamaModels
    ]);
    const handleModelChange = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useCallback"])({
        "useChat.useCallback[handleModelChange]": (newModel)=>{
            setModel(newModel);
            if (onModelChange) {
                onModelChange(newModel);
            }
        }
    }["useChat.useCallback[handleModelChange]"], [
        onModelChange
    ]);
    // Available models with API keys or local Ollama models
    const availableModels = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useMemo"])({
        "useChat.useMemo[availableModels]": ()=>{
            const availableModelsList = [];
            // Add supported models only if the provider has a valid API key
            for (const model of __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$types$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["SUPPORTED_MODELS"]){
                if (model.provider === "anthropic" && hasToken("anthropic")) {
                    availableModelsList.push(model);
                } else if (model.provider === "openai" && hasToken("openai")) {
                    availableModelsList.push(model);
                }
            }
            // Add Ollama models if Ollama is running
            if (isOllamaRunning && ollamaModels.length > 0) {
                availableModelsList.push(...ollamaModels);
            }
            return availableModelsList;
        }
    }["useChat.useMemo[availableModels]"], [
        isOllamaRunning,
        ollamaModels,
        hasToken
    ]);
    const handleStreamingEvent = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useCallback"])({
        "useChat.useCallback[handleStreamingEvent]": (parsed, assistantMessage, assistantContent, toolCalls, toolResults)=>{
            // Handle text content
            if ((parsed.type === "text" || !parsed.type && parsed.content) && parsed.content) {
                assistantContent.current += parsed.content;
                setState({
                    "useChat.useCallback[handleStreamingEvent]": (prev)=>({
                            ...prev,
                            messages: prev.messages.map({
                                "useChat.useCallback[handleStreamingEvent]": (msg)=>msg.id === assistantMessage.id ? {
                                        ...msg,
                                        content: assistantContent.current
                                    } : msg
                            }["useChat.useCallback[handleStreamingEvent]"])
                        })
                }["useChat.useCallback[handleStreamingEvent]"]);
                return;
            }
            // Handle tool calls
            if ((parsed.type === "tool_call" || !parsed.type && parsed.toolCall) && parsed.toolCall) {
                const toolCall = parsed.toolCall;
                toolCalls.current = [
                    ...toolCalls.current,
                    toolCall
                ];
                setState({
                    "useChat.useCallback[handleStreamingEvent]": (prev)=>({
                            ...prev,
                            messages: prev.messages.map({
                                "useChat.useCallback[handleStreamingEvent]": (msg)=>msg.id === assistantMessage.id ? {
                                        ...msg,
                                        toolCalls: [
                                            ...toolCalls.current
                                        ]
                                    } : msg
                            }["useChat.useCallback[handleStreamingEvent]"])
                        })
                }["useChat.useCallback[handleStreamingEvent]"]);
                return;
            }
            // Handle tool results
            if ((parsed.type === "tool_result" || !parsed.type && parsed.toolResult) && parsed.toolResult) {
                const toolResult = parsed.toolResult;
                toolResults.current = [
                    ...toolResults.current,
                    toolResult
                ];
                // Update the corresponding tool call status
                toolCalls.current = toolCalls.current.map({
                    "useChat.useCallback[handleStreamingEvent]": (tc)=>tc.id === toolResult.toolCallId ? {
                            ...tc,
                            status: toolResult.error ? "error" : "completed"
                        } : tc
                }["useChat.useCallback[handleStreamingEvent]"]);
                setState({
                    "useChat.useCallback[handleStreamingEvent]": (prev)=>({
                            ...prev,
                            messages: prev.messages.map({
                                "useChat.useCallback[handleStreamingEvent]": (msg)=>msg.id === assistantMessage.id ? {
                                        ...msg,
                                        toolCalls: [
                                            ...toolCalls.current
                                        ],
                                        toolResults: [
                                            ...toolResults.current
                                        ]
                                    } : msg
                            }["useChat.useCallback[handleStreamingEvent]"])
                        })
                }["useChat.useCallback[handleStreamingEvent]"]);
                return;
            }
            // Handle elicitation requests
            if (parsed.type === "elicitation_request") {
                setElicitationRequest({
                    requestId: parsed.requestId,
                    message: parsed.message,
                    schema: parsed.schema,
                    timestamp: parsed.timestamp
                });
                return;
            }
            // Handle elicitation completion
            if (parsed.type === "elicitation_complete") {
                setElicitationRequest(null);
                return;
            }
            // Handle errors
            if ((parsed.type === "error" || !parsed.type && parsed.error) && parsed.error) {
                throw new Error(parsed.error);
            }
        }
    }["useChat.useCallback[handleStreamingEvent]"], []);
    const sendChatRequest = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useCallback"])({
        "useChat.useCallback[sendChatRequest]": async (userMessage)=>{
            if (!serverConfigs || !model || !currentApiKey) {
                throw new Error("Missing required configuration: serverConfig, model, and apiKey are required");
            }
            const assistantMessage = (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$chat$2d$utils$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["createMessage"])("assistant", "");
            setState({
                "useChat.useCallback[sendChatRequest]": (prev)=>({
                        ...prev,
                        messages: [
                            ...prev.messages,
                            assistantMessage
                        ]
                    })
            }["useChat.useCallback[sendChatRequest]"]);
            try {
                var _abortControllerRef_current, _response_body;
                const response = await fetch("/api/mcp/chat", {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        Accept: "text/event-stream"
                    },
                    body: JSON.stringify({
                        serverConfigs,
                        model,
                        apiKey: currentApiKey,
                        systemPrompt,
                        messages: messagesRef.current.concat(userMessage),
                        ollamaBaseUrl: getOllamaBaseUrl()
                    }),
                    signal: (_abortControllerRef_current = abortControllerRef.current) === null || _abortControllerRef_current === void 0 ? void 0 : _abortControllerRef_current.signal
                });
                if (!response.ok) {
                    const errorText = await response.text();
                    let errorData;
                    try {
                        errorData = JSON.parse(errorText);
                    } catch (e) {
                        throw new Error("Chat request failed: ".concat(response.status));
                    }
                    throw new Error(errorData.error || "Chat request failed");
                }
                // Handle streaming response
                const reader = (_response_body = response.body) === null || _response_body === void 0 ? void 0 : _response_body.getReader();
                const decoder = new TextDecoder();
                const assistantContent = {
                    current: ""
                };
                const toolCalls = {
                    current: []
                };
                const toolResults = {
                    current: []
                };
                let buffer = "";
                let isDone = false;
                if (reader) {
                    while(!isDone){
                        const { done, value } = await reader.read();
                        if (done) break;
                        buffer += decoder.decode(value, {
                            stream: true
                        });
                        const lines = buffer.split("\n");
                        // Keep the last incomplete line in the buffer
                        buffer = lines.pop() || "";
                        for (const line of lines){
                            if (line.startsWith("data: ")) {
                                const data = line.slice(6).trim();
                                if (data === "[DONE]") {
                                    isDone = true;
                                    setState({
                                        "useChat.useCallback[sendChatRequest]": (prev)=>({
                                                ...prev,
                                                isLoading: false
                                            })
                                    }["useChat.useCallback[sendChatRequest]"]);
                                    break;
                                }
                                if (data) {
                                    try {
                                        const parsed = JSON.parse(data);
                                        handleStreamingEvent(parsed, assistantMessage, assistantContent, toolCalls, toolResults);
                                    } catch (parseError) {
                                        console.warn("Failed to parse SSE data:", data, parseError);
                                    }
                                }
                            }
                        }
                    }
                }
                // Ensure we have some content, even if empty
                if (!assistantContent.current && !toolCalls.current.length) {
                    console.warn("No content received from stream");
                }
                if (onMessageReceived) {
                    const finalMessage = {
                        ...assistantMessage,
                        content: assistantContent.current
                    };
                    onMessageReceived(finalMessage);
                }
            } catch (error) {
                setState({
                    "useChat.useCallback[sendChatRequest]": (prev)=>({
                            ...prev,
                            isLoading: false
                        })
                }["useChat.useCallback[sendChatRequest]"]);
                throw error;
            }
        }
    }["useChat.useCallback[sendChatRequest]"], [
        serverConfigs,
        model,
        currentApiKey,
        systemPrompt,
        onMessageReceived,
        handleStreamingEvent,
        getOllamaBaseUrl
    ]);
    const sendMessage = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useCallback"])({
        "useChat.useCallback[sendMessage]": async (content, attachments)=>{
            if (!content.trim() || state.isLoading) return;
            const userMessage = (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$chat$2d$utils$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["createMessage"])("user", content, attachments);
            setState({
                "useChat.useCallback[sendMessage]": (prev)=>({
                        ...prev,
                        messages: [
                            ...prev.messages,
                            userMessage
                        ],
                        isLoading: true,
                        error: undefined
                    })
            }["useChat.useCallback[sendMessage]"]);
            if (onMessageSent) {
                onMessageSent(userMessage);
            }
            // Create abort controller for this request
            abortControllerRef.current = new AbortController();
            try {
                await sendChatRequest(userMessage);
                setStatus("idle");
            } catch (error) {
                const errorMessage = error instanceof Error ? error.message : "An error occurred";
                setState({
                    "useChat.useCallback[sendMessage]": (prev)=>({
                            ...prev,
                            isLoading: false,
                            error: errorMessage
                        })
                }["useChat.useCallback[sendMessage]"]);
                setStatus("error");
                if (onError) {
                    onError(errorMessage);
                }
            }
        }
    }["useChat.useCallback[sendMessage]"], [
        state.isLoading,
        onMessageSent,
        sendChatRequest,
        onError
    ]);
    const stopGeneration = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useCallback"])({
        "useChat.useCallback[stopGeneration]": ()=>{
            if (abortControllerRef.current) {
                abortControllerRef.current.abort();
            }
            setState({
                "useChat.useCallback[stopGeneration]": (prev)=>({
                        ...prev,
                        isLoading: false
                    })
            }["useChat.useCallback[stopGeneration]"]);
            setStatus("idle");
        }
    }["useChat.useCallback[stopGeneration]"], []);
    const regenerateMessage = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useCallback"])({
        "useChat.useCallback[regenerateMessage]": async (messageId)=>{
            // Find the message and the user message before it
            const messages = messagesRef.current;
            const messageIndex = messages.findIndex({
                "useChat.useCallback[regenerateMessage].messageIndex": (m)=>m.id === messageId
            }["useChat.useCallback[regenerateMessage].messageIndex"]);
            if (messageIndex === -1 || messageIndex === 0) return;
            const userMessage = messages[messageIndex - 1];
            if (userMessage.role !== "user") return;
            // Remove the assistant message and regenerate
            setState({
                "useChat.useCallback[regenerateMessage]": (prev)=>({
                        ...prev,
                        messages: prev.messages.slice(0, messageIndex),
                        isLoading: true
                    })
            }["useChat.useCallback[regenerateMessage]"]);
            abortControllerRef.current = new AbortController();
            try {
                await sendChatRequest(userMessage);
                setStatus("idle");
            } catch (error) {
                const errorMessage = error instanceof Error ? error.message : "An error occurred";
                setState({
                    "useChat.useCallback[regenerateMessage]": (prev)=>({
                            ...prev,
                            isLoading: false,
                            error: errorMessage
                        })
                }["useChat.useCallback[regenerateMessage]"]);
                setStatus("error");
                if (onError) {
                    onError(errorMessage);
                }
            }
        }
    }["useChat.useCallback[regenerateMessage]"], [
        sendChatRequest,
        onError
    ]);
    const deleteMessage = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useCallback"])({
        "useChat.useCallback[deleteMessage]": (messageId)=>{
            setState({
                "useChat.useCallback[deleteMessage]": (prev)=>({
                        ...prev,
                        messages: prev.messages.filter({
                            "useChat.useCallback[deleteMessage]": (msg)=>msg.id !== messageId
                        }["useChat.useCallback[deleteMessage]"])
                    })
            }["useChat.useCallback[deleteMessage]"]);
        }
    }["useChat.useCallback[deleteMessage]"], []);
    const clearChat = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useCallback"])({
        "useChat.useCallback[clearChat]": ()=>{
            setState({
                "useChat.useCallback[clearChat]": (prev)=>({
                        ...prev,
                        messages: [],
                        error: undefined
                    })
            }["useChat.useCallback[clearChat]"]);
            setInput("");
        }
    }["useChat.useCallback[clearChat]"], []);
    const handleElicitationResponse = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useCallback"])({
        "useChat.useCallback[handleElicitationResponse]": async (action, parameters)=>{
            if (!elicitationRequest) {
                console.warn("Cannot handle elicitation response: no active request");
                return;
            }
            setElicitationLoading(true);
            try {
                let responseData = null;
                if (action === "accept") {
                    responseData = {
                        action: "accept",
                        content: parameters || {}
                    };
                } else {
                    responseData = {
                        action
                    };
                }
                const response = await fetch("/api/mcp/chat", {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify({
                        action: "elicitation_response",
                        requestId: elicitationRequest.requestId,
                        response: responseData
                    })
                });
                if (!response.ok) {
                    const errorMsg = "HTTP error! status: ".concat(response.status);
                    throw new Error(errorMsg);
                }
                setElicitationRequest(null);
            } catch (err) {
                const errorMessage = err instanceof Error ? err.message : "Unknown error";
                console.error("Error responding to elicitation request:", errorMessage);
                if (onError) {
                    onError("Error responding to elicitation request");
                }
            } finally{
                setElicitationLoading(false);
            }
        }
    }["useChat.useCallback[handleElicitationResponse]"], [
        elicitationRequest,
        onError
    ]);
    // Cleanup on unmount
    (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useEffect"])({
        "useChat.useEffect": ()=>{
            return ({
                "useChat.useEffect": ()=>{
                    if (abortControllerRef.current) {
                        abortControllerRef.current.abort();
                    }
                }
            })["useChat.useEffect"];
        }
    }["useChat.useEffect"], []);
    return {
        // State
        messages: state.messages,
        isLoading: state.isLoading,
        error: state.error,
        connectionStatus: state.connectionStatus,
        status,
        input,
        setInput,
        model,
        availableModels,
        hasValidApiKey: Boolean(currentApiKey),
        elicitationRequest,
        elicitationLoading,
        // Actions
        sendMessage,
        stopGeneration,
        regenerateMessage,
        deleteMessage,
        clearChat,
        setModel: handleModelChange,
        handleElicitationResponse
    };
}
_s(useChat, "4QrYfx37oOG+UDwsFByKvLx/Ujg=", false, function() {
    return [
        __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$hooks$2f$use$2d$ai$2d$provider$2d$keys$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useAiProviderKeys"]
    ];
});
if (typeof globalThis.$RefreshHelpers$ === 'object' && globalThis.$RefreshHelpers !== null) {
    __turbopack_context__.k.registerExports(module, globalThis.$RefreshHelpers$);
}
}}),
"[project]/src/hooks/use-mobile.ts [app-client] (ecmascript)": ((__turbopack_context__) => {
"use strict";

var { k: __turbopack_refresh__, m: module } = __turbopack_context__;
{
__turbopack_context__.s({
    "useIsMobile": ()=>useIsMobile
});
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/next/dist/compiled/react/index.js [app-client] (ecmascript)");
var _s = __turbopack_context__.k.signature();
;
const MOBILE_BREAKPOINT = 768;
function useIsMobile() {
    _s();
    const [isMobile, setIsMobile] = __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useState"](undefined);
    __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useEffect"]({
        "useIsMobile.useEffect": ()=>{
            const mql = window.matchMedia("(max-width: ".concat(MOBILE_BREAKPOINT - 1, "px)"));
            const onChange = {
                "useIsMobile.useEffect.onChange": ()=>{
                    setIsMobile(window.innerWidth < MOBILE_BREAKPOINT);
                }
            }["useIsMobile.useEffect.onChange"];
            mql.addEventListener("change", onChange);
            setIsMobile(window.innerWidth < MOBILE_BREAKPOINT);
            return ({
                "useIsMobile.useEffect": ()=>mql.removeEventListener("change", onChange)
            })["useIsMobile.useEffect"];
        }
    }["useIsMobile.useEffect"], []);
    return !!isMobile;
}
_s(useIsMobile, "D6B2cPXNCaIbeOx+abFr1uxLRM0=");
if (typeof globalThis.$RefreshHelpers$ === 'object' && globalThis.$RefreshHelpers !== null) {
    __turbopack_context__.k.registerExports(module, globalThis.$RefreshHelpers$);
}
}}),
"[project]/src/hooks/use-app-state.ts [app-client] (ecmascript)": ((__turbopack_context__) => {
"use strict";

var { k: __turbopack_refresh__, m: module } = __turbopack_context__;
{
__turbopack_context__.s({
    "useAppState": ()=>useAppState
});
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/next/dist/compiled/react/index.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$sonner$2f$dist$2f$index$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/sonner/dist/index.mjs [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$mcp$2d$oauth$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/lib/mcp-oauth.ts [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$hooks$2f$use$2d$logger$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/hooks/use-logger.ts [app-client] (ecmascript)");
var _s = __turbopack_context__.k.signature();
;
;
;
;
const STORAGE_KEY = "mcp-inspector-state";
function useAppState() {
    var _appState_servers_appState_selectedServer;
    _s();
    const logger = (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$hooks$2f$use$2d$logger$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useLogger"])("Connections");
    const [appState, setAppState] = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useState"])({
        servers: {},
        selectedServer: "none",
        selectedMultipleServers: [],
        isMultiSelectMode: false
    });
    const [isLoading, setIsLoading] = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useState"])(true);
    const [reconnectionTimeouts, setReconnectionTimeouts] = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useState"])({});
    // Load state from localStorage on mount
    (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useEffect"])({
        "useAppState.useEffect": ()=>{
            const savedState = localStorage.getItem(STORAGE_KEY);
            if (savedState) {
                try {
                    const parsed = JSON.parse(savedState);
                    // Ensure all loaded servers have the new fields with defaults
                    const updatedServers = Object.fromEntries(Object.entries(parsed.servers || {}).map({
                        "useAppState.useEffect.updatedServers": (param)=>{
                            let [name, server] = param;
                            return [
                                name,
                                {
                                    ...server,
                                    connectionStatus: server.connectionStatus || "disconnected",
                                    retryCount: server.retryCount || 0,
                                    lastConnectionTime: server.lastConnectionTime ? new Date(server.lastConnectionTime) : new Date()
                                }
                            ];
                        }
                    }["useAppState.useEffect.updatedServers"]));
                    setAppState({
                        servers: updatedServers,
                        selectedServer: parsed.selectedServer || "none",
                        selectedMultipleServers: parsed.selectedMultipleServers || [],
                        isMultiSelectMode: parsed.isMultiSelectMode || false
                    });
                } catch (error) {
                    logger.error("Failed to parse saved state", {
                        error: error instanceof Error ? error.message : "Unknown error"
                    });
                }
            }
            setIsLoading(false);
        }
    }["useAppState.useEffect"], []);
    // Save state to localStorage whenever it changes
    (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useEffect"])({
        "useAppState.useEffect": ()=>{
            if (!isLoading) {
                localStorage.setItem(STORAGE_KEY, JSON.stringify(appState));
            }
        }
    }["useAppState.useEffect"], [
        appState,
        isLoading
    ]);
    const setSelectedMultipleServersToAllServers = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useCallback"])({
        "useAppState.useCallback[setSelectedMultipleServersToAllServers]": ()=>{
            setAppState({
                "useAppState.useCallback[setSelectedMultipleServersToAllServers]": (prev)=>({
                        ...prev,
                        selectedMultipleServers: Object.keys(appState.servers)
                    })
            }["useAppState.useCallback[setSelectedMultipleServersToAllServers]"]);
        }
    }["useAppState.useCallback[setSelectedMultipleServersToAllServers]"], [
        appState.servers
    ]);
    // Check for OAuth callback completion on mount
    (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useEffect"])({
        "useAppState.useEffect": ()=>{
            if (!isLoading) {
                const urlParams = new URLSearchParams(window.location.search);
                const code = urlParams.get("code");
                const error = urlParams.get("error");
                if (code) {
                    handleOAuthCallbackComplete(code);
                } else if (error) {
                    __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$sonner$2f$dist$2f$index$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["toast"].error("OAuth authorization failed: ".concat(error));
                }
            }
        }
    }["useAppState.useEffect"], [
        isLoading
    ]);
    const convertFormToMCPConfig = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useCallback"])({
        "useAppState.useCallback[convertFormToMCPConfig]": (formData)=>{
            if (formData.type === "stdio") {
                return {
                    command: formData.command,
                    args: formData.args,
                    env: formData.env
                };
            } else {
                return {
                    url: new URL(formData.url),
                    requestInit: {
                        headers: formData.headers || {}
                    }
                };
            }
        }
    }["useAppState.useCallback[convertFormToMCPConfig]"], []);
    const handleConnect = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useCallback"])({
        "useAppState.useCallback[handleConnect]": async (formData)=>{
            // Validate form data first
            console.log("handleConnectFormData", formData);
            if (formData.type === "stdio") {
                if (!formData.command || formData.command.trim() === "") {
                    __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$sonner$2f$dist$2f$index$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["toast"].error("Command is required for STDIO connections");
                    return;
                }
            } else {
                if (!formData.url || formData.url.trim() === "") {
                    __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$sonner$2f$dist$2f$index$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["toast"].error("URL is required for HTTP connections");
                    return;
                }
                try {
                    new URL(formData.url);
                } catch (urlError) {
                    __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$sonner$2f$dist$2f$index$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["toast"].error("Invalid URL format: ".concat(formData.url, " ").concat(urlError));
                    return;
                }
            }
            // Convert form data to MCP config
            const mcpConfig = convertFormToMCPConfig(formData);
            // Immediately create server with 'connecting' state for responsive UI
            setAppState({
                "useAppState.useCallback[handleConnect]": (prev)=>({
                        ...prev,
                        servers: {
                            ...prev.servers,
                            [formData.name]: {
                                name: formData.name,
                                config: mcpConfig,
                                lastConnectionTime: new Date(),
                                connectionStatus: "connecting",
                                retryCount: 0
                            }
                        },
                        selectedServer: formData.name
                    })
            }["useAppState.useCallback[handleConnect]"]);
            try {
                // Handle OAuth flow for HTTP servers
                if (formData.type === "http" && formData.useOAuth && formData.url) {
                    // Mark as OAuth flow in progress
                    setAppState({
                        "useAppState.useCallback[handleConnect]": (prev)=>({
                                ...prev,
                                servers: {
                                    ...prev.servers,
                                    [formData.name]: {
                                        ...prev.servers[formData.name],
                                        connectionStatus: "oauth-flow"
                                    }
                                }
                            })
                    }["useAppState.useCallback[handleConnect]"]);
                    const oauthResult = await (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$mcp$2d$oauth$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["initiateOAuth"])({
                        serverName: formData.name,
                        serverUrl: formData.url,
                        scopes: formData.oauthScopes || [
                            "mcp:*"
                        ]
                    });
                    if (oauthResult.success) {
                        if (oauthResult.serverConfig) {
                            // Already authorized, test connection immediately
                            try {
                                const response = await fetch("/api/mcp/connect", {
                                    method: "POST",
                                    headers: {
                                        "Content-Type": "application/json"
                                    },
                                    body: JSON.stringify({
                                        serverConfig: oauthResult.serverConfig
                                    })
                                });
                                const connectionResult = await response.json();
                                if (connectionResult.success) {
                                    setAppState({
                                        "useAppState.useCallback[handleConnect]": (prev)=>({
                                                ...prev,
                                                servers: {
                                                    ...prev.servers,
                                                    [formData.name]: {
                                                        ...prev.servers[formData.name],
                                                        config: oauthResult.serverConfig,
                                                        connectionStatus: "connected",
                                                        oauthTokens: (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$mcp$2d$oauth$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["getStoredTokens"])(formData.name),
                                                        lastError: undefined
                                                    }
                                                }
                                            })
                                    }["useAppState.useCallback[handleConnect]"]);
                                    __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$sonner$2f$dist$2f$index$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["toast"].success("Connected successfully with OAuth!");
                                } else {
                                    setAppState({
                                        "useAppState.useCallback[handleConnect]": (prev)=>({
                                                ...prev,
                                                servers: {
                                                    ...prev.servers,
                                                    [formData.name]: {
                                                        ...prev.servers[formData.name],
                                                        connectionStatus: "failed",
                                                        lastError: connectionResult.error || "OAuth connection test failed"
                                                    }
                                                }
                                            })
                                    }["useAppState.useCallback[handleConnect]"]);
                                    __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$sonner$2f$dist$2f$index$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["toast"].error("OAuth succeeded but connection failed: ".concat(connectionResult.error));
                                }
                            } catch (error) {
                                const errorMessage = error instanceof Error ? error.message : "Unknown error";
                                setAppState({
                                    "useAppState.useCallback[handleConnect]": (prev)=>({
                                            ...prev,
                                            servers: {
                                                ...prev.servers,
                                                [formData.name]: {
                                                    ...prev.servers[formData.name],
                                                    connectionStatus: "failed",
                                                    lastError: errorMessage
                                                }
                                            }
                                        })
                                }["useAppState.useCallback[handleConnect]"]);
                                __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$sonner$2f$dist$2f$index$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["toast"].error("OAuth succeeded but connection test threw error: ".concat(errorMessage));
                            }
                            return;
                        } else {
                            // Redirect needed - keep oauth-flow status
                            __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$sonner$2f$dist$2f$index$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["toast"].success("OAuth flow initiated. You will be redirected to authorize access.");
                            return;
                        }
                    } else {
                        setAppState({
                            "useAppState.useCallback[handleConnect]": (prev)=>({
                                    ...prev,
                                    servers: {
                                        ...prev.servers,
                                        [formData.name]: {
                                            ...prev.servers[formData.name],
                                            connectionStatus: "failed",
                                            retryCount: 0,
                                            lastError: oauthResult.error || "OAuth initialization failed"
                                        }
                                    }
                                })
                        }["useAppState.useCallback[handleConnect]"]);
                        __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$sonner$2f$dist$2f$index$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["toast"].error("OAuth initialization failed: ".concat(oauthResult.error));
                        return;
                    }
                }
                // For non-OAuth connections, test connection using the stateless endpoint
                const response = await fetch("/api/mcp/connect", {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify({
                        serverConfig: mcpConfig
                    })
                });
                const result = await response.json();
                if (result.success) {
                    // Update existing server to connected state
                    setAppState({
                        "useAppState.useCallback[handleConnect]": (prev)=>({
                                ...prev,
                                servers: {
                                    ...prev.servers,
                                    [formData.name]: {
                                        ...prev.servers[formData.name],
                                        connectionStatus: "connected",
                                        lastConnectionTime: new Date(),
                                        retryCount: 0,
                                        lastError: undefined
                                    }
                                }
                            })
                    }["useAppState.useCallback[handleConnect]"]);
                    logger.info("Connection successful", {
                        serverName: formData.name
                    });
                    __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$sonner$2f$dist$2f$index$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["toast"].success("Connected successfully!");
                } else {
                    // Update existing server to failed state
                    setAppState({
                        "useAppState.useCallback[handleConnect]": (prev)=>({
                                ...prev,
                                servers: {
                                    ...prev.servers,
                                    [formData.name]: {
                                        ...prev.servers[formData.name],
                                        connectionStatus: "failed",
                                        retryCount: 0,
                                        lastError: result.error
                                    }
                                }
                            })
                    }["useAppState.useCallback[handleConnect]"]);
                    logger.error("Connection failed", {
                        serverName: formData.name,
                        error: result.error
                    });
                    __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$sonner$2f$dist$2f$index$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["toast"].error("Failed to connect to ".concat(formData.name));
                }
            } catch (error) {
                const errorMessage = error instanceof Error ? error.message : "Unknown error";
                // Update existing server to failed state
                setAppState({
                    "useAppState.useCallback[handleConnect]": (prev)=>({
                            ...prev,
                            servers: {
                                ...prev.servers,
                                [formData.name]: {
                                    ...prev.servers[formData.name],
                                    connectionStatus: "failed",
                                    retryCount: 0,
                                    lastError: errorMessage
                                }
                            }
                        })
                }["useAppState.useCallback[handleConnect]"]);
                logger.error("Connection failed", {
                    serverName: formData.name,
                    error: errorMessage
                });
                __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$sonner$2f$dist$2f$index$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["toast"].error("Network error: ".concat(errorMessage));
            }
        }
    }["useAppState.useCallback[handleConnect]"], [
        convertFormToMCPConfig
    ]);
    const handleOAuthCallbackComplete = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useCallback"])({
        "useAppState.useCallback[handleOAuthCallbackComplete]": async (code)=>{
            // Clean up URL parameters immediately
            window.history.replaceState({}, document.title, window.location.pathname);
            try {
                const result = await (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$mcp$2d$oauth$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["handleOAuthCallback"])(code);
                console.log("OAuth callback result:", result);
                if (result.success && result.serverConfig && result.serverName) {
                    const serverName = result.serverName;
                    // Check if server exists and is in oauth-flow state
                    const existingServer = appState.servers[serverName];
                    if (!existingServer || existingServer.connectionStatus !== "oauth-flow") {
                        // Create new server entry if it doesn't exist or wasn't in oauth flow
                        setAppState({
                            "useAppState.useCallback[handleOAuthCallbackComplete]": (prev)=>({
                                    ...prev,
                                    servers: {
                                        ...prev.servers,
                                        [serverName]: {
                                            name: serverName,
                                            config: result.serverConfig,
                                            oauthTokens: (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$mcp$2d$oauth$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["getStoredTokens"])(serverName),
                                            lastConnectionTime: new Date(),
                                            connectionStatus: "connecting",
                                            retryCount: 0
                                        }
                                    },
                                    selectedServer: serverName
                                })
                        }["useAppState.useCallback[handleOAuthCallbackComplete]"]);
                    } else {
                        // Update existing server to connecting with OAuth config
                        setAppState({
                            "useAppState.useCallback[handleOAuthCallbackComplete]": (prev)=>({
                                    ...prev,
                                    servers: {
                                        ...prev.servers,
                                        [serverName]: {
                                            ...prev.servers[serverName],
                                            config: result.serverConfig,
                                            oauthTokens: (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$mcp$2d$oauth$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["getStoredTokens"])(serverName),
                                            connectionStatus: "connecting",
                                            lastError: undefined
                                        }
                                    },
                                    selectedServer: serverName
                                })
                        }["useAppState.useCallback[handleOAuthCallbackComplete]"]);
                    }
                    // Test the connection
                    try {
                        const response = await fetch("/api/mcp/connect", {
                            method: "POST",
                            headers: {
                                "Content-Type": "application/json"
                            },
                            body: JSON.stringify({
                                serverConfig: result.serverConfig
                            })
                        });
                        const connectionResult = await response.json();
                        if (connectionResult.success) {
                            setAppState({
                                "useAppState.useCallback[handleOAuthCallbackComplete]": (prev)=>({
                                        ...prev,
                                        servers: {
                                            ...prev.servers,
                                            [serverName]: {
                                                ...prev.servers[serverName],
                                                connectionStatus: "connected",
                                                lastConnectionTime: new Date(),
                                                lastError: undefined
                                            }
                                        }
                                    })
                            }["useAppState.useCallback[handleOAuthCallbackComplete]"]);
                            logger.info("OAuth connection successful", {
                                serverName
                            });
                            __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$sonner$2f$dist$2f$index$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["toast"].success("OAuth connection successful! Connected to ".concat(serverName, "."));
                        } else {
                            setAppState({
                                "useAppState.useCallback[handleOAuthCallbackComplete]": (prev)=>({
                                        ...prev,
                                        servers: {
                                            ...prev.servers,
                                            [serverName]: {
                                                ...prev.servers[serverName],
                                                connectionStatus: "failed",
                                                lastError: connectionResult.error || "Connection test failed after OAuth"
                                            }
                                        }
                                    })
                            }["useAppState.useCallback[handleOAuthCallbackComplete]"]);
                            logger.error("OAuth connection test failed", {
                                serverName,
                                error: connectionResult.error
                            });
                            __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$sonner$2f$dist$2f$index$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["toast"].error("OAuth succeeded but connection test failed: ".concat(connectionResult.error));
                        }
                    } catch (connectionError) {
                        const errorMessage = connectionError instanceof Error ? connectionError.message : "Unknown connection error";
                        setAppState({
                            "useAppState.useCallback[handleOAuthCallbackComplete]": (prev)=>({
                                    ...prev,
                                    servers: {
                                        ...prev.servers,
                                        [serverName]: {
                                            ...prev.servers[serverName],
                                            connectionStatus: "failed",
                                            lastError: errorMessage
                                        }
                                    }
                                })
                        }["useAppState.useCallback[handleOAuthCallbackComplete]"]);
                        logger.error("OAuth connection test error", {
                            serverName,
                            error: errorMessage
                        });
                        __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$sonner$2f$dist$2f$index$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["toast"].error("OAuth succeeded but connection test failed: ".concat(errorMessage));
                    }
                } else {
                    throw new Error(result.error || "OAuth callback failed");
                }
            } catch (error) {
                const errorMessage = error instanceof Error ? error.message : "Unknown error";
                __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$sonner$2f$dist$2f$index$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["toast"].error("Error completing OAuth flow: ".concat(errorMessage));
                logger.error("OAuth callback failed", {
                    error: errorMessage
                });
            }
        }
    }["useAppState.useCallback[handleOAuthCallbackComplete]"], [
        appState.servers,
        logger
    ]);
    const getValidAccessToken = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useCallback"])({
        "useAppState.useCallback[getValidAccessToken]": async (serverName)=>{
            const server = appState.servers[serverName];
            if (!(server === null || server === void 0 ? void 0 : server.oauthTokens)) {
                return null;
            }
            // The SDK handles token refresh automatically
            return server.oauthTokens.access_token || null;
        }
    }["useAppState.useCallback[getValidAccessToken]"], [
        appState.servers
    ]);
    const handleDisconnect = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useCallback"])({
        "useAppState.useCallback[handleDisconnect]": async (serverName)=>{
            logger.info("Disconnecting from server", {
                serverName
            });
            // Clear OAuth data
            (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$mcp$2d$oauth$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["clearOAuthData"])(serverName);
            // Remove server from state (no API call needed for stateless architecture)
            setAppState({
                "useAppState.useCallback[handleDisconnect]": (prev)=>{
                    const newServers = {
                        ...prev.servers
                    };
                    delete newServers[serverName];
                    return {
                        ...prev,
                        servers: newServers,
                        selectedServer: prev.selectedServer === serverName ? "none" : prev.selectedServer,
                        selectedMultipleServers: prev.selectedMultipleServers.filter({
                            "useAppState.useCallback[handleDisconnect]": (name)=>name !== serverName
                        }["useAppState.useCallback[handleDisconnect]"])
                    };
                }
            }["useAppState.useCallback[handleDisconnect]"]);
        }
    }["useAppState.useCallback[handleDisconnect]"], []);
    const handleReconnect = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useCallback"])({
        "useAppState.useCallback[handleReconnect]": async (serverName)=>{
            logger.info("Reconnecting to server", {
                serverName
            });
            const server = appState.servers[serverName];
            if (!server) {
                throw new Error("Server ".concat(serverName, " not found"));
            }
            // Update status to connecting
            setAppState({
                "useAppState.useCallback[handleReconnect]": (prev)=>({
                        ...prev,
                        servers: {
                            ...prev.servers,
                            [serverName]: {
                                ...server,
                                connectionStatus: "connecting"
                            }
                        }
                    })
            }["useAppState.useCallback[handleReconnect]"]);
            try {
                let serverConfig = server.config;
                // If server has OAuth tokens, try to refresh them
                if (server.oauthTokens) {
                    logger.info("Attempting to refresh OAuth tokens", {
                        serverName
                    });
                    const refreshResult = await (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$mcp$2d$oauth$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["refreshOAuthTokens"])(serverName);
                    if (refreshResult.success && refreshResult.serverConfig) {
                        logger.info("OAuth tokens refreshed successfully", {
                            serverName
                        });
                        serverConfig = refreshResult.serverConfig;
                        // Update server state with refreshed config and tokens
                        setAppState({
                            "useAppState.useCallback[handleReconnect]": (prev)=>({
                                    ...prev,
                                    servers: {
                                        ...prev.servers,
                                        [serverName]: {
                                            ...prev.servers[serverName],
                                            config: refreshResult.serverConfig,
                                            oauthTokens: (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$lib$2f$mcp$2d$oauth$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["getStoredTokens"])(serverName)
                                        }
                                    }
                                })
                        }["useAppState.useCallback[handleReconnect]"]);
                    } else {
                        logger.warn("OAuth token refresh failed, attempting with existing tokens", {
                            serverName,
                            error: refreshResult.error
                        });
                    }
                }
                // Test connection using the stateless endpoint
                const response = await fetch("/api/mcp/connect", {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify({
                        serverConfig
                    })
                });
                const result = await response.json();
                if (result.success) {
                    // Update status to connected and reset retry count
                    setAppState({
                        "useAppState.useCallback[handleReconnect]": (prev)=>({
                                ...prev,
                                servers: {
                                    ...prev.servers,
                                    [serverName]: {
                                        ...prev.servers[serverName],
                                        connectionStatus: "connected",
                                        lastConnectionTime: new Date(),
                                        retryCount: 0,
                                        lastError: undefined
                                    }
                                }
                            })
                    }["useAppState.useCallback[handleReconnect]"]);
                    logger.info("Reconnection successful", {
                        serverName,
                        result
                    });
                    return {
                        success: true
                    };
                } else {
                    // Update status to failed and increment retry count
                    setAppState({
                        "useAppState.useCallback[handleReconnect]": (prev)=>({
                                ...prev,
                                servers: {
                                    ...prev.servers,
                                    [serverName]: {
                                        ...prev.servers[serverName],
                                        connectionStatus: "failed",
                                        retryCount: prev.servers[serverName].retryCount + 1,
                                        lastError: result.error || "Connection test failed"
                                    }
                                }
                            })
                    }["useAppState.useCallback[handleReconnect]"]);
                    logger.error("Reconnection failed", {
                        serverName,
                        result
                    });
                    __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$sonner$2f$dist$2f$index$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["toast"].error("Failed to connect: ".concat(serverName));
                }
            } catch (error) {
                const errorMessage = error instanceof Error ? error.message : "Unknown error";
                // Update status to failed and increment retry count
                setAppState({
                    "useAppState.useCallback[handleReconnect]": (prev)=>({
                            ...prev,
                            servers: {
                                ...prev.servers,
                                [serverName]: {
                                    ...prev.servers[serverName],
                                    connectionStatus: "failed",
                                    retryCount: prev.servers[serverName].retryCount + 1,
                                    lastError: errorMessage
                                }
                            }
                        })
                }["useAppState.useCallback[handleReconnect]"]);
                logger.error("Reconnection failed", {
                    serverName,
                    error: errorMessage
                });
                throw error;
            }
        }
    }["useAppState.useCallback[handleReconnect]"], [
        appState.servers
    ]);
    // Effect to handle cleanup of reconnection timeouts (automatic retries disabled)
    (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useEffect"])({
        "useAppState.useEffect": ()=>{
            // Cleanup timeouts for servers that are no longer failed or have been removed
            Object.keys(reconnectionTimeouts).forEach({
                "useAppState.useEffect": (serverName)=>{
                    const server = appState.servers[serverName];
                    if (!server || server.connectionStatus !== "failed") {
                        clearTimeout(reconnectionTimeouts[serverName]);
                        setReconnectionTimeouts({
                            "useAppState.useEffect": (prev)=>{
                                const newTimeouts = {
                                    ...prev
                                };
                                delete newTimeouts[serverName];
                                return newTimeouts;
                            }
                        }["useAppState.useEffect"]);
                    }
                }
            }["useAppState.useEffect"]);
        }
    }["useAppState.useEffect"], [
        appState.servers,
        reconnectionTimeouts
    ]);
    // Cleanup timeouts on unmount
    (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useEffect"])({
        "useAppState.useEffect": ()=>{
            return ({
                "useAppState.useEffect": ()=>{
                    Object.values(reconnectionTimeouts).forEach(clearTimeout);
                }
            })["useAppState.useEffect"];
        }
    }["useAppState.useEffect"], [
        reconnectionTimeouts
    ]);
    const setSelectedServer = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useCallback"])({
        "useAppState.useCallback[setSelectedServer]": (serverName)=>{
            setAppState({
                "useAppState.useCallback[setSelectedServer]": (prev)=>({
                        ...prev,
                        selectedServer: serverName
                    })
            }["useAppState.useCallback[setSelectedServer]"]);
        }
    }["useAppState.useCallback[setSelectedServer]"], []);
    const setSelectedMCPConfigs = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useCallback"])({
        "useAppState.useCallback[setSelectedMCPConfigs]": (serverNames)=>{
            setAppState({
                "useAppState.useCallback[setSelectedMCPConfigs]": (prev)=>({
                        ...prev,
                        selectedMCPConfigs: serverNames
                    })
            }["useAppState.useCallback[setSelectedMCPConfigs]"]);
        }
    }["useAppState.useCallback[setSelectedMCPConfigs]"], []);
    const toggleMultiSelectMode = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useCallback"])({
        "useAppState.useCallback[toggleMultiSelectMode]": (enabled)=>{
            setAppState({
                "useAppState.useCallback[toggleMultiSelectMode]": (prev)=>({
                        ...prev,
                        isMultiSelectMode: enabled,
                        // Reset selections when switching modes
                        selectedMultipleServers: enabled ? [] : prev.selectedMultipleServers
                    })
            }["useAppState.useCallback[toggleMultiSelectMode]"]);
        }
    }["useAppState.useCallback[toggleMultiSelectMode]"], []);
    const toggleServerSelection = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useCallback"])({
        "useAppState.useCallback[toggleServerSelection]": (serverName)=>{
            setAppState({
                "useAppState.useCallback[toggleServerSelection]": (prev)=>{
                    const currentSelected = prev.selectedMultipleServers;
                    const isSelected = currentSelected.includes(serverName);
                    return {
                        ...prev,
                        selectedMultipleServers: isSelected ? currentSelected.filter({
                            "useAppState.useCallback[toggleServerSelection]": (name)=>name !== serverName
                        }["useAppState.useCallback[toggleServerSelection]"]) : [
                            ...currentSelected,
                            serverName
                        ]
                    };
                }
            }["useAppState.useCallback[toggleServerSelection]"]);
        }
    }["useAppState.useCallback[toggleServerSelection]"], []);
    const handleUpdate = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useCallback"])({
        "useAppState.useCallback[handleUpdate]": async (originalServerName, formData)=>{
            var _originalServer_config_url;
            console.log("handleUpdateFormData", formData);
            const originalServer = appState.servers[originalServerName];
            const hadOAuthTokens = (originalServer === null || originalServer === void 0 ? void 0 : originalServer.oauthTokens) != null;
            // For OAuth servers, preserve the tokens if the server name and URL haven't changed
            // and the user is still using OAuth authentication
            const shouldPreserveOAuth = hadOAuthTokens && formData.useOAuth && formData.name === originalServerName && formData.type === "http" && formData.url === ((_originalServer_config_url = originalServer.config.url) === null || _originalServer_config_url === void 0 ? void 0 : _originalServer_config_url.toString());
            if (shouldPreserveOAuth) {
                // Update server config without disconnecting to preserve OAuth tokens
                const mcpConfig = convertFormToMCPConfig(formData);
                // Update the server configuration in place
                setAppState({
                    "useAppState.useCallback[handleUpdate]": (prev)=>({
                            ...prev,
                            servers: {
                                ...prev.servers,
                                [originalServerName]: {
                                    ...prev.servers[originalServerName],
                                    config: mcpConfig,
                                    connectionStatus: "connecting"
                                }
                            }
                        })
                }["useAppState.useCallback[handleUpdate]"]);
                // Test connection with existing OAuth tokens
                try {
                    const response = await fetch("/api/mcp/connect", {
                        method: "POST",
                        headers: {
                            "Content-Type": "application/json"
                        },
                        body: JSON.stringify({
                            serverConfig: originalServer.config
                        })
                    });
                    const result = await response.json();
                    if (result.success) {
                        setAppState({
                            "useAppState.useCallback[handleUpdate]": (prev)=>({
                                    ...prev,
                                    servers: {
                                        ...prev.servers,
                                        [originalServerName]: {
                                            ...prev.servers[originalServerName],
                                            config: mcpConfig,
                                            connectionStatus: "connected",
                                            lastConnectionTime: new Date(),
                                            retryCount: 0,
                                            lastError: undefined
                                        }
                                    }
                                })
                        }["useAppState.useCallback[handleUpdate]"]);
                        __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$sonner$2f$dist$2f$index$2e$mjs__$5b$app$2d$client$5d$__$28$ecmascript$29$__["toast"].success("Server configuration updated successfully!");
                        return;
                    } else {
                        // Connection failed, fall back to full reconnect
                        console.warn("OAuth connection test failed, falling back to full reconnect");
                    }
                } catch (error) {
                    console.warn("OAuth connection test error, falling back to full reconnect", error);
                }
            }
            // Full disconnect and reconnect for non-OAuth or when preservation fails
            // First, disconnect the original server
            await handleDisconnect(originalServerName);
            // Then connect with the new configuration
            await handleConnect(formData);
            // If the server name changed, update selected server
            if (appState.selectedServer === originalServerName && formData.name !== originalServerName) {
                setSelectedServer(formData.name);
            }
        }
    }["useAppState.useCallback[handleUpdate]"], [
        appState.servers,
        appState.selectedServer,
        convertFormToMCPConfig,
        handleDisconnect,
        handleConnect,
        setSelectedServer
    ]);
    return {
        // State
        appState,
        isLoading,
        // Computed values
        connectedServerConfigs: appState.servers,
        selectedServerEntry: appState.servers[appState.selectedServer],
        selectedMCPConfig: (_appState_servers_appState_selectedServer = appState.servers[appState.selectedServer]) === null || _appState_servers_appState_selectedServer === void 0 ? void 0 : _appState_servers_appState_selectedServer.config,
        selectedMCPConfigs: appState.selectedMultipleServers.map((name)=>appState.servers[name]).filter(Boolean),
        selectedMCPConfigsMap: appState.selectedMultipleServers.reduce((acc, name)=>{
            if (appState.servers[name]) {
                acc[name] = appState.servers[name].config;
            }
            return acc;
        }, {}),
        isMultiSelectMode: appState.isMultiSelectMode,
        // Actions
        handleConnect,
        handleDisconnect,
        handleReconnect,
        handleUpdate,
        setSelectedServer,
        setSelectedMCPConfigs,
        toggleMultiSelectMode,
        toggleServerSelection,
        getValidAccessToken,
        setSelectedMultipleServersToAllServers
    };
}
_s(useAppState, "mmJliGOvHoxlm4KP04v36OLYSG4=", false, function() {
    return [
        __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$hooks$2f$use$2d$logger$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useLogger"]
    ];
});
if (typeof globalThis.$RefreshHelpers$ === 'object' && globalThis.$RefreshHelpers !== null) {
    __turbopack_context__.k.registerExports(module, globalThis.$RefreshHelpers$);
}
}}),
"[project]/src/server/data:bb20a5 [app-client] (ecmascript) <text/javascript>": ((__turbopack_context__) => {
"use strict";

var { k: __turbopack_refresh__, m: module } = __turbopack_context__;
{
/* __next_internal_action_entry_do_not_use__ [{"70562871cada944d8eae278f3f22f800b6dc5b5308":"setValueToCookie"},"src/server/server-actions.ts",""] */ __turbopack_context__.s({
    "setValueToCookie": ()=>setValueToCookie
});
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$build$2f$webpack$2f$loaders$2f$next$2d$flight$2d$loader$2f$action$2d$client$2d$wrapper$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/next/dist/build/webpack/loaders/next-flight-loader/action-client-wrapper.js [app-client] (ecmascript)");
"use turbopack no side effects";
;
var setValueToCookie = /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$build$2f$webpack$2f$loaders$2f$next$2d$flight$2d$loader$2f$action$2d$client$2d$wrapper$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["createServerReference"])("70562871cada944d8eae278f3f22f800b6dc5b5308", __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$build$2f$webpack$2f$loaders$2f$next$2d$flight$2d$loader$2f$action$2d$client$2d$wrapper$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["callServer"], void 0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$build$2f$webpack$2f$loaders$2f$next$2d$flight$2d$loader$2f$action$2d$client$2d$wrapper$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["findSourceMapURL"], "setValueToCookie"); //# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4vc2VydmVyLWFjdGlvbnMudHMiXSwic291cmNlc0NvbnRlbnQiOlsiXCJ1c2Ugc2VydmVyXCI7XG5cbmltcG9ydCB7IGNvb2tpZXMgfSBmcm9tIFwibmV4dC9oZWFkZXJzXCI7XG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBnZXRWYWx1ZUZyb21Db29raWUoXG4gIGtleTogc3RyaW5nLFxuKTogUHJvbWlzZTxzdHJpbmcgfCB1bmRlZmluZWQ+IHtcbiAgY29uc3QgY29va2llU3RvcmUgPSBhd2FpdCBjb29raWVzKCk7XG4gIHJldHVybiBjb29raWVTdG9yZS5nZXQoa2V5KT8udmFsdWU7XG59XG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBzZXRWYWx1ZVRvQ29va2llKFxuICBrZXk6IHN0cmluZyxcbiAgdmFsdWU6IHN0cmluZyxcbiAgb3B0aW9uczogeyBwYXRoPzogc3RyaW5nOyBtYXhBZ2U/OiBudW1iZXIgfSA9IHt9LFxuKTogUHJvbWlzZTx2b2lkPiB7XG4gIGNvbnN0IGNvb2tpZVN0b3JlID0gYXdhaXQgY29va2llcygpO1xuICBjb29raWVTdG9yZS5zZXQoa2V5LCB2YWx1ZSwge1xuICAgIHBhdGg6IG9wdGlvbnMucGF0aCA/PyBcIi9cIixcbiAgICBtYXhBZ2U6IG9wdGlvbnMubWF4QWdlID8/IDYwICogNjAgKiAyNCAqIDcsIC8vIGRlZmF1bHQ6IDcgZGF5c1xuICB9KTtcbn1cblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGdldFByZWZlcmVuY2U8VCBleHRlbmRzIHN0cmluZz4oXG4gIGtleTogc3RyaW5nLFxuICBhbGxvd2VkOiByZWFkb25seSBUW10sXG4gIGZhbGxiYWNrOiBULFxuKTogUHJvbWlzZTxUPiB7XG4gIGNvbnN0IGNvb2tpZVN0b3JlID0gYXdhaXQgY29va2llcygpO1xuICBjb25zdCBjb29raWUgPSBjb29raWVTdG9yZS5nZXQoa2V5KTtcbiAgY29uc3QgdmFsdWUgPSBjb29raWUgPyBjb29raWUudmFsdWUudHJpbSgpIDogdW5kZWZpbmVkO1xuICByZXR1cm4gYWxsb3dlZC5pbmNsdWRlcyh2YWx1ZSBhcyBUKSA/ICh2YWx1ZSBhcyBUKSA6IGZhbGxiYWNrO1xufVxuIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJzU0FXc0IifQ==
if (typeof globalThis.$RefreshHelpers$ === 'object' && globalThis.$RefreshHelpers !== null) {
    __turbopack_context__.k.registerExports(module, globalThis.$RefreshHelpers$);
}
}}),
"[project]/src/app/page.tsx [app-client] (ecmascript)": ((__turbopack_context__) => {
"use strict";

var { k: __turbopack_refresh__, m: module } = __turbopack_context__;
{
__turbopack_context__.s({
    "default": ()=>Home
});
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/next/dist/compiled/react/jsx-dev-runtime.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/node_modules/next/dist/compiled/react/index.js [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$components$2f$ServersTab$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/components/ServersTab.tsx [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$components$2f$ToolsTab$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/components/ToolsTab.tsx [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$components$2f$ResourcesTab$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/components/ResourcesTab.tsx [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$components$2f$PromptsTab$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/components/PromptsTab.tsx [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$components$2f$ChatTab$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/components/ChatTab.tsx [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$components$2f$SettingsTab$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/components/SettingsTab.tsx [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$components$2f$TracingTab$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/components/TracingTab.tsx [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$components$2f$mcp$2d$sidebar$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/components/mcp-sidebar.tsx [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$components$2f$ActiveServerSelector$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/components/ActiveServerSelector.tsx [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$components$2f$ui$2f$sidebar$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/components/ui/sidebar.tsx [app-client] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$components$2f$sidebar$2f$theme$2d$switcher$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/components/sidebar/theme-switcher.tsx [app-client] (ecmascript)");
// import { AccountSwitcher } from "@/components/sidebar/account-switcher";
var __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$hooks$2f$use$2d$app$2d$state$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/src/hooks/use-app-state.ts [app-client] (ecmascript)");
;
var _s = __turbopack_context__.k.signature();
"use client";
;
;
;
;
;
;
;
;
;
;
;
;
;
function Home() {
    _s();
    const [activeTab, setActiveTab] = (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$index$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useState"])("servers");
    const { appState, isLoading, connectedServerConfigs, selectedMCPConfig, handleConnect, handleDisconnect, handleReconnect, handleUpdate, setSelectedServer, toggleServerSelection, selectedMCPConfigsMap, setSelectedMultipleServersToAllServers } = (0, __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$hooks$2f$use$2d$app$2d$state$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useAppState"])();
    const handleNavigate = (section)=>{
        setActiveTab(section);
        if (section === "chat") {
            setSelectedMultipleServersToAllServers();
        }
    };
    if (isLoading) {
        return /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
            className: "min-h-screen bg-background flex items-center justify-center",
            children: /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                className: "text-center",
                children: [
                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                        className: "animate-spin rounded-full h-12 w-12 border-b-2 border-primary mx-auto"
                    }, void 0, false, {
                        fileName: "[project]/src/app/page.tsx",
                        lineNumber: 62,
                        columnNumber: 11
                    }, this),
                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("p", {
                        className: "mt-4 text-muted-foreground",
                        children: "Loading..."
                    }, void 0, false, {
                        fileName: "[project]/src/app/page.tsx",
                        lineNumber: 63,
                        columnNumber: 11
                    }, this)
                ]
            }, void 0, true, {
                fileName: "[project]/src/app/page.tsx",
                lineNumber: 61,
                columnNumber: 9
            }, this)
        }, void 0, false, {
            fileName: "[project]/src/app/page.tsx",
            lineNumber: 60,
            columnNumber: 7
        }, this);
    }
    return /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$src$2f$components$2f$ui$2f$sidebar$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__["SidebarProvider"], {
        defaultOpen: true,
        children: [
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$src$2f$components$2f$mcp$2d$sidebar$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__["MCPSidebar"], {
                onNavigate: handleNavigate,
                activeTab: activeTab
            }, void 0, false, {
                fileName: "[project]/src/app/page.tsx",
                lineNumber: 71,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$src$2f$components$2f$ui$2f$sidebar$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__["SidebarInset"], {
                className: "flex flex-col",
                children: [
                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("header", {
                        className: "flex h-12 shrink-0 items-center gap-2 border-b transition-[width,height] ease-linear",
                        children: /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                            className: "flex w-full items-center justify-between px-4 lg:px-6",
                            children: [
                                /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                                    className: "flex items-center gap-1 lg:gap-2",
                                    children: /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$src$2f$components$2f$ui$2f$sidebar$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__["SidebarTrigger"], {
                                        className: "-ml-1"
                                    }, void 0, false, {
                                        fileName: "[project]/src/app/page.tsx",
                                        lineNumber: 76,
                                        columnNumber: 15
                                    }, this)
                                }, void 0, false, {
                                    fileName: "[project]/src/app/page.tsx",
                                    lineNumber: 75,
                                    columnNumber: 13
                                }, this),
                                /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                                    className: "flex items-center gap-2",
                                    children: /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$src$2f$components$2f$sidebar$2f$theme$2d$switcher$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__["ThemeSwitcher"], {}, void 0, false, {
                                        fileName: "[project]/src/app/page.tsx",
                                        lineNumber: 79,
                                        columnNumber: 15
                                    }, this)
                                }, void 0, false, {
                                    fileName: "[project]/src/app/page.tsx",
                                    lineNumber: 78,
                                    columnNumber: 13
                                }, this)
                            ]
                        }, void 0, true, {
                            fileName: "[project]/src/app/page.tsx",
                            lineNumber: 74,
                            columnNumber: 11
                        }, this)
                    }, void 0, false, {
                        fileName: "[project]/src/app/page.tsx",
                        lineNumber: 73,
                        columnNumber: 9
                    }, this),
                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])("div", {
                        className: "flex-1",
                        children: [
                            (activeTab === "tools" || activeTab === "resources" || activeTab === "prompts" || activeTab === "chat") && /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$src$2f$components$2f$ActiveServerSelector$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__["ActiveServerSelector"], {
                                connectedServerConfigs: connectedServerConfigs,
                                selectedServer: appState.selectedServer,
                                onServerChange: setSelectedServer,
                                onConnect: handleConnect,
                                isMultiSelectEnabled: activeTab === "chat",
                                onMultiServerToggle: toggleServerSelection,
                                selectedMultipleServers: appState.selectedMultipleServers
                            }, void 0, false, {
                                fileName: "[project]/src/app/page.tsx",
                                lineNumber: 91,
                                columnNumber: 13
                            }, this),
                            activeTab === "servers" && /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$src$2f$components$2f$ServersTab$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__["ServersTab"], {
                                connectedServerConfigs: connectedServerConfigs,
                                onConnect: handleConnect,
                                onDisconnect: handleDisconnect,
                                onReconnect: handleReconnect,
                                onUpdate: handleUpdate
                            }, void 0, false, {
                                fileName: "[project]/src/app/page.tsx",
                                lineNumber: 104,
                                columnNumber: 13
                            }, this),
                            activeTab === "tools" && /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$src$2f$components$2f$ToolsTab$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__["ToolsTab"], {
                                serverConfig: selectedMCPConfig
                            }, void 0, false, {
                                fileName: "[project]/src/app/page.tsx",
                                lineNumber: 114,
                                columnNumber: 13
                            }, this),
                            activeTab === "resources" && /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$src$2f$components$2f$ResourcesTab$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__["ResourcesTab"], {
                                serverConfig: selectedMCPConfig
                            }, void 0, false, {
                                fileName: "[project]/src/app/page.tsx",
                                lineNumber: 118,
                                columnNumber: 13
                            }, this),
                            activeTab === "prompts" && /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$src$2f$components$2f$PromptsTab$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__["PromptsTab"], {
                                serverConfig: selectedMCPConfig
                            }, void 0, false, {
                                fileName: "[project]/src/app/page.tsx",
                                lineNumber: 122,
                                columnNumber: 13
                            }, this),
                            activeTab === "chat" && /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$src$2f$components$2f$ChatTab$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__["ChatTab"], {
                                serverConfigs: selectedMCPConfigsMap
                            }, void 0, false, {
                                fileName: "[project]/src/app/page.tsx",
                                lineNumber: 126,
                                columnNumber: 13
                            }, this),
                            activeTab === "tracing" && /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$src$2f$components$2f$TracingTab$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__["TracingTab"], {}, void 0, false, {
                                fileName: "[project]/src/app/page.tsx",
                                lineNumber: 129,
                                columnNumber: 39
                            }, this),
                            activeTab === "settings" && /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$project$5d2f$node_modules$2f$next$2f$dist$2f$compiled$2f$react$2f$jsx$2d$dev$2d$runtime$2e$js__$5b$app$2d$client$5d$__$28$ecmascript$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$project$5d2f$src$2f$components$2f$SettingsTab$2e$tsx__$5b$app$2d$client$5d$__$28$ecmascript$29$__["SettingsTab"], {}, void 0, false, {
                                fileName: "[project]/src/app/page.tsx",
                                lineNumber: 131,
                                columnNumber: 40
                            }, this)
                        ]
                    }, void 0, true, {
                        fileName: "[project]/src/app/page.tsx",
                        lineNumber: 85,
                        columnNumber: 9
                    }, this)
                ]
            }, void 0, true, {
                fileName: "[project]/src/app/page.tsx",
                lineNumber: 72,
                columnNumber: 7
            }, this)
        ]
    }, void 0, true, {
        fileName: "[project]/src/app/page.tsx",
        lineNumber: 70,
        columnNumber: 5
    }, this);
}
_s(Home, "8E6GH8gH1srveZtZ2o25Vzp6CBQ=", false, function() {
    return [
        __TURBOPACK__imported__module__$5b$project$5d2f$src$2f$hooks$2f$use$2d$app$2d$state$2e$ts__$5b$app$2d$client$5d$__$28$ecmascript$29$__["useAppState"]
    ];
});
_c = Home;
var _c;
__turbopack_context__.k.register(_c, "Home");
if (typeof globalThis.$RefreshHelpers$ === 'object' && globalThis.$RefreshHelpers !== null) {
    __turbopack_context__.k.registerExports(module, globalThis.$RefreshHelpers$);
}
}}),
}]);

//# sourceMappingURL=src_20262aa7._.js.map