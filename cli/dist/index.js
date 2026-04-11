#!/usr/bin/env node
'use strict';

var commander = require('commander');
var sdk = require('@mcpjam/sdk');
var dns = require('dns/promises');
var fs = require('fs');

function _interopDefault (e) { return e && e.__esModule ? e : { default: e }; }

var dns__default = /*#__PURE__*/_interopDefault(dns);

// ../mcpjam-inspector/server/routes/apps/chatgpt-apps/OpenAIRuntime.bundled.ts
var CHATGPT_APPS_RUNTIME_SCRIPT = '"use strict";\n(() => {\n  // server/routes/apps/chatgpt-apps/OpenAIRuntime.ts\n  var CONFIG_ELEMENT_ID = "openai-runtime-config";\n  var readConfig = () => {\n    try {\n      const el = document.getElementById(CONFIG_ELEMENT_ID);\n      if (!el) {\n        console.error("[OpenAI Widget] Missing runtime config element");\n        return null;\n      }\n      const raw = el.textContent || "{}";\n      return JSON.parse(raw);\n    } catch (err) {\n      console.error("[OpenAI Widget] Failed to parse runtime config", err);\n      return null;\n    }\n  };\n  var clampNumber = (value) => {\n    const n = Number(value);\n    return Number.isFinite(n) ? n : null;\n  };\n  (function bootstrap() {\n    const config = readConfig();\n    if (!config) return;\n    const {\n      toolId,\n      toolName,\n      toolInput,\n      toolOutput,\n      toolResponseMetadata,\n      theme,\n      locale,\n      deviceType,\n      userLocation,\n      maxHeight,\n      capabilities,\n      safeAreaInsets,\n      viewMode = "inline",\n      viewParams = {},\n      useMapPendingCalls = true\n    } = config;\n    const widgetStateKey = `openai-widget-state:${toolName}:${toolId}`;\n    const hostLocale = locale;\n    const hostDeviceType = deviceType;\n    const hostUserLocation = userLocation ?? null;\n    const hostCapabilities = capabilities ?? null;\n    const hostSafeAreaInsets = safeAreaInsets ?? {\n      top: 0,\n      bottom: 0,\n      left: 0,\n      right: 0\n    };\n    try {\n      document.documentElement.lang = hostLocale;\n    } catch (e) {\n    }\n    const detectedTouch = "ontouchstart" in window || navigator.maxTouchPoints > 0;\n    const detectedHover = window.matchMedia("(hover: hover)").matches;\n    const hasTouch = hostCapabilities ? hostCapabilities.touch : detectedTouch;\n    const hasHover = hostCapabilities ? hostCapabilities.hover : detectedHover;\n    const getSubjectId = () => {\n      let subjectId = sessionStorage.getItem("openai_subject_id");\n      if (!subjectId) {\n        subjectId = "anon_" + Math.random().toString(36).substring(2, 15);\n        sessionStorage.setItem("openai_subject_id", subjectId);\n      }\n      return subjectId;\n    };\n    const postResize = /* @__PURE__ */ (() => {\n      let lastHeight = 0;\n      let lastWidth = 0;\n      return (height, width) => {\n        const rh = Number.isFinite(height) && height > 0 ? Math.round(height) : lastHeight;\n        const rw = Number.isFinite(width) && width > 0 ? Math.round(width) : lastWidth;\n        if (rh === lastHeight && rw === lastWidth) return;\n        lastHeight = rh;\n        lastWidth = rw;\n        window.parent.postMessage(\n          { type: "openai:resize", height: rh, width: rw },\n          "*"\n        );\n      };\n    })();\n    const measureHeight = () => {\n      let contentHeight = 0;\n      if (document.body) {\n        const children = document.body.children;\n        for (let i = 0; i < children.length; i++) {\n          const child = children[i];\n          if (child.tagName === "SCRIPT" || child.tagName === "STYLE") continue;\n          const rect = child.getBoundingClientRect();\n          const bottom = rect.top + rect.height + window.scrollY;\n          contentHeight = Math.max(contentHeight, bottom);\n        }\n        const bodyStyle = window.getComputedStyle(document.body);\n        contentHeight += parseFloat(bodyStyle.marginBottom) || 0;\n        contentHeight += parseFloat(bodyStyle.paddingBottom) || 0;\n      }\n      if (contentHeight <= 0) {\n        const docEl = document.documentElement;\n        contentHeight = Math.max(\n          docEl ? docEl.scrollHeight : 0,\n          document.body ? document.body.scrollHeight : 0\n        );\n      }\n      return Math.ceil(contentHeight);\n    };\n    const measureWidth = () => {\n      let contentWidth = 0;\n      if (document.body) {\n        const children = document.body.children;\n        for (let i = 0; i < children.length; i++) {\n          const child = children[i];\n          if (child.tagName === "SCRIPT" || child.tagName === "STYLE") continue;\n          const rect = child.getBoundingClientRect();\n          const right = rect.left + rect.width + window.scrollX;\n          contentWidth = Math.max(contentWidth, right);\n        }\n        const bodyStyle = window.getComputedStyle(document.body);\n        contentWidth += parseFloat(bodyStyle.marginRight) || 0;\n        contentWidth += parseFloat(bodyStyle.paddingRight) || 0;\n      }\n      if (contentWidth <= 0) {\n        const docEl = document.documentElement;\n        contentWidth = Math.max(\n          docEl ? docEl.scrollWidth : 0,\n          document.body ? document.body.scrollWidth : 0\n        );\n      }\n      return Math.ceil(contentWidth);\n    };\n    const measureAndNotify = () => {\n      try {\n        postResize(measureHeight(), measureWidth());\n      } catch (err) {\n        console.error("[OpenAI Widget] Failed to measure dimensions:", err);\n      }\n    };\n    const setupAutoResize = () => {\n      let scheduled = false;\n      const scheduleMeasure = () => {\n        if (scheduled) return;\n        scheduled = true;\n        requestAnimationFrame(() => {\n          scheduled = false;\n          measureAndNotify();\n        });\n      };\n      scheduleMeasure();\n      if (typeof ResizeObserver !== "undefined") {\n        const resizeObserver = new ResizeObserver(scheduleMeasure);\n        resizeObserver.observe(document.documentElement);\n        if (document.body) resizeObserver.observe(document.body);\n      } else {\n        window.addEventListener("resize", scheduleMeasure);\n      }\n      window.addEventListener("load", () => {\n        requestAnimationFrame(measureAndNotify);\n      });\n    };\n    const navigationState = { currentIndex: 0, historyLength: 1 };\n    const withNavigationIndex = (state, index) => {\n      return state && typeof state === "object" ? { ...state, __navIndex: index } : { __navIndex: index };\n    };\n    const notifyNavigationState = () => {\n      const canGoBack = navigationState.currentIndex > 0;\n      const canGoForward = navigationState.currentIndex < navigationState.historyLength - 1;\n      window.parent.postMessage(\n        {\n          type: "openai:navigationStateChanged",\n          toolId,\n          canGoBack,\n          canGoForward,\n          historyLength: navigationState.historyLength,\n          currentIndex: navigationState.currentIndex\n        },\n        "*"\n      );\n    };\n    const originalPushState = history.pushState.bind(history);\n    history.pushState = function pushState(state, title, url) {\n      const nextIndex = navigationState.currentIndex + 1;\n      const stateWithIndex = withNavigationIndex(state, nextIndex);\n      originalPushState(stateWithIndex, title, url);\n      navigationState.currentIndex = nextIndex;\n      navigationState.historyLength = history.length;\n      notifyNavigationState();\n    };\n    const originalReplaceState = history.replaceState.bind(history);\n    history.replaceState = function replaceState(state, title, url) {\n      const stateWithIndex = withNavigationIndex(\n        state,\n        navigationState.currentIndex\n      );\n      originalReplaceState(stateWithIndex, title, url);\n      navigationState.historyLength = history.length;\n      notifyNavigationState();\n    };\n    window.addEventListener("popstate", (event) => {\n      const stateIndex = event.state?.__navIndex ?? navigationState.currentIndex;\n      navigationState.currentIndex = stateIndex;\n      navigationState.historyLength = history.length;\n      notifyNavigationState();\n    });\n    const openaiAPI = {\n      toolInput,\n      toolOutput,\n      toolResponseMetadata: toolResponseMetadata ?? null,\n      displayMode: "inline",\n      theme,\n      locale: hostLocale,\n      maxHeight: maxHeight ?? null,\n      safeArea: { insets: hostSafeAreaInsets },\n      userAgent: {\n        device: { type: hostDeviceType },\n        capabilities: { hover: hasHover, touch: hasTouch }\n      },\n      view: { mode: viewMode, params: viewParams },\n      widgetState: null,\n      ...useMapPendingCalls ? {\n        _pendingCalls: /* @__PURE__ */ new Map(),\n        _pendingCheckoutCalls: /* @__PURE__ */ new Map(),\n        _pendingFileCalls: /* @__PURE__ */ new Map()\n      } : {},\n      _callId: 0,\n      setWidgetState(state) {\n        this.widgetState = state;\n        try {\n          localStorage.setItem(widgetStateKey, JSON.stringify(state));\n        } catch (err) {\n        }\n        window.parent.postMessage(\n          { type: "openai:setWidgetState", toolId, state },\n          "*"\n        );\n      },\n      callTool(toolName2, args = {}) {\n        const callId = ++this._callId;\n        if (useMapPendingCalls) {\n          return new Promise((resolve, reject) => {\n            this._pendingCalls.set(callId, { resolve, reject });\n            window.parent.postMessage(\n              {\n                type: "openai:callTool",\n                toolName: toolName2,\n                args,\n                callId,\n                toolId,\n                _meta: Object.assign(\n                  {\n                    "openai/locale": hostLocale,\n                    "openai/userAgent": navigator.userAgent,\n                    "openai/subject": getSubjectId()\n                  },\n                  hostUserLocation ? { "openai/userLocation": hostUserLocation } : {}\n                )\n              },\n              "*"\n            );\n            setTimeout(() => {\n              if (this._pendingCalls.has(callId)) {\n                this._pendingCalls.delete(callId);\n                reject(new Error("Tool call timeout"));\n              }\n            }, 3e4);\n          });\n        }\n        return new Promise((resolve, reject) => {\n          const handler = (event) => {\n            if (event.data?.type === "openai:callTool:response" && event.data.callId === callId) {\n              window.removeEventListener("message", handler);\n              event.data.error ? reject(new Error(event.data.error)) : resolve(event.data.result);\n            }\n          };\n          window.addEventListener("message", handler);\n          window.parent.postMessage(\n            {\n              type: "openai:callTool",\n              callId,\n              toolName: toolName2,\n              args,\n              toolId,\n              _meta: Object.assign(\n                {\n                  "openai/locale": hostLocale,\n                  "openai/userAgent": navigator.userAgent,\n                  "openai/subject": getSubjectId()\n                },\n                hostUserLocation ? { "openai/userLocation": hostUserLocation } : {}\n              )\n            },\n            "*"\n          );\n          setTimeout(() => {\n            window.removeEventListener("message", handler);\n            reject(new Error("Tool call timeout"));\n          }, 3e4);\n        });\n      },\n      sendFollowUpMessage(opts) {\n        const prompt = typeof opts === "string" ? opts : opts?.prompt || "";\n        window.parent.postMessage(\n          { type: "openai:sendFollowup", message: prompt, toolId },\n          "*"\n        );\n      },\n      sendFollowupTurn(message) {\n        return this.sendFollowUpMessage(\n          typeof message === "string" ? message : message?.prompt || ""\n        );\n      },\n      requestCheckout(session) {\n        const callId = ++this._callId;\n        if (useMapPendingCalls) {\n          return new Promise((resolve, reject) => {\n            this._pendingCheckoutCalls.set(callId, { resolve, reject });\n            window.parent.postMessage(\n              { type: "openai:requestCheckout", toolId, callId, session },\n              "*"\n            );\n            setTimeout(() => {\n              if (this._pendingCheckoutCalls.has(callId)) {\n                this._pendingCheckoutCalls.delete(callId);\n                reject(new Error("Checkout timeout"));\n              }\n            }, 3e4);\n          });\n        }\n        return new Promise((resolve, reject) => {\n          const handler = (event) => {\n            if (event.data?.type === "openai:requestCheckout:response" && event.data.callId === callId) {\n              window.removeEventListener("message", handler);\n              event.data.error ? reject(new Error(event.data.error)) : resolve(event.data.result);\n            }\n          };\n          window.addEventListener("message", handler);\n          window.parent.postMessage(\n            { type: "openai:requestCheckout", callId, session, toolId },\n            "*"\n          );\n          setTimeout(() => {\n            window.removeEventListener("message", handler);\n            reject(new Error("Checkout timeout"));\n          }, 3e4);\n        });\n      },\n      uploadFile(file) {\n        const ALLOWED_TYPES = ["image/png", "image/jpeg", "image/webp"];\n        const MAX_SIZE = 20 * 1024 * 1024;\n        if (!(file instanceof File)) {\n          return Promise.reject(new Error("uploadFile requires a File object"));\n        }\n        if (!ALLOWED_TYPES.includes(file.type)) {\n          return Promise.reject(\n            new Error(\n              `Unsupported file type: ${file.type}. Allowed: ${ALLOWED_TYPES.join(", ")}`\n            )\n          );\n        }\n        if (file.size > MAX_SIZE) {\n          return Promise.reject(\n            new Error(\n              `File too large. Maximum size: ${MAX_SIZE / 1024 / 1024}MB`\n            )\n          );\n        }\n        const callId = ++this._callId;\n        return new Promise((resolve, reject) => {\n          if (useMapPendingCalls) {\n            this._pendingFileCalls.set(callId, { resolve, reject });\n          }\n          const reader = new FileReader();\n          reader.onload = () => {\n            const dataUrl = reader.result;\n            const base64 = dataUrl.split(",")[1];\n            window.parent.postMessage(\n              {\n                type: "openai:uploadFile",\n                callId,\n                toolId,\n                data: base64,\n                mimeType: file.type,\n                fileName: file.name\n              },\n              "*"\n            );\n          };\n          reader.onerror = () => {\n            if (useMapPendingCalls) this._pendingFileCalls.delete(callId);\n            reject(new Error("Failed to read file"));\n          };\n          reader.readAsDataURL(file);\n          if (useMapPendingCalls) {\n            setTimeout(() => {\n              if (this._pendingFileCalls.has(callId)) {\n                this._pendingFileCalls.delete(callId);\n                reject(new Error("Upload timeout"));\n              }\n            }, 6e4);\n          } else {\n            const handler = (event) => {\n              if (event.data?.type === "openai:uploadFile:response" && event.data.callId === callId) {\n                window.removeEventListener("message", handler);\n                event.data.error ? reject(new Error(event.data.error)) : resolve(event.data.result);\n              }\n            };\n            window.addEventListener("message", handler);\n            setTimeout(() => {\n              window.removeEventListener("message", handler);\n              reject(new Error("Upload timeout"));\n            }, 6e4);\n          }\n        });\n      },\n      getFileDownloadUrl(options) {\n        if (!options || !options.fileId) {\n          return Promise.reject(new Error("fileId is required"));\n        }\n        const callId = ++this._callId;\n        if (useMapPendingCalls) {\n          return new Promise((resolve, reject) => {\n            this._pendingFileCalls.set(callId, { resolve, reject });\n            window.parent.postMessage(\n              {\n                type: "openai:getFileDownloadUrl",\n                callId,\n                toolId,\n                fileId: options.fileId\n              },\n              "*"\n            );\n            setTimeout(() => {\n              if (this._pendingFileCalls.has(callId)) {\n                this._pendingFileCalls.delete(callId);\n                reject(new Error("getFileDownloadUrl timeout"));\n              }\n            }, 3e4);\n          });\n        }\n        return new Promise((resolve, reject) => {\n          const handler = (event) => {\n            if (event.data?.type === "openai:getFileDownloadUrl:response" && event.data.callId === callId) {\n              window.removeEventListener("message", handler);\n              event.data.error ? reject(new Error(event.data.error)) : resolve(event.data.result);\n            }\n          };\n          window.addEventListener("message", handler);\n          window.parent.postMessage(\n            {\n              type: "openai:getFileDownloadUrl",\n              callId,\n              toolId,\n              fileId: options.fileId\n            },\n            "*"\n          );\n          setTimeout(() => {\n            window.removeEventListener("message", handler);\n            reject(new Error("getFileDownloadUrl timeout"));\n          }, 3e4);\n        });\n      },\n      requestDisplayMode(options = {}) {\n        const mode = options.mode || "inline";\n        this.displayMode = mode;\n        window.parent.postMessage(\n          {\n            type: "openai:requestDisplayMode",\n            mode,\n            maxHeight: options.maxHeight,\n            toolId\n          },\n          "*"\n        );\n        return { mode };\n      },\n      requestClose() {\n        window.parent.postMessage({ type: "openai:requestClose", toolId }, "*");\n      },\n      openExternal(options) {\n        let href;\n        if (typeof options === "string") {\n          console.warn(\n            "[OpenAI SDK] openExternal(string) is deprecated. Use openExternal({ href: string }) instead."\n          );\n          href = options;\n        } else {\n          href = options?.href;\n        }\n        if (!href)\n          throw new Error(\n            \'href is required for openExternal. Usage: openExternal({ href: "https://..." })\'\n          );\n        window.parent.postMessage({ type: "openai:openExternal", href }, "*");\n        window.open(href, "_blank", "noopener,noreferrer");\n      },\n      requestModal(options) {\n        const opts = options || {};\n        window.parent.postMessage(\n          {\n            type: "openai:requestModal",\n            title: opts.title,\n            params: opts.params,\n            anchor: opts.anchor,\n            template: opts.template\n          },\n          "*"\n        );\n      },\n      notifyIntrinsicHeight(height) {\n        postResize(Number(height), measureWidth());\n      },\n      notifyNavigation(direction) {\n        if (direction === "back") {\n          if (navigationState.currentIndex > 0) {\n            navigationState.currentIndex--;\n            history.back();\n          }\n        } else if (direction === "forward") {\n          if (navigationState.currentIndex < navigationState.historyLength - 1) {\n            navigationState.currentIndex++;\n            history.forward();\n          }\n        }\n      }\n    };\n    Object.defineProperty(window, "openai", {\n      value: openaiAPI,\n      writable: false,\n      configurable: false,\n      enumerable: true\n    });\n    Object.defineProperty(window, "webplus", {\n      value: openaiAPI,\n      writable: false,\n      configurable: false,\n      enumerable: true\n    });\n    setTimeout(() => {\n      try {\n        window.dispatchEvent(\n          new CustomEvent("openai:set_globals", {\n            detail: {\n              globals: {\n                displayMode: openaiAPI.displayMode,\n                maxHeight: openaiAPI.maxHeight,\n                theme: openaiAPI.theme,\n                locale: openaiAPI.locale,\n                safeArea: openaiAPI.safeArea,\n                userAgent: openaiAPI.userAgent\n              }\n            }\n          })\n        );\n      } catch (err) {\n        console.error("[OpenAI Widget] Failed to dispatch globals event:", err);\n      }\n    }, 0);\n    setTimeout(() => {\n      try {\n        const stored = localStorage.getItem(widgetStateKey);\n        if (stored && window.openai)\n          window.openai.widgetState = JSON.parse(stored);\n      } catch (err) {\n        console.error("[OpenAI Widget] Failed to restore widget state:", err);\n      }\n    }, 0);\n    window.addEventListener("storage", (event) => {\n      if (event.key === widgetStateKey && event.newValue !== null) {\n        try {\n          const newState = JSON.parse(event.newValue);\n          window.openai.widgetState = newState;\n          window.dispatchEvent(\n            new CustomEvent("openai:set_globals", {\n              detail: { globals: { widgetState: newState } }\n            })\n          );\n        } catch (err) {\n        }\n      }\n    });\n    window.addEventListener("message", (event) => {\n      const { type, callId, result, error, globals } = event.data || {};\n      switch (type) {\n        case "openai:callTool:response": {\n          if (!useMapPendingCalls) break;\n          const pending = window.openai._pendingCalls?.get(callId);\n          if (pending) {\n            window.openai._pendingCalls?.delete(callId);\n            error ? pending.reject(new Error(error)) : pending.resolve(result);\n          }\n          break;\n        }\n        case "openai:requestCheckout:response": {\n          if (!useMapPendingCalls) break;\n          const pending = window.openai._pendingCheckoutCalls?.get(callId);\n          if (pending) {\n            window.openai._pendingCheckoutCalls?.delete(callId);\n            error ? pending.reject(new Error(error)) : pending.resolve(result);\n          }\n          break;\n        }\n        case "openai:uploadFile:response":\n        case "openai:getFileDownloadUrl:response": {\n          if (!useMapPendingCalls) break;\n          const filePending = window.openai._pendingFileCalls?.get(callId);\n          if (filePending) {\n            window.openai._pendingFileCalls?.delete(callId);\n            error ? filePending.reject(new Error(error)) : filePending.resolve(result);\n          }\n          break;\n        }\n        case "openai:set_globals":\n          if (globals) {\n            if (globals.displayMode !== void 0) {\n              window.openai.displayMode = globals.displayMode;\n              if (globals.displayMode === "fullscreen" || globals.displayMode === "pip") {\n                document.documentElement.style.overflow = "auto";\n              } else {\n                document.documentElement.style.overflowX = "hidden";\n                document.documentElement.style.overflowY = "auto";\n              }\n            }\n            if (globals.maxHeight !== void 0)\n              window.openai.maxHeight = globals.maxHeight;\n            if (globals.theme !== void 0) window.openai.theme = globals.theme;\n            if (globals.locale !== void 0)\n              window.openai.locale = globals.locale;\n            if (globals.safeArea !== void 0)\n              window.openai.safeArea = globals.safeArea;\n            if (globals.userAgent !== void 0)\n              window.openai.userAgent = globals.userAgent;\n            if (globals.view !== void 0) window.openai.view = globals.view;\n            if (globals.toolInput !== void 0)\n              window.openai.toolInput = globals.toolInput;\n            if (globals.toolOutput !== void 0)\n              window.openai.toolOutput = globals.toolOutput;\n            if (globals.widgetState !== void 0) {\n              window.openai.widgetState = globals.widgetState;\n              try {\n                localStorage.setItem(\n                  widgetStateKey,\n                  JSON.stringify(globals.widgetState)\n                );\n              } catch (err) {\n              }\n            }\n          }\n          try {\n            window.dispatchEvent(\n              new CustomEvent("openai:set_globals", { detail: { globals } })\n            );\n          } catch (err) {\n          }\n          break;\n        case "openai:requestResize":\n          measureAndNotify();\n          break;\n        case "openai:navigate":\n          if (event.data.toolId === toolId) {\n            if (event.data.direction === "back") {\n              if (navigationState.currentIndex > 0) {\n                navigationState.currentIndex--;\n                history.back();\n              }\n            } else if (event.data.direction === "forward") {\n              if (navigationState.currentIndex < navigationState.historyLength - 1) {\n                navigationState.currentIndex++;\n                history.forward();\n              }\n            }\n          }\n          break;\n      }\n    });\n    window.addEventListener("openai:resize", (event) => {\n      try {\n        const detail = event && typeof event === "object" && "detail" in event ? event.detail || {} : {};\n        const height = typeof detail?.height === "number" ? detail.height : typeof detail?.size?.height === "number" ? detail.size.height : null;\n        if (height != null) {\n          postResize(height, measureWidth());\n        } else {\n          measureAndNotify();\n        }\n      } catch (err) {\n        console.error("[OpenAI Widget] Failed to process resize event:", err);\n      }\n    });\n    setupAutoResize();\n    document.addEventListener("securitypolicyviolation", (e) => {\n      const violation = {\n        type: "openai:csp-violation",\n        toolId,\n        directive: e.violatedDirective,\n        blockedUri: e.blockedURI,\n        sourceFile: e.sourceFile || null,\n        lineNumber: clampNumber(e.lineNumber),\n        columnNumber: clampNumber(e.columnNumber),\n        originalPolicy: e.originalPolicy,\n        effectiveDirective: e.effectiveDirective,\n        disposition: e.disposition,\n        timestamp: Date.now()\n      };\n      console.warn(\n        "[OpenAI Widget CSP Violation]",\n        violation.directive,\n        ":",\n        violation.blockedUri\n      );\n      window.parent.postMessage(violation, "*");\n    });\n  })();\n})();\n';

