import { randomUUID } from 'node:crypto';
import { probePrompts, readSession } from './hosted-harness-async-canary.mjs';
import { verifyFlowEvidence, evidenceFailure } from './hosted-harness-flow-evidence.mjs';

/** Retain the UI message protocol's tool parts for the real second request. */
export async function consumeTurn(response) {
  if (!response.ok || !response.body) throw new Error('web_request_failed');
  const message = { id: randomUUID(), role: 'assistant', parts: [] };
  const texts = new Map(), tools = new Map();
  let buffer = '', bytes = 0, finished = false;
  const decoder = new TextDecoder();
  const accept = line => {
    if (!line.startsWith('data:')) return;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') return;
    const chunk = JSON.parse(data);
    if (chunk.type === 'error' || chunk.type === 'tool-approval-request') throw new Error('web_turn_incomplete');
    if (chunk.type === 'text-start') {
      const part = { type: 'text', text: '' };
      texts.set(chunk.id, part); message.parts.push(part);
    }
    if (chunk.type === 'text-delta') {
      const part = texts.get(chunk.id);
      if (!part) throw new Error('malformed_stream');
      part.text += chunk.delta;
    }
    if (chunk.type === 'tool-input-available') {
      const part = { type: 'dynamic-tool', toolCallId: chunk.toolCallId,
        toolName: chunk.toolName, input: chunk.input, state: 'input-available' };
      tools.set(chunk.toolCallId, part); message.parts.push(part);
    }
    if (chunk.type === 'tool-output-available') {
      const part = tools.get(chunk.toolCallId);
      if (!part) throw new Error('malformed_stream');
      part.output = chunk.output; part.state = 'output-available';
    }
    if (chunk.type === 'tool-output-error') throw new Error('web_tool_failed');
    if (chunk.type === 'finish') finished = true;
  };
  for await (const piece of response.body) {
    bytes += piece.byteLength;
    if (bytes > 8 * 1024 * 1024) throw new Error('web_stream_limit');
    buffer += decoder.decode(piece, { stream: true });
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      accept(buffer.slice(0, newline).trim()); buffer = buffer.slice(newline + 1);
    }
  }
  accept(buffer.trim());
  if (!finished || [...tools.values()].some(part => part.state !== 'output-available')) throw new Error('web_turn_incomplete');
  return message;
}

export async function runUserTesting(config, bearer, tokens, invoke, request = fetch) {
  const results = [];
  for (const client of config.clients) {
    if (!bearer || !tokens?.[client.harness]) {
      results.push({ harness: client.harness, surface: 'user-testing', status: 'not_run', reason: 'staging_session_missing' });
      continue;
    }
    const id = randomUUID();
    const probe = { id, file: `mcpjam-canary-${id}.txt`, nonce: randomUUID() };
    const post = (path, body) => request(new URL(path, config.webUrl), {
      method: 'POST', headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(180_000),
    });
    try {
      const response = await post('/api/web/scenarios/redeem', { scenarioToken: tokens[client.harness] });
      if (!response.ok) throw new Error('study_redeem_failed');
      const study = await response.json();
      if (study.projectId !== config.projectId || !study.scenarioId || !Number.isInteger(study.accessVersion)) throw new Error('study_scope_mismatch');
      const messages = [];
      for (const prompt of probePrompts(client, probe)) {
        messages.push({ id: randomUUID(), role: 'user', parts: [{ type: 'text', text: prompt }] });
        messages.push(await consumeTurn(await post('/api/web/chat-v2', {
          projectId: config.projectId, scenarioId: study.scenarioId, accessVersion: study.accessVersion,
          accessScope: 'chat_v2', surface: 'share_link', chatSessionId: id, messages,
          selectedServerIds: study.bootstrap.servers.map(server => server.serverId),
          model: { id: study.bootstrap.modelId },
        })));
      }
      results.push({ harness: client.harness, surface: 'user-testing', sessionId: id,
        ...verifyFlowEvidence(await readSession(id, invoke), client, probe) });
    } catch (error) {
      results.push({ harness: client.harness, surface: 'user-testing', ...evidenceFailure(error) });
    }
  }
  return results;
}
