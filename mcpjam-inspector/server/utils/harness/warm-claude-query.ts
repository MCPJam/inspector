import { bridgeIndent } from "./claude-code-bridge-indent.js";

/** Installed only in the hosted pilot's version-pinned Claude bridge. The SDK
 * query owns the child. Each host turn owns its input, output and callbacks. */
// The kernel signal survives exec, so a killed bridge cannot leave the CLI
// running under credentials from a message whose owner disappeared.
const linuxClaudeLauncher = [
  "import ctypes, os, signal, sys",
  "if ctypes.CDLL(None).prctl(1, signal.SIGKILL, 0, 0, 0) != 0 or os.getppid() != int(sys.argv[1]):",
  "    sys.exit(125)",
  "os.execvpe(sys.argv[2], sys.argv[2:], os.environ)",
].join("\n");

const sessionCode = `
var mcpjamWarmClaude, mcpjamClaudeSignals;
async function mcpjamOpenClaudeTurn(spec, turn, start) {
  const { PassThrough } = await import("node:stream");
  const { options, prompt } = spec;
  const { abortSignal, model, permissionMode, thinking, mcpServers, canUseTool,
    onElicitation, hooks, settings, resume, continue: continueSession, ...staticOptions } = options;
  // A change the SDK cannot apply live requires an exact disk resume.
  const shape = JSON.stringify([{...staticOptions, env:start.env}, start.tools, start.skills, !!onElicitation, Object.entries(hooks ?? {})
    .map(([kind, groups]) => [kind, groups.map(group => [group.matcher, group.hooks.length])])]);
  let state = mcpjamWarmClaude;
  function retire() {
    if (!state) return;
    if (mcpjamWarmClaude === state) mcpjamWarmClaude = undefined;
    state.owner = undefined;
    state.input.destroy();
    state.query?.close();
  }
  if (state?.owner) throw new Error("A Claude message is already running.");
  if (state && (state.shape !== shape || (resume && state.sessionId !== resume))) retire();
  state = mcpjamWarmClaude;
  const owner = { options, turn, started: false, commands: new Set(), completed: new Set(), busy: 0 };
  const stop = () => retire();
  if (!state) {
    state = { shape, input: new PassThrough({objectMode:true}), owner, cost:0 };
    const thisProcess = state;
    const delegate = (select) => async (...args) => {
      const current = thisProcess.owner;
      if (!current?.started || current.turn.abortSignal.aborted) throw new Error("No active Claude message.");
      current.busy++;
      try {
        const result = await select(current.options)(...args);
        if (current !== thisProcess.owner || current.turn.abortSignal.aborted) throw new Error("The Claude message ended.");
        return result;
      } finally { current.busy--; }
    };
    const hookDelegates = Object.fromEntries(Object.entries(hooks ?? {}).map(([kind,groups]) =>
      [kind,groups.map((group,i) => ({...group, hooks:group.hooks.map((_,j) => delegate(o => o.hooks[kind][i].hooks[j]))}))]));
    const { spawn } = await import("node:child_process");
    const spawnClaudeCodeProcess = ({command,args,cwd,env,signal}) => {
      const child = spawn("/usr/bin/python3", ["-I","-S","-c",${JSON.stringify(linuxClaudeLauncher)},String(process.pid),command,...args], {
        cwd, env, signal, stdio:["pipe","pipe","pipe"]
      });
      child.stderr.on("data", chunk => options.stderr?.(chunk.toString()));
      return child;
    };
    try {
      state.query = claudeSdk.query({prompt:state.input,options:{
        ...options, abortSignal:undefined, hooks:hookDelegates,
        ...(process.platform === "linux" ? {spawnClaudeCodeProcess} : {}),
        ...(canUseTool ? {canUseTool:delegate(o=>o.canUseTool)} : {}),
        ...(onElicitation ? {onElicitation:delegate(o=>o.onElicitation)} : {})
      }});
      mcpjamWarmClaude = state;
      if (!mcpjamClaudeSignals) {
        mcpjamClaudeSignals = true;
        const shutdown = () => {
          mcpjamWarmClaude?.query?.close();
          setTimeout(() => process.exit(0),1000).unref();
        };
        process.once("SIGTERM",shutdown);
        process.once("SIGINT",shutdown);
        process.once("exit",() => mcpjamWarmClaude?.query?.close());
      }
    } catch (error) { retire(); throw error; }
  } else {
    state.owner = owner;
  }
  const raw = state.query;
  const baseCost = state.cost;
  const reused = state.initialized === true;
  const within = async (promise,ms) => {
    let timer;
    try { return await Promise.race([promise,new Promise((_,reject) => {
      timer=setTimeout(()=>reject(new Error("Claude did not confirm the message configuration.")),ms);
    })]); } finally { clearTimeout(timer); }
  };
  abortSignal?.addEventListener("abort",stop,{once:true});
  try {
    abortSignal?.throwIfAborted();
    // Resolve all configuration before the SDK receives even the first byte of the prompt.
    const configure = async () => {
      if (reused) {
        if (JSON.stringify(state.settings) !== JSON.stringify(settings)) {
          const update = {...settings};
          for (const key of Object.keys(state.settings ?? {})) if (!(key in update)) update[key] = null;
          await raw.applyFlagSettings(update);
        }
        if (state.model !== model) await raw.setModel(model);
        if (state.permissionMode !== permissionMode) await raw.setPermissionMode(permissionMode);
        if (JSON.stringify(state.thinking) !== JSON.stringify(thinking))
          await raw.setMaxThinkingTokens(thinking?.type === "enabled" ? thinking.budgetTokens : thinking?.type === "disabled" ? 0 : null);
        // SDK servers retain their callback object when the name is unchanged.
        // Disconnect the previous message's callbacks before attaching new ones.
        if (Object.values(mcpServers ?? {}).some(server => server.type === "sdk")) {
          const remote = Object.fromEntries(Object.entries(mcpServers).filter(([,server]) => server.type !== "sdk"));
          const detached = await raw.setMcpServers(remote);
          if (Object.keys(detached.errors ?? {}).length) throw new Error("Claude could not detach the previous host tools.");
        }
        const refreshed = await raw.setMcpServers(mcpServers ?? {});
        if (Object.keys(refreshed.errors ?? {}).length) throw new Error("Claude refused the MCP configuration.");
      }
      const expected = Object.keys(mcpServers ?? {});
      const removed = (state.servers ?? []).filter(name => !expected.includes(name));
      while (expected.length || removed.length) {
        if (state.owner !== owner) throw new Error("The Claude message ended.");
        const inventory = await raw.mcpServerStatus();
        const statuses = expected.map(name => inventory.find(s => s.name === name)?.status);
        if (statuses.every(status=>status === "connected") && !inventory.some(s=>removed.includes(s.name))) break;
        if (statuses.some(s=>s !== undefined && s !== "pending" && s !== "connected")) throw new Error("Claude could not connect an MCP server.");
        await new Promise(resolve=>setTimeout(resolve,50));
      }
      Object.assign(state,{model,permissionMode,thinking,settings,servers:expected,initialized:true});
    };
    await within(configure(),30000);
    abortSignal?.throwIfAborted();
    if (state.owner !== owner) throw new Error("The Claude message ended.");
    const pump = async () => {
      for await (const message of prompt) {
        if (state.owner !== owner || turn.abortSignal.aborted) return;
        owner.commands.add(message.uuid);
        state.input.write(message);
      }
    };
    void pump().catch(() => { if (state.owner === owner) retire(); });
  } catch (err) {
    abortSignal?.removeEventListener("abort",stop);
    retire();
    throw err;
  }
  const iterator = raw[Symbol.asyncIterator]();
  const next = async () => {
    for (;;) {
      const event = await iterator.next();
      if (event.done) return event;
      if (state.owner !== owner) throw new Error("The Claude message ended.");
      const msg=event.value;
      if (msg.type === "command_lifecycle" && owner.commands.has(msg.command_uuid)) {
        if (msg.state === "started") owner.started = true;
        if (msg.state === "completed") owner.completed.add(msg.command_uuid);
      }
      if (!owner.started) continue;
      if (msg.session_id) state.sessionId=msg.session_id;
      // Background agents and subagents run with the ordinary drain semantics
      // and retire afterwards. They must never inherit the next message's lease.
      if (msg.parent_tool_use_id || (msg.type === "system" && msg.subtype?.startsWith("task_"))) owner.background = true;
      if (msg.type === "result" && typeof msg.total_cost_usd === "number") {
        state.cost = msg.total_cost_usd;
        return {...event,value:{...msg,total_cost_usd:Math.max(0,state.cost-baseCost)}};
      }
      return event;
    }
  };
  const finish = async (clean) => {
    try {
      if (!clean || !owner.started || owner.busy || owner.background || state.owner !== owner) return retire();
      const complete = async () => {
        while (owner.completed.size !== owner.commands.size) {
          const event=await iterator.next();
          const msg=event.value;
          if (event.done || msg?.type !== "command_lifecycle" || msg.state !== "completed" ||
              !owner.commands.has(msg.command_uuid)) throw new Error("Claude still has pending work.");
          owner.completed.add(msg.command_uuid);
        }
      };
      await within(complete(),500);
      state.owner=undefined;
    } catch { retire(); } finally { abortSignal?.removeEventListener("abort",stop); }
  };
  return new Proxy(raw,{get(target,key) {
    if (key === Symbol.asyncIterator) return () => ({next,return:async()=>({done:true})});
    if (key === "mcpjamFinish") return finish;
    const value=Reflect.get(target,key,target);
    return typeof value === "function" ? value.bind(target) : value;
  }});
}
`;