// ../mcpjam-inspector/server/utils/widget-helpers.ts
function serializeForInlineScript(value) {
  return JSON.stringify(value ?? null).replace(/</g, "\\u003C").replace(/>/g, "\\u003E").replace(/&/g, "\\u0026").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}
function extractBaseUrl(html) {
  const baseMatch = html.match(/<base\s+href\s*=\s*["']([^"']+)["']\s*\/?>/i);
  if (baseMatch) return baseMatch[1];
  const innerMatch = html.match(/window\.innerBaseUrl\s*=\s*["']([^"']+)["']/);
  if (innerMatch) return innerMatch[1];
  return "";
}
function generateUrlPolyfillScript(baseUrl) {
  if (!baseUrl) return "";
  return `<script>(function(){
var BASE="${baseUrl}";window.__widgetBaseUrl=BASE;var OrigURL=window.URL;
function isRelative(u){return typeof u==="string"&&!u.match(/^[a-z][a-z0-9+.-]*:/i);}
window.URL=function URL(u,b){
var base=b;if(base===void 0||base===null||base==="null"||base==="about:srcdoc"){base=BASE;}
else if(typeof base==="string"&&base.startsWith("null")){base=BASE;}
try{return new OrigURL(u,base);}catch(e){if(isRelative(u)){try{return new OrigURL(u,BASE);}catch(e2){}}throw e;}
};
window.URL.prototype=OrigURL.prototype;window.URL.createObjectURL=OrigURL.createObjectURL;
window.URL.revokeObjectURL=OrigURL.revokeObjectURL;window.URL.canParse=OrigURL.canParse;
})();</script>`;
}
var WIDGET_BASE_CSS = `<style>
html, body {
  margin: 0;
  padding: 0;
  overflow-x: hidden;
  overflow-y: auto;
}
</style>`;
var CONFIG_SCRIPT_ID = "openai-runtime-config";
function buildRuntimeConfigScript(config) {
  return `<script type="application/json" id="${CONFIG_SCRIPT_ID}">${serializeForInlineScript(config)}</script>`;
}
function injectScripts(html, headContent) {
  if (/<html[^>]*>/i.test(html) && /<head[^>]*>/i.test(html)) {
    return html.replace(/<head[^>]*>/i, `$&${headContent}`);
  }
  return `<!DOCTYPE html><html><head>${headContent}<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head><body>${html}</body></html>`;
}
var LOCALHOST_SOURCES = [
  "http://localhost:*",
  "http://127.0.0.1:*",
  "https://localhost:*",
  "https://127.0.0.1:*"
];
var WS_SOURCES = [
  "ws://localhost:*",
  "ws://127.0.0.1:*",
  "wss://localhost:*"
];
function buildCspHeader(mode, widgetCsp, options) {
  let connectDomains;
  let resourceDomains;
  let frameDomains;
  if (mode === "widget-declared") {
    connectDomains = [
      "'self'",
      ...widgetCsp?.connect_domains || [],
      ...LOCALHOST_SOURCES,
      ...WS_SOURCES
    ];
    resourceDomains = [
      "'self'",
      "data:",
      "blob:",
      ...widgetCsp?.resource_domains || [],
      ...LOCALHOST_SOURCES
    ];
    frameDomains = widgetCsp?.frame_domains && widgetCsp.frame_domains.length > 0 ? widgetCsp.frame_domains : [];
  } else {
    connectDomains = [
      "'self'",
      "https:",
      "wss:",
      "ws:",
      ...LOCALHOST_SOURCES,
      ...WS_SOURCES
    ];
    resourceDomains = [
      "'self'",
      "data:",
      "blob:",
      "https:",
      ...LOCALHOST_SOURCES
    ];
    frameDomains = ["*", "data:", "blob:", "https:", "http:", "about:"];
  }
  const connectSrc = connectDomains.join(" ");
  const resourceSrc = resourceDomains.join(" ");
  const imgSrc = mode === "widget-declared" ? `'self' data: blob: ${(widgetCsp?.resource_domains || []).join(" ")} ${LOCALHOST_SOURCES.join(" ")}` : `'self' data: blob: https: ${LOCALHOST_SOURCES.join(" ")}`;
  const mediaSrc = mode === "widget-declared" ? `'self' data: blob: ${(widgetCsp?.resource_domains || []).join(" ")} ${LOCALHOST_SOURCES.join(" ")}` : "'self' data: blob: https:";
  const frameAncestors = "frame-ancestors 'self' http://localhost:* http://127.0.0.1:* https://localhost:* https://127.0.0.1:*";
  const frameSrc = frameDomains.length > 0 ? `frame-src ${frameDomains.join(" ")}` : "frame-src 'none'";
  const headerString = [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline' 'unsafe-eval' ${resourceSrc}`,
    "worker-src 'self' blob:",
    "child-src 'self' blob:",
    `style-src 'self' 'unsafe-inline' ${resourceSrc}`,
    `img-src ${imgSrc}`,
    `media-src ${mediaSrc}`,
    `font-src 'self' data: ${resourceSrc}`,
    `connect-src ${connectSrc}`,
    frameSrc,
    frameAncestors
  ].join("; ");
  return {
    mode,
    connectDomains,
    resourceDomains,
    frameDomains,
    headerString
  };
}
function buildCspMetaContent(headerString) {
  return headerString.split(";").map((d) => d.trim()).filter(
    (d) => d.length > 0 && !d.startsWith("frame-ancestors") && !d.startsWith("report-uri") && !d.startsWith("sandbox")
  ).join("; ");
}
function buildChatGptRuntimeHead(options) {
  const baseUrl = extractBaseUrl(options.htmlContent);
  return `${WIDGET_BASE_CSS}${generateUrlPolyfillScript(baseUrl)}${baseUrl ? `<base href="${baseUrl}">` : ""}${buildRuntimeConfigScript(options.runtimeConfig)}<script>${CHATGPT_APPS_RUNTIME_SCRIPT}</script>`;
}

