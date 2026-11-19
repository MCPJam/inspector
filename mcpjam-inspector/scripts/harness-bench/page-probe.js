// Injected into the Playground page before the app loads (page.addInitScript).
// Times one chat turn from the browser's side: the Send key or click, the
// /api/web/chat-v2 request and its UI stream, and the first assistant text
// painted on screen. All times are performance.now() in this page.
(() => {
  if (window.__harnessBench) return;
  const CHAT_PATH = /\/api\/web\/chat-v2\/?$/;
  const now = () => performance.now();
  const state = { turns: [], current: null };
  window.__harnessBench = state;

  function currentTurn() {
    return state.current;
  }

  // ── Send: the Enter keydown in the composer, or a click on Send ────────
  document.addEventListener(
    "keydown",
    (event) => {
      const turn = currentTurn();
      if (!turn || turn.send !== null) return;
      if (event.key !== "Enter" || event.shiftKey) return;
      if (!(event.target instanceof HTMLTextAreaElement)) return;
      turn.send = event.timeStamp;
      turn.sendKind = "enter";
    },
    true,
  );
  document.addEventListener(
    "click",
    (event) => {
      const turn = currentTurn();
      if (!turn || turn.send !== null) return;
      const button = event.target instanceof Element ? event.target.closest("button") : null;
      if (!button || button.getAttribute("aria-label") !== "Send message") return;
      turn.send = event.timeStamp;
      turn.sendKind = "click";
    },
    true,
  );

  // ── The chat request and its UI message stream ─────────────────────────
  const originalFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    let path = "";
    try {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      path = new URL(raw, location.href).pathname;
    } catch {
      return originalFetch(input, init);
    }
    const turn = currentTurn();
    if (!turn || !CHAT_PATH.test(path)) return originalFetch(input, init);
    const request = {
      start: now(), headers: null, status: null, serverTiming: null,
      firstChunk: null, firstTextDelta: null, firstText: "", text: "",
      lastTextDelta: null, finish: null, end: null, error: null,
      types: {}, firstSeen: {}, toolOutputs: [], dataParts: [],
    };
    turn.requests.push(request);
    let response;
    try {
      response = await originalFetch(input, init);
    } catch (error) {
      request.error = String((error && error.message) || error);
      request.end = now();
      throw error;
    }
    request.headers = now();
    request.status = response.status;
    request.serverTiming = response.headers.get("server-timing");
    if (response.status !== 200) {
      response.clone().text().then(
        (body) => { request.errorBody = body.slice(0, 600); },
        () => {},
      );
    }
    if (!response.body) {
      request.end = now();
      return response;
    }
    const decoder = new TextDecoder();
    let buffer = "";
    const handleEvent = (payload, at) => {
      let event;
      try {
        event = JSON.parse(payload);
      } catch {
        return;
      }
      const type = event && event.type;
      if (!type) return;
      request.types[type] = (request.types[type] || 0) + 1;
      if (request.firstSeen[type] === undefined) request.firstSeen[type] = at;
      if (type === "text-delta") {
        const delta = String(event.delta ?? event.textDelta ?? "");
        request.text += delta;
        if (request.firstTextDelta === null && request.text.trim()) {
          request.firstTextDelta = at;
          request.firstText = request.text.trim().slice(0, 80);
        }
        request.lastTextDelta = at;
      } else if (type === "tool-output-available") {
        request.toolOutputs.push({
          at, toolCallId: event.toolCallId,
          output: JSON.stringify(event.output ?? null).slice(0, 600),
        });
      } else if (type === "finish") {
        request.finish = at;
      } else if (type === "error") {
        request.streamError = String(event.errorText ?? event.error ?? "").slice(0, 400);
      } else if (type === "data-harness-startup" && event.data && event.data.chatSessionId) {
        request.chatSessionId = event.data.chatSessionId;
        if (request.dataParts.length < 40) request.dataParts.push({ at, type, data: JSON.stringify(event.data).slice(0, 300) });
      } else if (type.startsWith("data-") && request.dataParts.length < 40) {
        request.dataParts.push({ at, type, data: JSON.stringify(event.data ?? null).slice(0, 300) });
      }
    };
    const tap = new TransformStream({
      transform(chunk, controller) {
        controller.enqueue(chunk);
        const at = now();
        if (request.firstChunk === null) request.firstChunk = at;
        buffer += decoder.decode(chunk, { stream: true });
        let index;
        while ((index = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, index).trim();
          buffer = buffer.slice(index + 1);
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (payload && payload !== "[DONE]") handleEvent(payload, at);
        }
      },
      flush() {
        request.end = now();
      },
    });
    return new Response(response.body.pipeThrough(tap), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };

  // ── First assistant text on screen ─────────────────────────────────────
  // New message elements that are not the person's own message. The first
  // streamed text (seen by the tap above, before React renders it) is the
  // needle; its first appearance in one of them, plus the next frame, is the
  // painted time.
  function newAssistantText(turn) {
    let text = "";
    for (const element of document.querySelectorAll("[data-message-id]")) {
      const id = element.getAttribute("data-message-id");
      if (turn.existing.has(id)) continue;
      const content = element.textContent || "";
      if (content.includes(turn.prompt)) continue;
      text += content + "\n";
    }
    return text;
  }

  function check(turn) {
    if (turn.domText !== null) return;
    const request = turn.requests[turn.requests.length - 1];
    if (!request || !request.firstText) return;
    const needle = request.firstText.slice(0, 12);
    if (!newAssistantText(turn).includes(needle)) return;
    turn.domText = now();
    requestAnimationFrame(() => {
      turn.frame = now();
      setTimeout(() => {
        turn.painted = now();
      }, 0);
    });
  }

  state.arm = (prompt) => {
    const turn = {
      prompt, armed: now(), send: null, sendKind: null, requests: [],
      existing: new Set(
        [...document.querySelectorAll("[data-message-id]")].map((e) => e.getAttribute("data-message-id")),
      ),
      domText: null, frame: null, painted: null, lastMutation: null,
    };
    state.current = turn;
    state.turns.push(turn);
    const observer = new MutationObserver(() => {
      turn.lastMutation = now();
      check(turn);
    });
    observer.observe(document.body, { subtree: true, childList: true, characterData: true });
    turn.stop = () => observer.disconnect();
    return state.turns.length - 1;
  };

  state.read = (index) => {
    const turn = state.turns[index];
    if (!turn) return null;
    const { existing, stop, ...rest } = turn;
    return { ...rest, assistantText: newAssistantText(turn).slice(0, 2000) };
  };

  state.disarm = (index) => {
    const turn = state.turns[index];
    if (turn && turn.stop) turn.stop();
    if (state.current === turn) state.current = null;
  };
})();