export function patchWarmClaudeQuery(source: string): string {
  if (source.includes("async function mcpjamOpenClaudeTurn(")) return source;
  const open = "const q = claudeSdk.query({";
  const end = bridgeIndent("abortSignal: abortCtl.signal\n    }\n  });");
  // The host tool's result has settled once its `.finally` block closes here.
  const settled = bridgeIndent("      });");
  const toolResult = bridgeIndent(
    '      });\n      emit({\n        type: "tool-result",\n        toolCallId,',
  );
  const close = /await q\.return\?\.\(\s*void 0\s*\);/;
  const hostTool = "const [input, extra] = handlerArgs;";
  if (
    !source.includes(open) ||
    !source.includes(end) ||
    !close.test(source) ||
    !source.includes(hostTool) ||
    source.split(toolResult).length !== 2 ||
    !source.includes("mcpjamDrainController.clear()")
  ) {
    throw new Error("The installed Claude bridge cannot retain a live query.");
  }
  return (
    source
      .replace(open, "const q = await mcpjamOpenClaudeTurn({")
      .replace(
        end,
        bridgeIndent("abortSignal: abortCtl.signal\n    }\n  }, turn, start);"),
      )
      .replace(
        hostTool,
        hostTool +
          bridgeIndent(
            '\n      if (mcpjamWarmClaude?.owner?.turn !== turn || turn.abortSignal.aborted) throw new Error("The tool request belongs to an ended message.");',
          ),
      )
      .replace(
        toolResult,
        settled +
          bridgeIndent(
            '\n      if (mcpjamWarmClaude?.owner?.turn !== turn || turn.abortSignal.aborted) throw new Error("The tool result belongs to an ended message.");',
          ) +
          toolResult.slice(settled.length),
      )
      .replace(
        close,
        "await q.mcpjamFinish(queryInput.hasObservedResult && !turn.abortSignal.aborted && !abortCtl.signal.aborted && !emittedTerminalError && !mcpjamDrainController.stopped);",
      ) + sessionCode
  );
}