// src/lib/output.ts
var DEFAULT_OUTPUT_FORMAT = "json";
var CliError = class extends Error {
  code;
  exitCode;
  details;
  constructor(code, message, exitCode, details) {
    super(message);
    this.name = "CliError";
    this.code = code;
    this.exitCode = exitCode;
    this.details = details;
  }
};
function cliError(code, message, exitCode = 1, details) {
  return new CliError(code, message, exitCode, details);
}
function usageError(message, details) {
  return new CliError("USAGE_ERROR", message, 2, details);
}
function operationalError(message, details) {
  return new CliError("OPERATIONAL_ERROR", message, 1, details);
}
function normalizeCliError(error) {
  if (error instanceof CliError) {
    return error;
  }
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "Unknown error";
  const lower = message.toLowerCase();
  if (lower.includes("timed out") || lower.includes("timeout")) {
    return cliError("TIMEOUT", message);
  }
  if (lower.includes("connect") || lower.includes("connection") || lower.includes("refused") || lower.includes("econn")) {
    return cliError("SERVER_UNREACHABLE", message);
  }
  return cliError("INTERNAL_ERROR", message);
}
function stringify(value, format) {
  return format === "human" ? JSON.stringify(value, null, 2) : JSON.stringify(value);
}
function writeResult(value, format = DEFAULT_OUTPUT_FORMAT) {
  process.stdout.write(`${stringify(value, format)}
`);
}
function toStructuredError(error) {
  if (error instanceof CliError) {
    return {
      error: {
        code: error.code,
        message: error.message,
        ...error.details === void 0 ? {} : { details: error.details }
      }
    };
  }
  if (error instanceof Error) {
    return {
      error: {
        code: "UNEXPECTED_ERROR",
        message: error.message
      }
    };
  }
  return {
    error: {
      code: "UNEXPECTED_ERROR",
      message: typeof error === "string" ? error : "Unknown error"
    }
  };
}
function writeError(error, format = DEFAULT_OUTPUT_FORMAT) {
  const payload = toStructuredError(error);
  process.stderr.write(`${stringify(payload, format)}
`);
  return payload;
}
function parseOutputFormat(value) {
  if (value === "json" || value === "human") {
    return value;
  }
  throw usageError(`Invalid output format "${value}". Use "json" or "human".`);
}
function detectOutputFormatFromArgv(argv) {
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--format") {
      return parseLooseOutputFormat(argv[index + 1]);
    }
    if (token.startsWith("--format=")) {
      return parseLooseOutputFormat(token.slice("--format=".length));
    }
  }
  return DEFAULT_OUTPUT_FORMAT;
}
function parseLooseOutputFormat(value) {
  return value === "human" ? "human" : DEFAULT_OUTPUT_FORMAT;
}
function setProcessExitCode(code) {
  process.exitCode = code;
}

// src/lib/apps.ts
async function buildMcpWidgetContent(manager, serverId, options) {
  if (options.template && !options.template.startsWith("ui://")) {
    throw cliError(
      "VALIDATION_ERROR",
      "Template must use ui:// protocol"
    );
  }
  const resolvedResourceUri = options.template || options.resourceUri;
  const effectiveCspMode = options.cspMode ?? "permissive";
  const resourceResult = await manager.readResource(serverId, {
    uri: resolvedResourceUri
  });
  const contents = Array.isArray(resourceResult?.contents) ? resourceResult.contents : [];
  const content = contents[0];
  if (!content) {
    throw cliError("NOT_FOUND", "No content in resource");
  }
  const contentMimeType = content.mimeType;
  const mimeTypeValid = contentMimeType === sdk.MCP_UI_RESOURCE_MIME_TYPE;
  const mimeTypeWarning = !mimeTypeValid ? contentMimeType ? `Invalid mimetype "${contentMimeType}" - SEP-1865 requires "${sdk.MCP_UI_RESOURCE_MIME_TYPE}"` : `Missing mimetype - SEP-1865 requires "${sdk.MCP_UI_RESOURCE_MIME_TYPE}"` : null;
  let html = extractHtmlFromResourceContent(content);
  if (!html) {
    throw cliError("NOT_FOUND", "No HTML content in resource");
  }
  const uiMeta = content._meta?.ui;
  html = sdk.injectOpenAICompat(html, {
    toolId: options.toolId,
    toolName: options.toolName,
    toolInput: options.toolInput ?? {},
    toolOutput: options.toolOutput,
    theme: options.theme,
    viewMode: options.viewMode,
    viewParams: options.viewParams
  });
  return {
    html,
    csp: effectiveCspMode === "permissive" ? void 0 : uiMeta?.csp,
    permissions: uiMeta?.permissions,
    permissive: effectiveCspMode === "permissive",
    cspMode: effectiveCspMode,
    prefersBorder: uiMeta?.prefersBorder,
    mimeType: contentMimeType,
    mimeTypeValid,
    mimeTypeWarning
  };
}
async function buildChatGptWidgetContent(manager, serverId, options) {
  const content = await manager.readResource(serverId, { uri: options.uri });
  const contentsArray = Array.isArray(content?.contents) ? content.contents : [];
  const firstContent = contentsArray[0];
  if (!firstContent) {
    throw cliError("NOT_FOUND", "No HTML content found");
  }
  const htmlContent = extractHtmlFromResourceContent(firstContent);
  if (!htmlContent) {
    throw cliError("NOT_FOUND", "No HTML content found");
  }
  const resourceMeta = firstContent?._meta;
  const widgetCspRaw = resourceMeta?.["openai/widgetCSP"];
  const effectiveCspMode = options.cspMode ?? "permissive";
  const cspConfig = buildCspHeader(effectiveCspMode, widgetCspRaw);
  const runtimeHeadContent = buildChatGptRuntimeHead({
    htmlContent,
    runtimeConfig: {
      toolId: options.toolId,
      toolName: options.toolName,
      toolInput: options.toolInput ?? {},
      toolOutput: options.toolOutput ?? null,
      toolResponseMetadata: options.toolResponseMetadata ?? null,
      theme: options.theme ?? "dark",
      locale: options.locale ?? "en-US",
      deviceType: options.deviceType ?? "desktop",
      viewMode: "inline",
      viewParams: {},
      useMapPendingCalls: true
    }
  });
  let cspMetaTag = "";
  if (cspConfig.headerString) {
    const metaCspContent = buildCspMetaContent(cspConfig.headerString);
    cspMetaTag = `<meta http-equiv="Content-Security-Policy" content="${metaCspContent.replace(/"/g, "&quot;")}">`;
  }
  return {
    html: injectScripts(htmlContent, cspMetaTag + runtimeHeadContent),
    csp: {
      mode: cspConfig.mode,
      connectDomains: cspConfig.connectDomains,
      resourceDomains: cspConfig.resourceDomains,
      frameDomains: cspConfig.frameDomains,
      headerString: cspConfig.headerString,
      widgetDeclared: widgetCspRaw ?? null
    },
    widgetDescription: resourceMeta?.["openai/widgetDescription"],
    prefersBorder: resourceMeta?.["openai/widgetPrefersBorder"] ?? true,
    closeWidget: resourceMeta?.["openai/closeWidget"] ?? false
  };
}
function extractHtmlFromResourceContent(content) {
  if (!content || typeof content !== "object") {
    return "";
  }
  const record = content;
  if (typeof record.text === "string") {
    return record.text;
  }
  if (typeof record.blob === "string") {
    return Buffer.from(record.blob, "base64").toString("utf-8");
  }
  return "";
}
async function withEphemeralManager(config, fn, options) {
  const manager = new sdk.MCPClientManager(
    {},
    {
      defaultTimeout: options?.timeout ?? 3e4,
      defaultClientName: "mcpjam",
      lazyConnect: true,
      ...options?.rpcLogger ? { rpcLogger: options.rpcLogger } : {}
    }
  );
  const serverId = "__cli__";
  try {
    await manager.connectToServer(serverId, config);
    return await fn(manager, serverId);
  } finally {
    try {
      await manager.disconnectAllServers();
    } catch {
    }
  }
}
async function withEphemeralManagers(servers, fn, options) {
  const manager = new sdk.MCPClientManager(
    {},
    {
      defaultTimeout: options?.timeout ?? 3e4,
      defaultClientName: "mcpjam",
      lazyConnect: true,
      ...options?.rpcLogger ? { rpcLogger: options.rpcLogger } : {}
    }
  );
  const connectionErrors = {};
  try {
    await Promise.all(
      Object.entries(servers).map(async ([serverId, config]) => {
        try {
          await manager.connectToServer(serverId, config);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          connectionErrors[serverId] = message;
          if (!options?.continueOnConnectError) ;
        }
      })
    );
    return await fn(manager, connectionErrors);
  } finally {
    try {
      await manager.disconnectAllServers();
    } catch {
    }
  }
}

// src/lib/rpc-logs.ts
var CliRpcLogCollector = class {
  constructor(serverNamesById) {
    this.serverNamesById = serverNamesById;
  }
  serverNamesById;
  logs = [];
  rpcLogger = ({ direction, message, serverId }) => {
    this.logs.push({
      serverId,
      serverName: this.serverNamesById[serverId] ?? serverId,
      direction,
      timestamp: (/* @__PURE__ */ new Date()).toISOString(),
      message
    });
  };
  hasLogs() {
    return this.logs.length > 0;
  }
  getLogs() {
    return this.logs.map((event) => ({ ...event }));
  }
};
function createCliRpcLogCollector(serverNamesById) {
  return new CliRpcLogCollector(serverNamesById);
}
function attachCliRpcLogs(payload, collector) {
  if (!collector?.hasLogs() || !payload || typeof payload !== "object" || Array.isArray(payload)) {
    return payload;
  }
  return {
    ...payload,
    _rpcLogs: collector.getLogs()
  };
}

// src/lib/server-config.ts
function collectString(value, previous = []) {
  return [...previous, value];
}
function addSharedServerOptions(command) {
  return command.option("--url <url>", "HTTP MCP server URL").option("--access-token <token>", "Bearer access token for HTTP servers").option(
    "--oauth-access-token <token>",
    "OAuth bearer access token for HTTP servers"
  ).option(
    "--refresh-token <token>",
    "OAuth refresh token for HTTP servers"
  ).option(
    "--client-id <id>",
    "OAuth client ID used with --refresh-token"
  ).option(
    "--client-secret <secret>",
    "OAuth client secret used with --refresh-token"
  ).option(
    "--header <header>",
    'HTTP header in "Key: Value" format. Repeat to send multiple headers.',
    collectString,
    []
  ).option(
    "--client-capabilities <json>",
    "Client capabilities advertised to the server as a JSON object"
  ).option("--command <command>", "Command for a stdio MCP server").option(
    "--command-args <arg>",
    "Stdio command argument. Repeat to pass multiple arguments.",
    collectString
  ).option(
    "--env <env>",
    'Stdio environment assignment in "KEY=VALUE" format. Repeat to pass multiple assignments.',
    collectString
  );
}
function getGlobalOptions(command) {
  const options = command.optsWithGlobals();
  return {
    format: parseOutputFormat(options.format ?? "json"),
    timeout: options.timeout ?? 3e4,
    rpc: options.rpc ?? false
  };
}
function parsePositiveInteger(value, label = "Value") {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw usageError(`${label} must be a positive integer.`);
  }
  return parsed;
}
function parseHeadersOption(headers) {
  if (!headers || headers.length === 0) {
    return void 0;
  }
  return Object.fromEntries(headers.map(parseHeader));
}
function parseJsonRecord(value, label) {
  if (value === void 0) {
    return void 0;
  }
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw usageError(`${label} must be valid JSON.`, {
      source: error instanceof Error ? error.message : String(error)
    });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw usageError(`${label} must be a JSON object.`);
  }
  return parsed;
}
function parseUnknownRecord(value, label) {
  if (value === void 0) {
    return void 0;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw usageError(`${label} must be a JSON object.`);
  }
  return value;
}
function parsePromptArguments(value) {
  const raw = parseJsonRecord(value, "Prompt arguments");
  if (!raw) {
    return void 0;
  }
  return Object.fromEntries(
    Object.entries(raw).map(([key, entryValue]) => [key, String(entryValue)])
  );
}
function parseServerConfig(options) {
  const url = options.url?.trim();
  const command = options.command?.trim();
  const hasUrl = Boolean(url);
  const hasCommand = Boolean(command);
  const clientCapabilities = resolveClientCapabilities(
    options.clientCapabilities
  );
  if (hasUrl === hasCommand) {
    throw usageError("Specify exactly one target: either --url or --command.");
  }
  if (hasUrl && url) {
    if ((options.commandArgs?.length ?? 0) > 0 || (options.env?.length ?? 0) > 0) {
      throw usageError(
        "--command-args and --env can only be used together with --command."
      );
    }
    try {
      new URL(url);
    } catch {
      throw usageError(`Invalid URL: ${url}`);
    }
    const headers = parseHeadersOption(options.header);
    const accessToken = resolveHttpAccessToken(options);
    const refreshToken = options.refreshToken?.trim();
    const clientId = options.clientId?.trim();
    const clientSecret = options.clientSecret?.trim();
    if (refreshToken && accessToken) {
      throw usageError(
        "--refresh-token cannot be used together with --access-token or --oauth-access-token."
      );
    }
    if (refreshToken && !clientId) {
      throw usageError("--client-id is required when --refresh-token is used.");
    }
    if (!refreshToken && (clientId || clientSecret)) {
      throw usageError(
        "--client-id and --client-secret can only be used together with --refresh-token."
      );
    }
    return {
      url,
      ...accessToken ? { accessToken } : {},
      ...refreshToken ? { refreshToken } : {},
      ...clientId ? { clientId } : {},
      ...clientSecret ? { clientSecret } : {},
      ...clientCapabilities ? { clientCapabilities } : {},
      requestInit: headers ? { headers } : void 0,
      timeout: options.timeout
    };
  }
  if (!command) {
    throw usageError("Missing stdio command.");
  }
  if (options.accessToken || options.oauthAccessToken || options.refreshToken || options.clientId || options.clientSecret || (options.header?.length ?? 0) > 0) {
    throw usageError(
      "--access-token, --oauth-access-token, --refresh-token, --client-id, --client-secret, and --header can only be used together with --url."
    );
  }
  return {
    command,
    args: parseCommandArgs(options.commandArgs),
    env: parseEnvironmentOption(options.env),
    ...clientCapabilities ? { clientCapabilities } : {},
    stderr: "ignore",
    timeout: options.timeout
  };
}
function addGlobalOptions(program) {
  return program.option(
    "--timeout <ms>",
    "Request timeout in milliseconds",
    (value) => parsePositiveInteger(value, "Timeout"),
    3e4
  ).option("--rpc", "Include RPC logs in JSON output").option("--format <format>", "Output format");
}
function parseServerTargets(value) {
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw usageError("Servers must be valid JSON.", {
      source: error instanceof Error ? error.message : String(error)
    });
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw usageError("Servers must be a non-empty JSON array.");
  }
  const targets = parsed.map(
    (entry, index) => parseServerTargetEntry(entry, index)
  );
  const seenIds = /* @__PURE__ */ new Set();
  for (const target of targets) {
    if (seenIds.has(target.id)) {
      throw usageError(`Duplicate server id "${target.id}" in --servers.`);
    }
    seenIds.add(target.id);
  }
  return targets;
}
function describeTarget(options) {
  return options.url?.trim() || options.command?.trim() || "__cli__";
}
function parseHeader(entry) {
  const separatorIndex = entry.indexOf(":");
  if (separatorIndex <= 0) {
    throw usageError(
      `Invalid header "${entry}". Expected the format "Key: Value".`
    );
  }
  const key = entry.slice(0, separatorIndex).trim();
  const value = entry.slice(separatorIndex + 1).trim();
  if (!key) {
    throw usageError(`Invalid header "${entry}". Header name is required.`);
  }
  return [key, value];
}
function parseCommandArgs(values) {
  if (!values || values.length === 0) {
    return void 0;
  }
  return values;
}
function parseEnvironmentOption(values) {
  if (!values || values.length === 0) {
    return void 0;
  }
  return Object.fromEntries(
    values.map((entry) => {
      const separatorIndex = entry.indexOf("=");
      if (separatorIndex <= 0) {
        throw usageError(
          `Invalid env assignment "${entry}". Expected KEY=VALUE.`
        );
      }
      const key = entry.slice(0, separatorIndex).trim();
      const envValue = entry.slice(separatorIndex + 1);
      if (!key) {
        throw usageError(
          `Invalid env assignment "${entry}". Environment key is required.`
        );
      }
      return [key, envValue];
    })
  );
}
function parseServerTargetEntry(value, index) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw usageError(`Server entry ${index + 1} must be an object.`);
  }
  const record = value;
  const idValue = record.id ?? record.serverId;
  if (typeof idValue !== "string" || idValue.trim().length === 0) {
    throw usageError(`Server entry ${index + 1} is missing a non-empty "id".`);
  }
  const headerEntries = Array.isArray(record.header) && record.header.every((item) => typeof item === "string") ? record.header : record.headers ? recordToHeaderEntries(parseUnknownRecord(record.headers, "headers")) : void 0;
  const envEntries = Array.isArray(record.env) ? coerceStringArray(record.env, "env") : record.env ? recordToEnvEntries(parseUnknownRecord(record.env, "env")) : void 0;
  const timeout = typeof record.timeout === "number" ? record.timeout : typeof record.timeout === "string" ? parsePositiveInteger(record.timeout, "Server timeout") : void 0;
  const config = parseServerConfig({
    url: readOptionalString(record.url),
    accessToken: readOptionalString(record.accessToken),
    oauthAccessToken: readOptionalString(record.oauthAccessToken),
    refreshToken: readOptionalString(record.refreshToken),
    clientId: readOptionalString(record.clientId),
    clientSecret: readOptionalString(record.clientSecret),
    header: headerEntries,
    clientCapabilities: parseUnknownRecord(
      record.clientCapabilities,
      "clientCapabilities"
    ),
    command: readOptionalString(record.command),
    commandArgs: Array.isArray(record.commandArgs) ? coerceStringArray(record.commandArgs, "commandArgs") : Array.isArray(record.args) ? coerceStringArray(record.args, "args") : void 0,
    env: envEntries,
    timeout
  });
  const name = readOptionalString(record.name);
  return {
    id: idValue.trim(),
    ...name ? { name } : {},
    config
  };
}
function resolveClientCapabilities(value) {
  if (value === void 0) {
    return void 0;
  }
  if (typeof value === "string") {
    return parseJsonRecord(value, "Client capabilities");
  }
  return parseUnknownRecord(value, "Client capabilities");
}
function resolveHttpAccessToken(options) {
  const accessToken = options.accessToken?.trim();
  const oauthAccessToken = options.oauthAccessToken?.trim();
  if (accessToken && oauthAccessToken && accessToken !== oauthAccessToken) {
    throw usageError(
      "--access-token and --oauth-access-token must match when both are provided."
    );
  }
  return accessToken ?? oauthAccessToken;
}
function readOptionalString(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : void 0;
}
function coerceStringArray(values, label) {
  if (values.some((entry) => typeof entry !== "string")) {
    throw usageError(`${label} must be an array of strings.`);
  }
  return values;
}
function recordToHeaderEntries(value) {
  if (!value) {
    return void 0;
  }
  return Object.entries(value).map(([key, entryValue]) => {
    if (typeof entryValue !== "string") {
      throw usageError("headers values must be strings.");
    }
    return `${key}: ${entryValue}`;
  });
}
function recordToEnvEntries(value) {
  if (!value) {
    return void 0;
  }
  return Object.entries(value).map(([key, entryValue]) => {
    if (typeof entryValue !== "string") {
      throw usageError("env values must be strings.");
    }
    return `${key}=${entryValue}`;
  });
}

// src/commands/apps.ts
function registerAppsCommands(program) {
  const apps = program.command("apps").description("Fetch MCP App and ChatGPT App widget content");
  addSharedServerOptions(
    apps.command("mcp-widget").description("Fetch hosted-style MCP App widget content").requiredOption("--resource-uri <uri>", "Widget resource URI").requiredOption("--tool-id <id>", "Tool call id used for runtime injection").requiredOption("--tool-name <name>", "Tool name used for runtime injection").option("--tool-input <json>", "Tool input payload as JSON").option("--tool-output <json>", "Tool output payload as JSON").option("--theme <theme>", "Widget theme: light or dark").option(
      "--csp-mode <mode>",
      "CSP mode: permissive or widget-declared"
    ).option("--template <uri>", "Optional ui:// template override").option("--view-mode <mode>", "Widget view mode").option("--view-params <json>", "Widget view params as JSON")
  ).action(async (options, command) => {
    const globalOptions = getGlobalOptions(command);
    const target = describeTarget(options);
    const collector = globalOptions.rpc ? createCliRpcLogCollector({ __cli__: target }) : void 0;
    const config = parseServerConfig({
      ...options,
      timeout: globalOptions.timeout
    });
    const result = await withEphemeralManager(
      config,
      (manager, serverId) => buildMcpWidgetContent(manager, serverId, {
        resourceUri: options.resourceUri,
        toolId: options.toolId,
        toolName: options.toolName,
        toolInput: parseJsonRecord(options.toolInput, "Tool input") ?? {},
        toolOutput: parseJsonValue(options.toolOutput),
        theme: parseTheme(options.theme),
        cspMode: parseCspMode(options.cspMode),
        template: options.template,
        viewMode: options.viewMode,
        viewParams: parseJsonRecord(options.viewParams, "View params")
      }),
      {
        timeout: globalOptions.timeout,
        rpcLogger: collector?.rpcLogger
      }
    );
    writeResult(withRpcLogsIfRequested(result, collector, globalOptions), globalOptions.format);
  });
  addSharedServerOptions(
    apps.command("chatgpt-widget").description("Fetch hosted-style ChatGPT App widget content").requiredOption("--uri <uri>", "Widget resource URI").requiredOption("--tool-id <id>", "Tool call id used for runtime injection").requiredOption("--tool-name <name>", "Tool name used for runtime injection").option("--tool-input <json>", "Tool input payload as JSON").option("--tool-output <json>", "Tool output payload as JSON").option(
      "--tool-response-metadata <json>",
      "Tool response metadata as a JSON object"
    ).option("--theme <theme>", "Widget theme: light or dark").option(
      "--csp-mode <mode>",
      "CSP mode: permissive or widget-declared"
    ).option("--locale <locale>", "Locale override").option("--device-type <type>", "Device type: mobile, tablet, or desktop")
  ).action(async (options, command) => {
    const globalOptions = getGlobalOptions(command);
    const target = describeTarget(options);
    const collector = globalOptions.rpc ? createCliRpcLogCollector({ __cli__: target }) : void 0;
    const config = parseServerConfig({
      ...options,
      timeout: globalOptions.timeout
    });
    const result = await withEphemeralManager(
      config,
      (manager, serverId) => buildChatGptWidgetContent(manager, serverId, {
        uri: options.uri,
        toolId: options.toolId,
        toolName: options.toolName,
        toolInput: parseJsonRecord(options.toolInput, "Tool input") ?? {},
        toolOutput: parseJsonValue(options.toolOutput),
        toolResponseMetadata: parseJsonRecord(
          options.toolResponseMetadata,
          "Tool response metadata"
        ) ?? null,
        theme: parseTheme(options.theme),
        cspMode: parseCspMode(options.cspMode),
        locale: options.locale,
        deviceType: parseDeviceType(options.deviceType)
      }),
      {
        timeout: globalOptions.timeout,
        rpcLogger: collector?.rpcLogger
      }
    );
    writeResult(withRpcLogsIfRequested(result, collector, globalOptions), globalOptions.format);
  });
}
function withRpcLogsIfRequested(value, collector, options) {
  if (!options.rpc || options.format !== "json") {
    return value;
  }
  return attachCliRpcLogs(value, collector);
}
function parseJsonValue(value) {
  if (value === void 0) {
    return void 0;
  }
  try {
    return JSON.parse(value);
  } catch (error) {
    throw usageError("Value must be valid JSON.", {
      source: error instanceof Error ? error.message : String(error)
    });
  }
}
function parseTheme(value) {
  if (value === void 0) {
    return void 0;
  }
  if (value === "light" || value === "dark") {
    return value;
  }
  throw usageError(`Invalid theme "${value}". Use "light" or "dark".`);
}
function parseCspMode(value) {
  if (value === void 0) {
    return void 0;
  }
  if (value === "permissive" || value === "widget-declared") {
    return value;
  }
  throw usageError(
    `Invalid CSP mode "${value}". Use "permissive" or "widget-declared".`
  );
}
function parseDeviceType(value) {
  if (value === void 0) {
    return void 0;
  }
  if (value === "mobile" || value === "tablet" || value === "desktop") {
    return value;
  }
  throw usageError(
    `Invalid device type "${value}". Use "mobile", "tablet", or "desktop".`
  );
}
function registerProtocolCommands(program) {
  const protocol = program.command("protocol").description("MCP protocol inspection and conformance checks");
  protocol.command("conformance").description("Run MCP protocol conformance checks against an HTTP server").requiredOption("--url <url>", "MCP server URL").option("--access-token <token>", "Bearer access token for HTTP servers").option(
    "--header <header>",
    'HTTP header in "Key: Value" format. Repeat to send multiple headers.',
    (value, previous = []) => [...previous, value],
    []
  ).option(
    "--check-timeout <ms>",
    "Per-check timeout in milliseconds",
    (value) => parsePositiveInteger(value, "Check timeout"),
    15e3
  ).option(
    "--category <category>",
    "Check category to run. Repeat for multiple. Default: all.",
    (value, previous = []) => [...previous, value],
    []
  ).option(
    "--check-id <id>",
    "Specific check ID to run. Repeat for multiple. Default: all.",
    (value, previous = []) => [...previous, value],
    []
  ).action(async (options, command) => {
    const format = getFormat(command);
    const config = buildConfig(options);
    const result = await new sdk.MCPConformanceTest(config).run();
    writeResult(result, format);
    if (!result.passed) {
      setProcessExitCode(1);
    }
  });
}
function getFormat(command) {
  const opts = command.optsWithGlobals();
  const value = opts.format ?? "json";
  if (value === "json" || value === "human") {
    return value;
  }
  throw usageError(`Invalid output format "${value}". Use "json" or "human".`);
}
function collectInvalidEntries(values, allowedValues) {
  return (values ?? []).filter((value) => !allowedValues.includes(value));
}
function buildConfig(options) {
  const serverUrl = options.url.trim();
  let parsed;
  try {
    parsed = new URL(serverUrl);
  } catch {
    throw usageError(`Invalid URL: ${serverUrl}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw usageError(`Invalid URL scheme: ${serverUrl}`);
  }
  const customHeaders = parseHeadersOption(options.header);
  const categories = options.category?.filter(Boolean);
  const invalidCategories = collectInvalidEntries(
    categories,
    sdk.MCP_CHECK_CATEGORIES
  );
  if (invalidCategories.length > 0) {
    throw usageError(
      invalidCategories.length === 1 ? `Unknown category: ${invalidCategories[0]}` : `Unknown categories: ${invalidCategories.join(", ")}`
    );
  }
  const checkIds = options.checkId?.filter(Boolean);
  const invalidCheckIds = collectInvalidEntries(checkIds, sdk.MCP_CHECK_IDS);
  if (invalidCheckIds.length > 0) {
    throw usageError(
      `Unknown check id${invalidCheckIds.length === 1 ? "" : "s"}: ${invalidCheckIds.join(", ")}`
    );
  }
  return {
    serverUrl,
    accessToken: options.accessToken,
    customHeaders,
    checkTimeout: options.checkTimeout ?? 15e3,
    ...categories && categories.length > 0 ? { categories } : {},
    ...checkIds && checkIds.length > 0 ? { checkIds } : {}
  };
}
var OAuthProxyError = class extends Error {
  status;
  constructor(status, message) {
    super(message);
    this.status = status;
  }
};
function isPrivateHost(hostname) {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host === "0.0.0.0" || host === "::1" || host === "::") {
    return true;
  }
  if (host.startsWith("127.") || host.startsWith("10.") || host.startsWith("192.168.") || host.startsWith("169.254.")) {
    return true;
  }
  if (host.startsWith("172.")) {
    const second = parseInt(host.split(".")[1], 10);
    if (second >= 16 && second <= 31) {
      return true;
    }
  }
  if (host.includes(":")) {
    if (host.startsWith("fc") || host.startsWith("fd")) {
      return true;
    }
    if (/^fe[89ab][0-9a-f]/i.test(host)) {
      return true;
    }
  }
  return false;
}
async function resolveAndValidateDns(hostname) {
  if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname) || hostname.includes(":")) {
    return null;
  }
  const resolved = [];
  try {
    const ipv4 = await dns__default.default.resolve4(hostname);
    resolved.push(...ipv4);
  } catch {
  }
  try {
    const ipv6 = await dns__default.default.resolve6(hostname);
    resolved.push(...ipv6);
  } catch {
  }
  for (const ip of resolved) {
    if (isPrivateHost(ip)) {
      throw new OAuthProxyError(
        400,
        "Hostname resolves to a private/reserved IP address"
      );
    }
  }
  return resolved[0] ?? null;
}
async function validateUrl(url, httpsOnly = false) {
  if (!url) {
    throw new OAuthProxyError(400, "Missing url parameter");
  }
  let targetUrl;
  try {
    targetUrl = new URL(url);
  } catch {
    throw new OAuthProxyError(400, "Invalid URL format");
  }
  if (httpsOnly) {
    if (targetUrl.protocol !== "https:") {
      throw new OAuthProxyError(
        400,
        "Only HTTPS targets are allowed in hosted mode"
      );
    }
    if (isPrivateHost(targetUrl.hostname)) {
      throw new OAuthProxyError(
        400,
        "Private/reserved IP addresses are not allowed"
      );
    }
    await resolveAndValidateDns(targetUrl.hostname);
  } else if (targetUrl.protocol !== "https:" && targetUrl.protocol !== "http:") {
    throw new OAuthProxyError(400, "Invalid protocol");
  }
  return { url: targetUrl };
}
function buildFetchUrl(targetUrl) {
  return targetUrl.toString();
}
async function executeOAuthProxy(req) {
  const { url: targetUrl } = await validateUrl(req.url, req.httpsOnly);
  const method = req.method ?? "GET";
  const customHeaders = req.headers;
  const requestHeaders = {
    "User-Agent": "MCP-Inspector/1.0",
    ...customHeaders
  };
  const contentType = customHeaders?.["Content-Type"] || customHeaders?.["content-type"];
  const isFormUrlEncoded = contentType?.includes(
    "application/x-www-form-urlencoded"
  );
  if (method === "POST" && req.body && !contentType) {
    requestHeaders["Content-Type"] = "application/json";
  }
  const fetchOptions = {
    method,
    headers: requestHeaders,
    // Prevent redirect-based SSRF: don't follow redirects in hosted mode
    redirect: "manual" 
  };
  if (method === "POST" && req.body) {
    if (isFormUrlEncoded && typeof req.body === "object") {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(
        req.body
      )) {
        params.append(key, String(value));
      }
      fetchOptions.body = params.toString();
    } else if (typeof req.body === "string") {
      fetchOptions.body = req.body;
    } else {
      fetchOptions.body = JSON.stringify(req.body);
    }
  }
  const fetchUrl = buildFetchUrl(targetUrl);
  const response = await fetch(fetchUrl, fetchOptions);
  const headers = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  let responseBody = null;
  try {
    responseBody = await response.json();
  } catch {
    try {
      responseBody = await response.text();
    } catch {
      responseBody = null;
    }
  }
  return {
    status: response.status,
    statusText: response.statusText,
    headers,
    body: responseBody
  };
}
async function executeDebugOAuthProxy(req) {
  const { url: targetUrl } = await validateUrl(req.url, req.httpsOnly);
  const method = req.method ?? "GET";
  const customHeaders = req.headers;
  const requestHeaders = {
    "User-Agent": "MCP-Inspector/1.0",
    ...customHeaders
  };
  const contentType = customHeaders?.["Content-Type"] || customHeaders?.["content-type"];
  const isFormUrlEncoded = contentType?.includes(
    "application/x-www-form-urlencoded"
  );
  if (method === "POST" && req.body && !contentType) {
    requestHeaders["Content-Type"] = "application/json";
  }
  const fetchOptions = {
    method,
    headers: requestHeaders,
    redirect: "manual" 
  };
  if (method === "POST" && req.body) {
    if (isFormUrlEncoded && typeof req.body === "object") {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(
        req.body
      )) {
        params.append(key, String(value));
      }
      fetchOptions.body = params.toString();
    } else if (typeof req.body === "string") {
      fetchOptions.body = req.body;
    } else {
      fetchOptions.body = JSON.stringify(req.body);
    }
  }
  const fetchUrl = buildFetchUrl(targetUrl);
  const response = await fetch(fetchUrl, fetchOptions);
  const headers = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  let responseBody = null;
  const contentTypeHeader = headers["content-type"] || "";
  if (contentTypeHeader.includes("text/event-stream")) {
    try {
      const reader = response.body?.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      const events = [];
      let currentEvent = {};
      const maxReadTime = 5e3;
      const startTime = Date.now();
      if (reader) {
        try {
          while (Date.now() - startTime < maxReadTime) {
            const { done, value } = await Promise.race([
              reader.read(),
              new Promise(
                (_, reject) => setTimeout(() => reject(new Error("Read timeout")), 1e3)
              )
            ]);
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split(/\r?\n/);
            buffer = lines.pop() || "";
            for (const line of lines) {
              if (line.startsWith("event:")) {
                currentEvent.event = line.substring(6).trim();
              } else if (line.startsWith("data:")) {
                const data = line.substring(5).trim();
                try {
                  currentEvent.data = JSON.parse(data);
                } catch {
                  currentEvent.data = data;
                }
              } else if (line.startsWith("id:")) {
                currentEvent.id = line.substring(3).trim();
              } else if (line === "") {
                if (Object.keys(currentEvent).length > 0) {
                  events.push({ ...currentEvent });
                  currentEvent = {};
                  if (events.length >= 1) break;
                }
              }
            }
            if (events.length >= 1) break;
          }
        } finally {
          try {
            await reader.cancel();
          } catch {
          }
        }
      }
      responseBody = {
        transport: "sse",
        events,
        isOldTransport: events[0]?.event === "endpoint",
        endpoint: events[0]?.event === "endpoint" ? events[0].data : null,
        mcpResponse: events.find((e) => e.event === "message" || !e.event)?.data || null,
        rawBuffer: buffer
      };
    } catch (error) {
      responseBody = {
        error: "Failed to parse SSE stream",
        details: error instanceof Error ? error.message : String(error)
      };
    }
  } else {
    try {
      responseBody = await response.json();
    } catch {
      try {
        responseBody = await response.text();
      } catch {
        responseBody = null;
      }
    }
  }
  return {
    status: response.status,
    statusText: response.statusText,
    headers,
    body: responseBody
  };
}
async function fetchOAuthMetadata(url, httpsOnly = false) {
  const { url: metadataUrl } = await validateUrl(url, httpsOnly);
  const requestHeaders = {
    Accept: "application/json",
    "User-Agent": "MCP-Inspector/1.0"
  };
  const fetchUrl = buildFetchUrl(metadataUrl);
  const response = await fetch(fetchUrl, {
    method: "GET",
    headers: requestHeaders,
    redirect: httpsOnly ? "manual" : "follow"
  });
  if (!response.ok) {
    return {
      status: response.status,
      statusText: response.statusText
    };
  }
  const contentType = response.headers.get("content-type");
  if (!contentType?.includes("application/json")) {
    return {
      status: 502,
      statusText: `Upstream returned non-JSON content-type: ${contentType ?? "(none)"}`
    };
  }
  let metadata;
  try {
    metadata = await response.json();
  } catch {
    return {
      status: 502,
      statusText: "Upstream returned invalid JSON body"
    };
  }
  return { metadata };
}

// src/lib/oauth-enums.ts
var VALID_PROTOCOL_VERSIONS = /* @__PURE__ */ new Set([
  "2025-03-26",
  "2025-06-18",
  "2025-11-25"
]);
var VALID_REGISTRATION_STRATEGIES = /* @__PURE__ */ new Set([
  "cimd",
  "dcr",
  "preregistered"
]);
var VALID_AUTH_MODES = /* @__PURE__ */ new Set([
  "headless",
  "interactive",
  "client_credentials"
]);
function assertValidUrl(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw usageError(`${label} is required and must be a non-empty string`);
  }
  try {
    new URL(value);
  } catch {
    throw usageError(`Invalid ${label}: ${value}`);
  }
}
function assertEnum(value, allowed, label) {
  if (typeof value !== "string" || !allowed.has(value)) {
    throw usageError(
      `Invalid ${label} "${String(value)}". Allowed: ${[...allowed].join(", ")}`
    );
  }
}
function validateFlow(flow, defaults, index) {
  const protocolVersion = flow.protocolVersion ?? defaults?.protocolVersion;
  if (!protocolVersion) {
    throw usageError(
      `flows[${index}]: protocolVersion is required (not set in flow or defaults)`
    );
  }
  assertEnum(protocolVersion, VALID_PROTOCOL_VERSIONS, `flows[${index}].protocolVersion`);
  const registrationStrategy = flow.registrationStrategy ?? defaults?.registrationStrategy;
  if (!registrationStrategy) {
    throw usageError(
      `flows[${index}]: registrationStrategy is required (not set in flow or defaults)`
    );
  }
  assertEnum(
    registrationStrategy,
    VALID_REGISTRATION_STRATEGIES,
    `flows[${index}].registrationStrategy`
  );
  const auth = flow.auth ?? defaults?.auth;
  if (auth?.mode) {
    assertEnum(auth.mode, VALID_AUTH_MODES, `flows[${index}].auth.mode`);
  }
}
function loadSuiteConfig(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf-8");
  } catch (error) {
    throw usageError(
      `Cannot read config file "${filePath}": ${error instanceof Error ? error.message : String(error)}`
    );
  }
  let config;
  try {
    config = JSON.parse(raw);
  } catch {
    throw usageError(`Config file "${filePath}" is not valid JSON`);
  }
  if (typeof config !== "object" || config === null || Array.isArray(config)) {
    throw usageError("Config file must be a JSON object");
  }
  assertValidUrl(config.serverUrl, "serverUrl");
  const flows = config.flows;
  if (!Array.isArray(flows) || flows.length === 0) {
    throw usageError('Config file must have a non-empty "flows" array');
  }
  const defaults = config.defaults;
  for (let i = 0; i < flows.length; i++) {
    const flow = flows[i];
    if (typeof flow !== "object" || flow === null || Array.isArray(flow)) {
      throw usageError(`flows[${i}] must be an object`);
    }
    validateFlow(flow, defaults, i);
  }
  return config;
}

// src/lib/junit-xml.ts
function escapeXml(value) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}
function stepToTestCase(step, classname) {
  const name = escapeXml(step.title || step.step);
  const time = (step.durationMs / 1e3).toFixed(3);
  const cls = escapeXml(classname);
  if (step.status === "skipped") {
    return `    <testcase name="${name}" classname="${cls}" time="${time}">
      <skipped/>
    </testcase>`;
  }
  if (step.status === "failed") {
    const message = escapeXml(step.error?.message ?? "Unknown failure");
    const details = step.httpAttempts.map((attempt) => {
      const req = `${attempt.request.method} ${attempt.request.url}`;
      const res = attempt.response ? `${attempt.response.status} ${attempt.response.statusText}` : "No response";
      return `${req} \u2192 ${res}`;
    }).join("\n");
    const body = details ? escapeXml(details) : "";
    return `    <testcase name="${name}" classname="${cls}" time="${time}">
      <failure message="${message}">${body}</failure>
    </testcase>`;
  }
  return `    <testcase name="${name}" classname="${cls}" time="${time}"/>`;
}
function flowToTestSuite(result) {
  const name = escapeXml(result.label);
  const tests = result.steps.length;
  const failures = result.steps.filter((s) => s.status === "failed").length;
  const skipped = result.steps.filter((s) => s.status === "skipped").length;
  const time = (result.durationMs / 1e3).toFixed(3);
  const classname = result.serverUrl;
  const cases = result.steps.map((step) => stepToTestCase(step, classname)).join("\n");
  return `  <testsuite name="${name}" tests="${tests}" failures="${failures}" skipped="${skipped}" time="${time}">
${cases}
  </testsuite>`;
}
function suiteResultToJUnitXml(result) {
  const name = escapeXml(result.name);
  const tests = result.results.reduce((sum, r) => sum + r.steps.length, 0);
  const failures = result.results.reduce(
    (sum, r) => sum + r.steps.filter((s) => s.status === "failed").length,
    0
  );
  const time = (result.durationMs / 1e3).toFixed(3);
  const suites = result.results.map(flowToTestSuite).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="${name}" tests="${tests}" failures="${failures}" time="${time}">
${suites}
</testsuites>
`;
}
function singleResultToJUnitXml(result, label) {
  const suiteResult = {
    name: "OAuth Conformance",
    serverUrl: result.serverUrl,
    passed: result.passed,
    results: [
      {
        ...result,
        label: `${result.protocolVersion}/${result.registrationStrategy}`
      }
    ],
    summary: result.summary,
    durationMs: result.durationMs
  };
  return suiteResultToJUnitXml(suiteResult);
}

// src/lib/oauth-output.ts
function parseOAuthOutputFormat(value) {
  if (value === "json" || value === "human" || value === "junit-xml") {
    return value;
  }
  throw usageError(
    `Invalid output format "${value}". Use "json", "human", or "junit-xml".`
  );
}
function resolveOAuthOutputFormat(value, isTTY) {
  return parseOAuthOutputFormat(value ?? (isTTY ? "human" : "json"));
}
function renderOAuthConformanceResult(result, format) {
  switch (format) {
    case "human":
      return sdk.formatOAuthConformanceHuman(result);
    case "junit-xml":
      return singleResultToJUnitXml(result);
    case "json":
      return JSON.stringify(result);
  }
}
function renderOAuthConformanceSuiteResult(result, format) {
  switch (format) {
    case "human":
      return sdk.formatOAuthConformanceSuiteHuman(result);
    case "junit-xml":
      return suiteResultToJUnitXml(result);
    case "json":
      return JSON.stringify(result);
  }
}

// src/commands/oauth.ts
var DYNAMIC_CLIENT_ID_PLACEHOLDER = "__dynamic_registration_client__";
var DYNAMIC_CLIENT_SECRET_PLACEHOLDER = "__dynamic_registration_secret__";
function getOAuthFormat(command) {
  const opts = command.optsWithGlobals();
  return resolveOAuthOutputFormat(opts.format, process.stdout.isTTY);
}
function getStructuredOAuthFormat(command) {
  const format = getOAuthFormat(command);
  if (format === "junit-xml") {
    throw usageError(
      'The oauth metadata/proxy commands only support --format "json" or "human".'
    );
  }
  return format;
}
function writeOAuthOutput(output) {
  process.stdout.write(output.endsWith("\n") ? output : `${output}
`);
}
function registerOAuthCommands(program) {
  const oauth = program.command("oauth").description("Run MCP OAuth login, proxy, and conformance flows");
  oauth.command("login").description("Run an OAuth login flow against an HTTP MCP server").requiredOption("--url <url>", "MCP server URL").requiredOption(
    "--protocol-version <version>",
    "OAuth protocol version: 2025-03-26, 2025-06-18, or 2025-11-25"
  ).requiredOption(
    "--registration <strategy>",
    "Registration strategy: dcr, preregistered, or cimd"
  ).option(
    "--auth-mode <mode>",
    "Authorization mode: headless, interactive, or client_credentials",
    "interactive"
  ).option(
    "--header <header>",
    'HTTP header in "Key: Value" format. Repeat to send multiple headers.',
    (value, previous = []) => [...previous, value],
    []
  ).option("--client-id <id>", "OAuth client ID").option("--client-secret <secret>", "OAuth client secret").option(
    "--client-metadata-url <url>",
    "Client metadata URL used for CIMD registration"
  ).option("--redirect-url <url>", "OAuth redirect URL to use for the flow").option("--scopes <scopes>", "Space-separated scope string").option(
    "--step-timeout <ms>",
    "Per-step timeout in milliseconds",
    (value) => parsePositiveInteger(value, "Step timeout"),
    3e4
  ).option(
    "--verify-tools",
    "After OAuth succeeds, verify the token by listing MCP tools"
  ).option(
    "--verify-call-tool <name>",
    "After listing tools, also call the named tool"
  ).action(async (options, command) => {
    const format = getStructuredOAuthFormat(command);
    const config = buildOAuthConformanceConfig(
      options,
      {
        defaultAuthMode: "interactive"
      }
    );
    const result = await sdk.runOAuthLogin(config);
    writeResult(result, format);
    if (!result.completed) {
      setProcessExitCode(1);
    }
  });
  oauth.command("conformance").description("Run OAuth conformance against an HTTP MCP server").requiredOption("--url <url>", "MCP server URL").requiredOption(
    "--protocol-version <version>",
    "OAuth protocol version: 2025-03-26, 2025-06-18, or 2025-11-25"
  ).requiredOption(
    "--registration <strategy>",
    "Registration strategy: dcr, preregistered, or cimd"
  ).option(
    "--auth-mode <mode>",
    "Authorization mode: headless, interactive, or client_credentials",
    "headless"
  ).option(
    "--header <header>",
    'HTTP header in "Key: Value" format. Repeat to send multiple headers.',
    (value, previous = []) => [...previous, value],
    []
  ).option("--client-id <id>", "OAuth client ID").option("--client-secret <secret>", "OAuth client secret").option(
    "--client-metadata-url <url>",
    "Client metadata URL used for CIMD registration"
  ).option("--redirect-url <url>", "OAuth redirect URL to use for the flow").option("--scopes <scopes>", "Space-separated scope string").option(
    "--step-timeout <ms>",
    "Per-step timeout in milliseconds",
    (value) => parsePositiveInteger(value, "Step timeout"),
    3e4
  ).option(
    "--verify-tools",
    "After OAuth succeeds, verify the token by listing MCP tools"
  ).option(
    "--verify-call-tool <name>",
    "After listing tools, also call the named tool"
  ).action(async (options, command) => {
    const format = getOAuthFormat(command);
    const config = buildOAuthConformanceConfig(options);
    const result = await new sdk.OAuthConformanceTest(config).run();
    writeOAuthOutput(renderOAuthConformanceResult(result, format));
    if (!result.passed) {
      setProcessExitCode(1);
    }
  });
  oauth.command("conformance-suite").description(
    "Run a matrix of OAuth conformance flows from a JSON config file"
  ).requiredOption("--config <path>", "Path to JSON config file").option(
    "--verify-tools",
    "Enable post-auth tool listing verification on all flows"
  ).option(
    "--verify-call-tool <name>",
    "Also call the named tool after listing"
  ).action(async (options, command) => {
    const format = getOAuthFormat(command);
    const config = loadSuiteConfig(options.config);
    if (options.verifyTools || options.verifyCallTool) {
      const cliVerification = {
        listTools: true,
        ...options.verifyCallTool ? { callTool: { name: options.verifyCallTool } } : {}
      };
      for (const flow of config.flows) {
        flow.verification = { ...flow.verification, ...cliVerification };
      }
      config.defaults = {
        ...config.defaults,
        verification: { ...config.defaults?.verification, ...cliVerification }
      };
    }
    const suite = new sdk.OAuthConformanceSuite(config);
    const result = await suite.run();
    writeOAuthOutput(renderOAuthConformanceSuiteResult(result, format));
    if (!result.passed) {
      setProcessExitCode(1);
    }
  });
  oauth.command("metadata").description("Fetch OAuth metadata from a URL").requiredOption("--url <url>", "OAuth metadata URL").action(async (options, command) => {
    const result = await runOAuthMetadata(options.url);
    writeResult(result, getStructuredOAuthFormat(command));
  });
  oauth.command("proxy").description("Proxy an OAuth request with hosted-mode safety checks").requiredOption("--url <url>", "OAuth request URL").option("--method <method>", "HTTP method", "GET").option(
    "--header <header>",
    'HTTP header in "Key: Value" format. Repeat to send multiple headers.',
    (value, previous = []) => [...previous, value],
    []
  ).option("--body <value>", "Request body as JSON or raw string").action(async (options, command) => {
    const result = await runOAuthProxy(options);
    writeResult(result, getStructuredOAuthFormat(command));
  });
  oauth.command("debug-proxy").description("Proxy an OAuth debug request with hosted-mode safety checks").requiredOption("--url <url>", "OAuth request URL").option("--method <method>", "HTTP method", "GET").option(
    "--header <header>",
    'HTTP header in "Key: Value" format. Repeat to send multiple headers.',
    (value, previous = []) => [...previous, value],
    []
  ).option("--body <value>", "Request body as JSON or raw string").action(async (options, command) => {
    const result = await runOAuthDebugProxy(
      options
    );
    writeResult(result, getStructuredOAuthFormat(command));
  });
}
function buildOAuthConformanceConfig(options, defaults) {
  const serverUrl = options.url.trim();
  assertValidUrl2(serverUrl, "server URL");
  const protocolVersion = parseProtocolVersion(options.protocolVersion);
  const registrationStrategy = parseRegistrationStrategy(options.registration);
  const authMode = parseAuthMode(
    options.authMode ?? defaults?.defaultAuthMode ?? "headless"
  );
  if (protocolVersion !== "2025-11-25" && registrationStrategy === "cimd") {
    throw usageError(
      `CIMD registration is not supported for protocol version ${protocolVersion}.`
    );
  }
  if (authMode === "client_credentials" && registrationStrategy === "cimd") {
    throw usageError(
      "--auth-mode client_credentials cannot be used with --registration cimd. CIMD is a browser-based registration flow and only works with --auth-mode headless or --auth-mode interactive. For client_credentials, use --registration dcr or --registration preregistered instead."
    );
  }
  const clientId = options.clientId?.trim();
  const clientSecret = options.clientSecret;
  const clientMetadataUrl = options.clientMetadataUrl?.trim();
  const redirectUrl = options.redirectUrl?.trim();
  if (registrationStrategy === "preregistered" && !clientId) {
    throw usageError(
      "--client-id is required when --registration preregistered is used."
    );
  }
  if (registrationStrategy === "preregistered" && authMode === "client_credentials" && !clientSecret) {
    throw usageError(
      "--client-secret is required for preregistered client_credentials runs."
    );
  }
  if (clientMetadataUrl) {
    assertValidUrl2(clientMetadataUrl, "client metadata URL");
  }
  if (redirectUrl) {
    assertValidUrl2(redirectUrl, "redirect URL");
  }
  const customHeaders = parseHeadersOption(options.header);
  const client = {};
  if (registrationStrategy === "preregistered" && clientId) {
    client.preregistered = {
      clientId,
      ...clientSecret ? { clientSecret } : {}
    };
  }
  if (clientMetadataUrl) {
    client.clientIdMetadataUrl = clientMetadataUrl;
  }
  const verification = options.verifyTools || options.verifyCallTool ? {
    listTools: options.verifyTools ?? !!options.verifyCallTool,
    ...options.verifyCallTool ? { callTool: { name: options.verifyCallTool } } : {}
  } : void 0;
  return {
    serverUrl,
    protocolVersion,
    registrationStrategy,
    auth: buildAuthConfig(authMode, registrationStrategy, clientId, clientSecret),
    client,
    scopes: options.scopes?.trim() || void 0,
    customHeaders,
    redirectUrl,
    stepTimeout: options.stepTimeout ?? 3e4,
    verification
  };
}
function buildAuthConfig(authMode, registrationStrategy, clientId, clientSecret) {
  switch (authMode) {
    case "headless":
      return { mode: "headless" };
    case "interactive":
      return { mode: "interactive" };
    case "client_credentials":
      return {
        mode: "client_credentials",
        clientId: clientId ?? (registrationStrategy === "dcr" ? DYNAMIC_CLIENT_ID_PLACEHOLDER : ""),
        clientSecret: clientSecret ?? (registrationStrategy === "dcr" ? DYNAMIC_CLIENT_SECRET_PLACEHOLDER : "")
      };
    default:
      throw usageError(`Unsupported auth mode "${authMode}".`);
  }
}
function assertValidUrl2(value, label) {
  try {
    new URL(value);
  } catch {
    throw usageError(`Invalid ${label}: ${value}`);
  }
}
function parseProtocolVersion(value) {
  if (VALID_PROTOCOL_VERSIONS.has(value)) {
    return value;
  }
  throw usageError(
    `Invalid protocol version "${value}". Use ${[...VALID_PROTOCOL_VERSIONS].join(", ")}.`
  );
}
function parseRegistrationStrategy(value) {
  if (VALID_REGISTRATION_STRATEGIES.has(value)) {
    return value;
  }
  throw usageError(
    `Invalid registration strategy "${value}". Use ${[...VALID_REGISTRATION_STRATEGIES].join(", ")}.`
  );
}
function parseAuthMode(value) {
  if (VALID_AUTH_MODES.has(value)) {
    return value;
  }
  throw usageError(
    `Invalid auth mode "${value}". Use ${[...VALID_AUTH_MODES].join(", ")}.`
  );
}
async function runOAuthMetadata(url) {
  try {
    const result = await fetchOAuthMetadata(url, true);
    if ("status" in result && result.status !== void 0) {
      throw cliError(
        statusToErrorCode(result.status),
        `Failed to fetch OAuth metadata: ${result.status} ${result.statusText}`
      );
    }
    return result.metadata;
  } catch (error) {
    throw mapOAuthProxyError(error);
  }
}
async function runOAuthProxy(options) {
  try {
    return await executeOAuthProxy({
      url: options.url,
      method: options.method,
      headers: parseHeadersOption(options.header),
      body: parseProxyBody(options.body),
      httpsOnly: true
    });
  } catch (error) {
    throw mapOAuthProxyError(error);
  }
}
async function runOAuthDebugProxy(options) {
  try {
    return await executeDebugOAuthProxy({
      url: options.url,
      method: options.method,
      headers: parseHeadersOption(options.header),
      body: parseProxyBody(options.body),
      httpsOnly: true
    });
  } catch (error) {
    throw mapOAuthProxyError(error);
  }
}
function parseProxyBody(value) {
  if (value === void 0) {
    return void 0;
  }
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
function mapOAuthProxyError(error) {
  if (error instanceof OAuthProxyError) {
    return cliError(statusToErrorCode(error.status), error.message);
  }
  return error;
}
function statusToErrorCode(status) {
  if (status === 400) return "VALIDATION_ERROR";
  if (status === 401) return "UNAUTHORIZED";
  if (status === 403) return "FORBIDDEN";
  if (status === 404) return "NOT_FOUND";
  if (status === 429) return "RATE_LIMITED";
  if (status === 502) return "SERVER_UNREACHABLE";
  if (status === 504) return "TIMEOUT";
  return "INTERNAL_ERROR";
}
async function listToolsWithMetadata(manager, params) {
  const result = await manager.listTools(
    params.serverId,
    params.cursor ? { cursor: params.cursor } : void 0
  );
  const tools = result.tools ?? [];
  const toolsMetadata = manager.getAllToolsMetadata(params.serverId);
  const tokenCount = params.modelId ? estimateTokensFromChars(JSON.stringify(tools)) : void 0;
  return {
    tools,
    nextCursor: result.nextCursor,
    toolsMetadata,
    ...tokenCount === void 0 ? {} : { tokenCount }
  };
}
async function exportServerSnapshot(manager, serverId, target) {
  const [toolsResult, resourcesResult, promptsResult, resourceTemplatesResult] = await Promise.all([
    manager.listTools(serverId),
    manager.listResources(serverId),
    manager.listPrompts(serverId),
    manager.listResourceTemplates(serverId).catch(() => ({
      resourceTemplates: []
    }))
  ]);
  return {
    target,
    exportedAt: (/* @__PURE__ */ new Date()).toISOString(),
    initInfo: manager.getInitializationInfo(serverId) ?? null,
    capabilities: manager.getServerCapabilities(serverId) ?? null,
    tools: (toolsResult.tools ?? []).map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      outputSchema: tool.outputSchema
    })),
    toolsMetadata: manager.getAllToolsMetadata(serverId),
    resources: (resourcesResult.resources ?? []).map((resource) => ({
      uri: resource.uri,
      name: resource.name,
      description: resource.description,
      mimeType: resource.mimeType
    })),
    resourceTemplates: (resourceTemplatesResult.resourceTemplates ?? []).map(
      (template) => ({
        uriTemplate: template.uriTemplate,
        name: template.name,
        description: template.description,
        mimeType: template.mimeType
      })
    ),
    prompts: (promptsResult.prompts ?? []).map((prompt) => ({
      name: prompt.name,
      description: prompt.description,
      arguments: prompt.arguments
    }))
  };
}
async function listPromptsMulti(manager, serverIds) {
  return sdk.listPromptsMulti(manager, { serverIds });
}
function estimateTokensFromChars(text) {
  return Math.ceil(text.length / 4);
}

// src/commands/prompts.ts
function registerPromptCommands(program) {
  const prompts = program.command("prompts").description("List and fetch MCP prompts");
  addSharedServerOptions(
    prompts.command("list").description("List prompts exposed by an MCP server").option("--cursor <cursor>", "Pagination cursor")
  ).action(async (options, command) => {
    const globalOptions = getGlobalOptions(command);
    const target = describeTarget(options);
    const collector = globalOptions.rpc ? createCliRpcLogCollector({ __cli__: target }) : void 0;
    const config = parseServerConfig({
      ...options,
      timeout: globalOptions.timeout
    });
    const result = await withEphemeralManager(
      config,
      (manager, serverId) => sdk.listPrompts(manager, { serverId, cursor: options.cursor }),
      {
        timeout: globalOptions.timeout,
        rpcLogger: collector?.rpcLogger
      }
    );
    writeResult(withRpcLogsIfRequested2(result, collector, globalOptions), globalOptions.format);
  });
  prompts.command("list-multi").description("List prompts across multiple server targets").requiredOption(
    "--servers <json>",
    "JSON array of server target objects with id plus url or command"
  ).action(async (options, command) => {
    const globalOptions = getGlobalOptions(command);
    const targets = parseServerTargets(options.servers);
    const collector = globalOptions.rpc ? createCliRpcLogCollector(
      Object.fromEntries(
        targets.map((target) => [target.id, target.name ?? target.id])
      )
    ) : void 0;
    const result = await withEphemeralManagers(
      Object.fromEntries(targets.map((target) => [target.id, target.config])),
      async (manager, connectionErrors) => {
        const promptsResult = await listPromptsMulti(
          manager,
          targets.map((target) => target.id)
        );
        const resultErrors = promptsResult.errors ?? {};
        const mergedErrors = {
          ...resultErrors,
          ...connectionErrors
        };
        return {
          prompts: promptsResult.prompts,
          ...Object.keys(mergedErrors).length === 0 ? {} : { errors: mergedErrors }
        };
      },
      {
        timeout: globalOptions.timeout,
        rpcLogger: collector?.rpcLogger,
        continueOnConnectError: true
      }
    );
    writeResult(withRpcLogsIfRequested2(result, collector, globalOptions), globalOptions.format);
  });
  addSharedServerOptions(
    prompts.command("get").description("Get a named prompt from an MCP server").requiredOption("--name <prompt>", "Prompt name").option("--prompt-args <json>", "Prompt arguments as a JSON object")
  ).action(async (options, command) => {
    const globalOptions = getGlobalOptions(command);
    const target = describeTarget(options);
    const collector = globalOptions.rpc ? createCliRpcLogCollector({ __cli__: target }) : void 0;
    const config = parseServerConfig({
      ...options,
      timeout: globalOptions.timeout
    });
    const promptArguments = parsePromptArguments(options.promptArgs);
    const result = await withEphemeralManager(
      config,
      (manager, serverId) => sdk.getPrompt(manager, {
        serverId,
        name: options.name,
        arguments: promptArguments
      }),
      {
        timeout: globalOptions.timeout,
        rpcLogger: collector?.rpcLogger
      }
    );
    writeResult(withRpcLogsIfRequested2(result, collector, globalOptions), globalOptions.format);
  });
}
function withRpcLogsIfRequested2(value, collector, options) {
  if (!options.rpc || options.format !== "json") {
    return value;
  }
  return attachCliRpcLogs(value, collector);
}
function registerResourcesCommands(program) {
  const resources = program.command("resources").description("List and read MCP resources");
  addSharedServerOptions(
    resources.command("list").description("List resources exposed by an MCP server").option("--cursor <cursor>", "Pagination cursor")
  ).action(async (options, command) => {
    const globalOptions = getGlobalOptions(command);
    const target = describeTarget(options);
    const collector = globalOptions.rpc ? createCliRpcLogCollector({ __cli__: target }) : void 0;
    const config = parseServerConfig({
      ...options,
      timeout: globalOptions.timeout
    });
    const result = await withEphemeralManager(
      config,
      (manager, serverId) => sdk.listResources(manager, { serverId, cursor: options.cursor }),
      {
        timeout: globalOptions.timeout,
        rpcLogger: collector?.rpcLogger
      }
    );
    writeResult(withRpcLogsIfRequested3(result, collector, globalOptions), globalOptions.format);
  });
  addSharedServerOptions(
    resources.command("read").description("Read a resource from an MCP server").requiredOption("--uri <uri>", "Resource URI")
  ).action(async (options, command) => {
    const globalOptions = getGlobalOptions(command);
    const target = describeTarget(options);
    const collector = globalOptions.rpc ? createCliRpcLogCollector({ __cli__: target }) : void 0;
    const config = parseServerConfig({
      ...options,
      timeout: globalOptions.timeout
    });
    const result = await withEphemeralManager(
      config,
      (manager, serverId) => sdk.readResource(manager, { serverId, uri: options.uri }),
      {
        timeout: globalOptions.timeout,
        rpcLogger: collector?.rpcLogger
      }
    );
    writeResult(withRpcLogsIfRequested3(result, collector, globalOptions), globalOptions.format);
  });
  addSharedServerOptions(
    resources.command("templates").description("List resource templates exposed by an MCP server").option("--cursor <cursor>", "Pagination cursor")
  ).action(async (options, command) => {
    const globalOptions = getGlobalOptions(command);
    const target = describeTarget(options);
    const collector = globalOptions.rpc ? createCliRpcLogCollector({ __cli__: target }) : void 0;
    const config = parseServerConfig({
      ...options,
      timeout: globalOptions.timeout
    });
    const result = await withEphemeralManager(
      config,
      (manager, serverId) => manager.listResourceTemplates(
        serverId,
        options.cursor ? { cursor: options.cursor } : void 0
      ),
      {
        timeout: globalOptions.timeout,
        rpcLogger: collector?.rpcLogger
      }
    );
    writeResult(withRpcLogsIfRequested3(result, collector, globalOptions), globalOptions.format);
  });
}
function withRpcLogsIfRequested3(value, collector, options) {
  if (!options.rpc || options.format !== "json") {
    return value;
  }
  return attachCliRpcLogs(value, collector);
}
function registerServerCommands(program) {
  const server = program.command("server").description("Inspect MCP server connectivity and capabilities");
  server.command("probe").description("Probe an HTTP MCP server without using the full client connect flow").requiredOption("--url <url>", "HTTP MCP server URL").option("--access-token <token>", "Bearer access token for HTTP servers").option(
    "--oauth-access-token <token>",
    "OAuth bearer access token for HTTP servers"
  ).option(
    "--header <header>",
    'HTTP header in "Key: Value" format. Repeat to send multiple headers.',
    (value, previous = []) => [...previous, value],
    []
  ).option(
    "--client-capabilities <json>",
    "Client capabilities advertised in the initialize probe as a JSON object"
  ).option(
    "--protocol-version <version>",
    "OAuth/MCP protocol version hint used for the initialize probe",
    "2025-11-25"
  ).option(
    "--timeout <ms>",
    "Request timeout in milliseconds",
    (value) => parsePositiveInteger(value, "Timeout")
  ).action(async (options, command) => {
    const globalOptions = getGlobalOptions(command);
    const accessToken = resolveHttpAccessToken(options);
    const protocolVersion = options.protocolVersion;
    if (protocolVersion !== "2025-03-26" && protocolVersion !== "2025-06-18" && protocolVersion !== "2025-11-25") {
      throw usageError(
        `Invalid protocol version "${options.protocolVersion}".`
      );
    }
    const result = await sdk.probeMcpServer({
      url: options.url,
      protocolVersion,
      headers: parseHeadersOption(options.header),
      accessToken,
      clientCapabilities: parseJsonRecord(
        options.clientCapabilities,
        "Client capabilities"
      ),
      timeoutMs: options.timeout ?? globalOptions.timeout
    });
    writeResult(result, globalOptions.format);
    if (result.status === "error") {
      setProcessExitCode(1);
    }
  });
  addSharedServerOptions(
    server.command("info").description("Get initialization info for an MCP server")
  ).action(async (options, command) => {
    const globalOptions = getGlobalOptions(command);
    const target = describeTarget(options);
    const collector = globalOptions.rpc ? createCliRpcLogCollector({ __cli__: target }) : void 0;
    const config = parseServerConfig({
      ...options,
      timeout: globalOptions.timeout
    });
    const result = await withEphemeralManager(
      config,
      async (manager, serverId) => {
        const info = manager.getInitializationInfo(serverId);
        if (!info) {
          throw operationalError(
            "Server connected but did not return initialization info."
          );
        }
        return info;
      },
      {
        timeout: globalOptions.timeout,
        rpcLogger: collector?.rpcLogger
      }
    );
    writeResult(withRpcLogsIfRequested4(result, collector, globalOptions), globalOptions.format);
  });
  addSharedServerOptions(
    server.command("validate").description("Connect to a server and verify the debugger surface works")
  ).action(async (options, command) => {
    const globalOptions = getGlobalOptions(command);
    const target = describeTarget(options);
    const collector = globalOptions.rpc ? createCliRpcLogCollector({ __cli__: target }) : void 0;
    const config = parseServerConfig({
      ...options,
      timeout: globalOptions.timeout
    });
    const result = await withEphemeralManager(
      config,
      async (manager, serverId) => {
        await manager.getToolsForAiSdk([serverId]);
        return {
          success: true,
          status: "connected",
          target,
          initInfo: manager.getInitializationInfo(serverId) ?? null
        };
      },
      {
        timeout: globalOptions.timeout,
        rpcLogger: collector?.rpcLogger
      }
    );
    writeResult(withRpcLogsIfRequested4(result, collector, globalOptions), globalOptions.format);
  });
  addSharedServerOptions(
    server.command("ping").description("Ping an MCP server")
  ).action(async (options, command) => {
    const globalOptions = getGlobalOptions(command);
    const target = describeTarget(options);
    const collector = globalOptions.rpc ? createCliRpcLogCollector({ __cli__: target }) : void 0;
    const config = parseServerConfig({
      ...options,
      timeout: globalOptions.timeout
    });
    const result = await withEphemeralManager(
      config,
      async (manager, serverId) => ({
        target,
        status: "connected",
        result: await manager.pingServer(serverId)
      }),
      {
        timeout: globalOptions.timeout,
        rpcLogger: collector?.rpcLogger
      }
    );
    writeResult(withRpcLogsIfRequested4(result, collector, globalOptions), globalOptions.format);
  });
  addSharedServerOptions(
    server.command("capabilities").description("Get resolved server capabilities")
  ).action(async (options, command) => {
    const globalOptions = getGlobalOptions(command);
    const target = describeTarget(options);
    const collector = globalOptions.rpc ? createCliRpcLogCollector({ __cli__: target }) : void 0;
    const config = parseServerConfig({
      ...options,
      timeout: globalOptions.timeout
    });
    const result = await withEphemeralManager(
      config,
      async (manager, serverId) => ({
        target,
        capabilities: manager.getServerCapabilities(serverId) ?? null
      }),
      {
        timeout: globalOptions.timeout,
        rpcLogger: collector?.rpcLogger
      }
    );
    writeResult(withRpcLogsIfRequested4(result, collector, globalOptions), globalOptions.format);
  });
  addSharedServerOptions(
    server.command("export").description("Export server tools, resources, prompts, and capabilities")
  ).action(async (options, command) => {
    const globalOptions = getGlobalOptions(command);
    const target = describeTarget(options);
    const collector = globalOptions.rpc ? createCliRpcLogCollector({ __cli__: target }) : void 0;
    const config = parseServerConfig({
      ...options,
      timeout: globalOptions.timeout
    });
    const result = await withEphemeralManager(
      config,
      (manager, serverId) => exportServerSnapshot(manager, serverId, target),
      {
        timeout: globalOptions.timeout,
        rpcLogger: collector?.rpcLogger
      }
    );
    writeResult(withRpcLogsIfRequested4(result, collector, globalOptions), globalOptions.format);
  });
}
function withRpcLogsIfRequested4(value, collector, options) {
  if (!options.rpc || options.format !== "json") {
    return value;
  }
  return attachCliRpcLogs(value, collector);
}

// src/commands/tools.ts
function registerToolsCommands(program) {
  const tools = program.command("tools").description("List and invoke MCP server tools");
  addSharedServerOptions(
    tools.command("list").description("List tools exposed by an MCP server").option("--cursor <cursor>", "Pagination cursor").option("--model-id <model>", "Model id used for token counting")
  ).action(async (options, command) => {
    const globalOptions = getGlobalOptions(command);
    const target = describeTarget(options);
    const collector = globalOptions.rpc ? createCliRpcLogCollector({ __cli__: target }) : void 0;
    const config = parseServerConfig({
      ...options,
      timeout: globalOptions.timeout
    });
    const result = await withEphemeralManager(
      config,
      (manager, serverId) => listToolsWithMetadata(manager, {
        serverId,
        cursor: options.cursor,
        modelId: options.modelId
      }),
      {
        timeout: globalOptions.timeout,
        rpcLogger: collector?.rpcLogger
      }
    );
    writeResult(withRpcLogsIfRequested5(result, collector, globalOptions), globalOptions.format);
  });
  addSharedServerOptions(
    tools.command("call").description("Call an MCP tool").requiredOption("--name <tool>", "Tool name").option("--params <json>", "Tool parameter object as JSON")
  ).action(async (options, command) => {
    const globalOptions = getGlobalOptions(command);
    const target = describeTarget(options);
    const collector = globalOptions.rpc ? createCliRpcLogCollector({ __cli__: target }) : void 0;
    const config = parseServerConfig({
      ...options,
      timeout: globalOptions.timeout
    });
    const params = parseJsonRecord(options.params, "Tool parameters") ?? {};
    const result = await withEphemeralManager(
      config,
      async (manager, serverId) => ({
        status: "completed",
        result: await manager.executeTool(serverId, options.name, params)
      }),
      {
        timeout: globalOptions.timeout,
        rpcLogger: collector?.rpcLogger
      }
    );
    writeResult(withRpcLogsIfRequested5(result, collector, globalOptions), globalOptions.format);
  });
}
function withRpcLogsIfRequested5(value, collector, options) {
  if (!options.rpc || options.format !== "json") {
    return value;
  }
  return attachCliRpcLogs(value, collector);
}

// src/index.ts
async function main(argv = process.argv) {
  const program = addGlobalOptions(
    new commander.Command().name("mcpjam").description(
      "Stateless MCP server probing, debugging, OAuth login, and conformance commands backed by @mcpjam/sdk"
    ).allowExcessArguments(false).exitOverride().configureOutput({
      writeOut: (value) => process.stdout.write(value),
      writeErr: () => {
      }
    })
  );
  registerServerCommands(program);
  registerToolsCommands(program);
  registerResourcesCommands(program);
  registerPromptCommands(program);
  registerAppsCommands(program);
  registerOAuthCommands(program);
  registerProtocolCommands(program);
  if (argv.length <= 2) {
    program.outputHelp();
    return 0;
  }
  try {
    await program.parseAsync(argv);
    const exitCode = process.exitCode;
    if (typeof exitCode === "number") {
      return exitCode;
    }
    return Number(exitCode ?? 0) || 0;
  } catch (error) {
    const format = detectOutputFormatFromArgv(argv);
    if (error instanceof commander.CommanderError) {
      if (error.code === "commander.helpDisplayed" || error.code === "commander.version") {
        return 0;
      }
      writeError(usageError(error.message), format);
      return 2;
    }
    const normalizedError = normalizeCliError(error);
    writeError(normalizedError, format);
    return normalizedError.exitCode;
  }
}
void main().then((exitCode) => {
  process.exitCode = exitCode;
});
//# sourceMappingURL=index.js.map
//# sourceMappingURL=index.js.map