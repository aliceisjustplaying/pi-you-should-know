import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zstdDecompressSync } from 'node:zlib';

// Real Pi and real provider serializers, with local protocol servers instead of
// paid models. The wire request, resulting check and RPC notice own the contract.
const cases = [
  { name: 'GPT default', api: 'openai-codex-responses', provider: 'openai-codex', main: 'gpt-6-astra', side: 'gpt-6.1-sol', thinking: 'high' },
  { name: 'GPT configurable same-model thinking', api: 'openai-responses', provider: 'openai', main: 'gpt-6-astra', side: 'gpt-6-astra', thinking: 'medium', config: { gpt: { model: 'openai/gpt-6-astra', thinking: 'medium' } } },
  { name: 'GPT environment model override', api: 'openai-completions', provider: 'openai', main: 'gpt-6-astra', side: 'gpt-6-sol', thinking: 'high', override: 'openai/gpt-6-sol' },
  { name: 'global config routes a GLM main model through OpenAI for detection and explanation', api: 'openai-responses', provider: 'zai', sideProvider: 'openai', main: 'glm-5', side: 'gpt-6.1-sol', thinking: 'high', thinkingByRequest: ['high', 'medium'], config: { model: 'openai/gpt-6.1-sol', thinking: 'high' }, reconfigureAfterDetect: { model: 'openai/gpt-6.1-sol', thinking: 'medium' }, explain: true, checkStatus: true },
  { name: 'environment model wins over global model but keeps global thinking', api: 'openai-responses', provider: 'zai', sideProvider: 'openai', main: 'glm-5', side: 'gpt-6-astra', thinking: 'high', config: { model: 'openai/gpt-6.1-sol', thinking: 'high' }, override: 'openai/gpt-6-astra' },
  { name: 'global model and thinking win over GPT family values', api: 'openai-responses', provider: 'openai', main: 'gpt-6-astra', side: 'gpt-6-astra', thinking: 'high', config: { model: 'openai/gpt-6-astra', thinking: 'high', gpt: { model: 'openai/gpt-6-sol', thinking: 'medium' } } },
  { name: 'fallback thinking off is not overwritten by GPT family thinking high', api: 'openai-responses', provider: 'openai', main: 'gpt-6-astra', side: 'gpt-6.1-sol', thinking: 'high', config: { gpt: { model: 'openai/gpt-6.1-sol', thinking: 'high' }, fallback: { model: 'openai/gpt-6-luna', thinking: 'off' } }, fallback: { provider: 'openai', model: 'gpt-6-luna', thinking: 'off' }, fallbackApi: 'openai-responses', primaryError: true },
  { name: 'unknown global model fails without sending side request', api: 'openai-responses', provider: 'zai', sideProvider: 'openai', main: 'glm-5', side: 'gpt-6.1-sol', config: { model: 'openai/not-registered' }, missing: true, missingModel: 'openai/not-registered' },
  { name: 'invalid global model format fails without sending side request', api: 'openai-responses', provider: 'zai', main: 'glm-5', side: 'gpt-6.1-sol', config: { model: 'not-a-provider-qualified-id' }, invalidModel: true },
  { name: 'invalid global thinking fails without sending side request', api: 'openai-responses', provider: 'zai', sideProvider: 'openai', main: 'glm-5', side: 'gpt-6.1-sol', config: { model: 'openai/gpt-6.1-sol', thinking: 'ultra' }, invalidThinking: true },
  { name: 'Fable family default', api: 'anthropic-messages', provider: 'anthropic', main: 'claude-fable-5-1', side: 'claude-opus-5-5', thinking: 'medium' },
  { name: 'Fable configurable model and thinking', api: 'anthropic-messages', provider: 'anthropic', main: 'claude-fable-5', side: 'claude-sonnet-5', thinking: 'high', config: { fable: { model: 'anthropic/claude-sonnet-5', thinking: 'high' } } },
  { name: 'other Claude preserves cache and thinking', api: 'anthropic-messages', provider: 'anthropic', main: 'claude-sonnet-5', side: 'claude-sonnet-5', thinking: 'low' },
  { name: 'unknown configured model does not fall back to main', api: 'openai-responses', provider: 'openai', main: 'gpt-6-astra', side: 'gpt-6-sol', config: { gpt: { model: 'openai/not-a-registered-model' } }, missing: true },
  { name: 'GPT provider error is not an empty answer', api: 'openai-responses', provider: 'openai', main: 'gpt-6-astra', side: 'gpt-6-sol', thinking: 'high', config: { gpt: { model: 'openai/gpt-6-sol' } }, error: true },
  { name: 'MiniMax failure uses GPT Luna once for detection and explanation', api: 'openai-completions', provider: 'minimax-cn', main: 'MiniMax-M3.1-Flash-Preview', side: 'MiniMax-M3.1-Flash-Preview', thinking: 'off', config: { model: 'minimax-cn/MiniMax-M3.1-Flash-Preview', thinking: 'off', fallback: { model: 'openai/gpt-6-luna', thinking: 'off' } }, fallback: { provider: 'openai', model: 'gpt-6-luna', thinking: 'off' }, fallbackApi: 'openai-responses', primaryError: true, explain: true, checkStatus: true, reconfigureAfterDetect: { model: 'minimax-cn/MiniMax-M3.1-Flash-Preview', thinking: 'off', fallback: { model: 'openai/gpt-6-luna', thinking: 'medium' } } },
  { name: 'MiniMax transport disconnect uses GPT Luna once', api: 'openai-completions', provider: 'minimax-cn', main: 'MiniMax-M3.1-Flash-Preview', side: 'MiniMax-M3.1-Flash-Preview', thinking: 'off', config: { model: 'minimax-cn/MiniMax-M3.1-Flash-Preview', thinking: 'off', fallback: { model: 'openai/gpt-6-luna', thinking: 'off' } }, fallback: { provider: 'openai', model: 'gpt-6-luna', thinking: 'off' }, fallbackApi: 'openai-responses', primaryThrow: true },
  { name: 'primary success does not call configured fallback', api: 'openai-completions', provider: 'minimax-cn', main: 'MiniMax-M3.1-Flash-Preview', side: 'MiniMax-M3.1-Flash-Preview', thinking: 'off', config: { model: 'minimax-cn/MiniMax-M3.1-Flash-Preview', thinking: 'off', fallback: { model: 'openai/gpt-6-luna', thinking: 'off' } }, fallback: { provider: 'openai', model: 'gpt-6-luna', thinking: 'off' }, fallbackApi: 'openai-responses' },
  { name: 'learn none does not call configured fallback', api: 'openai-completions', provider: 'minimax-cn', main: 'MiniMax-M3.1-Flash-Preview', side: 'MiniMax-M3.1-Flash-Preview', thinking: 'off', config: { model: 'minimax-cn/MiniMax-M3.1-Flash-Preview', thinking: 'off', fallback: { model: 'openai/gpt-6-luna', thinking: 'off' } }, fallback: { provider: 'openai', model: 'gpt-6-luna', thinking: 'off' }, fallbackApi: 'openai-responses', none: true },
  { name: 'noncompliant model output does not call configured fallback', api: 'openai-completions', provider: 'minimax-cn', main: 'MiniMax-M3.1-Flash-Preview', side: 'MiniMax-M3.1-Flash-Preview', thinking: 'off', config: { model: 'minimax-cn/MiniMax-M3.1-Flash-Preview', fallback: { model: 'openai/gpt-6-luna', thinking: 'off' } }, fallback: { provider: 'openai', model: 'gpt-6-luna', thinking: 'off' }, fallbackApi: 'openai-responses', malformed: true },
  { name: 'abort does not call configured fallback', api: 'openai-completions', provider: 'minimax-cn', main: 'MiniMax-M3.1-Flash-Preview', side: 'MiniMax-M3.1-Flash-Preview', config: { model: 'minimax-cn/MiniMax-M3.1-Flash-Preview', fallback: { model: 'openai/gpt-6-luna', thinking: 'off' } }, fallback: { provider: 'openai', model: 'gpt-6-luna', thinking: 'off' }, fallbackApi: 'openai-responses', abortInFlight: true },
  { name: 'abort during fallback does not log a request_error result', api: 'openai-completions', provider: 'minimax-cn', main: 'MiniMax-M3.1-Flash-Preview', side: 'MiniMax-M3.1-Flash-Preview', config: { model: 'minimax-cn/MiniMax-M3.1-Flash-Preview', fallback: { model: 'openai/gpt-6-luna', thinking: 'off' } }, fallback: { provider: 'openai', model: 'gpt-6-luna', thinking: 'off' }, fallbackApi: 'openai-responses', primaryError: true, abortDuringFallback: true },
  { name: 'unregistered fallback fails fast without a side request', api: 'openai-completions', provider: 'minimax-cn', main: 'MiniMax-M3.1-Flash-Preview', side: 'MiniMax-M3.1-Flash-Preview', config: { model: 'minimax-cn/MiniMax-M3.1-Flash-Preview', fallback: { model: 'openai/not-registered', thinking: 'off' } }, invalidFallback: true },
  { name: 'invalid fallback thinking fails fast without a side request', api: 'openai-completions', provider: 'minimax-cn', main: 'MiniMax-M3.1-Flash-Preview', side: 'MiniMax-M3.1-Flash-Preview', config: { model: 'minimax-cn/MiniMax-M3.1-Flash-Preview', fallback: { model: 'openai/gpt-6-luna', thinking: 'impossible' } }, invalidFallbackThinking: true },
  { name: 'both primary and fallback errors remain visible and do not retry', api: 'openai-completions', provider: 'minimax-cn', main: 'MiniMax-M3.1-Flash-Preview', side: 'MiniMax-M3.1-Flash-Preview', config: { model: 'minimax-cn/MiniMax-M3.1-Flash-Preview', fallback: { model: 'openai/gpt-6-luna', thinking: 'off' } }, fallback: { provider: 'openai', model: 'gpt-6-luna', thinking: 'off' }, fallbackApi: 'openai-responses', primaryError: true, fallbackError: true },
];

for (const scenario of cases) test(scenario.name, { timeout: 20_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'ysk-route-'));
  const agentDir = join(root, 'agent');
  const logDir = join(agentDir, 'you-should-know');
  mkdirSync(logDir, { recursive: true });
  const configFile = join(logDir, 'config.json');
  if (scenario.config) writeFileSync(configFile, JSON.stringify(scenario.config));
  const receipt = join(root, 'receipt.txt');
  writeFileSync(receipt, 'Local fixture.');
  let child, mainPayload, sidePayload, stderr = '';
  const sidePayloads = [];
  const sideRequestTexts = [];
  const sideRequestUrls = [];
  const sideRoutes = [];
  const mainRequestUrls = [];
  const notices = [];
  let statusMessage = '';
  let signalPrimaryRequest;
  let signalFallbackRequest;
  const primaryRequestSeen = new Promise(resolve => { signalPrimaryRequest = resolve; });
  const fallbackRequestSeen = new Promise(resolve => { signalFallbackRequest = resolve; });
  const server = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const payload = JSON.parse((request.headers['content-encoding'] === 'zstd' ? zstdDecompressSync(body) : body).toString());
    const messages = payload.input ?? payload.messages;
    const serializedMessages = JSON.stringify(messages);
    const side = serializedMessages.includes('These are the last suggestions offered') || serializedMessages.includes('The person watching you work said yes to:');
    const explaining = serializedMessages.includes('The person watching you work said yes to:');
    const provider = request.url.split('/')[1];
    const isFallback = side && scenario.fallback && payload.model === scenario.fallback.model;
    if (side) { sidePayload = payload; sidePayloads.push(payload); sideRequestTexts.push(serializedMessages); sideRequestUrls.push(request.url); sideRoutes.push({ payload, url: request.url, provider, explaining, isFallback }); } else { mainPayload = payload; mainRequestUrls.push(request.url); }
    if (side && !explaining && !isFallback && scenario.reconfigureAfterDetect) writeFileSync(configFile, JSON.stringify(scenario.reconfigureAfterDetect));
    if (side && !isFallback && (scenario.error || scenario.primaryError)) {
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'fixture rejection: invalid request', type: 'invalid_request_error' } }));
      return;
    }
    if (side && !isFallback && scenario.primaryThrow) { request.socket.destroy(); return; }
    if (side && !isFallback && scenario.abortInFlight) { signalPrimaryRequest(); return; }
    if (side && isFallback && scenario.fallbackError) {
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'fixture fallback rejection', type: 'invalid_request_error' } }));
      return;
    }
    if (side && isFallback && scenario.abortDuringFallback) { signalFallbackRequest(); return; }
    const steps = messages.filter(m => m.role === 'tool' || m.type === 'function_call_output').length
      + messages.flatMap(m => Array.isArray(m.content) ? m.content : []).filter(c => c.type === 'tool_result').length;
    const tool = !side && steps < 7;
    const text = !side ? 'Done.' : explaining ? 'The fixture explanation uses the selected side model.' : scenario.none ? 'learn: none' : scenario.malformed ? 'no parseable response' : scenario.explain ? 'learn: The fixture found a billing change.\ntag: Heads up\nevidence: receipt.txt' : 'learn: The fixture found a billing change.\ntag: Heads up\nevidence: receipt.txt\nexplain: The price changed.';
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const event = (type, fields) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`);
    const requestApi = provider === scenario.provider ? scenario.api : provider === (scenario.sideProvider ?? scenario.provider) ? (scenario.sideApi ?? scenario.api) : scenario.fallbackApi;
    if (requestApi === 'anthropic-messages') {
      event('message_start', { message: { id: 'msg_fixture', type: 'message', role: 'assistant', model: payload.model, content: [], usage: { input_tokens: 10, output_tokens: 0 } } });
      event('content_block_start', { index: 0, content_block: tool ? { type: 'tool_use', id: `read_${steps}`, name: 'read', input: {} } : { type: 'text', text: '' } });
      event('content_block_delta', { index: 0, delta: tool ? { type: 'input_json_delta', partial_json: JSON.stringify({ path: receipt }) } : { type: 'text_delta', text } });
      event('content_block_stop', { index: 0 });
      event('message_delta', { delta: { stop_reason: tool ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 10 } });
      event('message_stop', {});
    } else if (requestApi === 'openai-completions') {
      const frame = value => response.write(`data: ${JSON.stringify({ id: 'local', object: 'chat.completion.chunk', created: 1, model: payload.model, choices: [value] })}\n\n`);
      frame({ index: 0, delta: tool ? { role: 'assistant', tool_calls: [{ index: 0, id: `read-${steps}`, type: 'function', function: { name: 'read', arguments: JSON.stringify({ path: receipt }) } }] } : { role: 'assistant', content: text }, finish_reason: null });
      frame({ index: 0, delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' });
      response.write('data: [DONE]\n\n');
    } else {
      const item = tool ? { type: 'function_call', id: `fc_${steps}`, call_id: `read_${steps}`, name: 'read', arguments: JSON.stringify({ path: receipt }), status: 'completed' }
        : { type: 'message', id: 'msg_fixture', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] };
      event('response.output_item.added', { output_index: 0, item: tool ? { ...item, arguments: '' } : { ...item, content: [] } });
      if (tool) event('response.function_call_arguments.delta', { output_index: 0, delta: item.arguments });
      else event('response.output_text.delta', { output_index: 0, content_index: 0, delta: text });
      event('response.output_item.done', { output_index: 0, item });
      event('response.completed', { response: { id: `resp_${steps}`, status: 'completed', output: [item], usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 } } });
    }
    response.end();
  });
  // Codex auto transport falls back to SSE without waiting for a WS timeout.
  server.on('upgrade', (_request, socket) => { socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); });
  try {
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const keyFor = api => api === 'openai-codex-responses' ? `fixture.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'local-fixture' } })).toString('base64url')}.fixture` : 'local-only';
    const mainProvider = scenario.provider;
    const sideProvider = scenario.sideProvider ?? scenario.provider;
    const fallbackProvider = scenario.fallback?.provider;
    const apiFor = provider => provider === mainProvider ? scenario.api : provider === fallbackProvider ? scenario.fallbackApi : (scenario.sideApi ?? scenario.api);
    const providers = {};
    for (const provider of new Set([mainProvider, sideProvider, ...(fallbackProvider ? [fallbackProvider] : [])])) {
      const api = apiFor(provider);
      const ids = [...new Set([...(provider === mainProvider ? [scenario.main] : []), ...(provider === sideProvider ? [scenario.side] : []), ...(provider === fallbackProvider ? [scenario.fallback.model] : [])])];
      const models = ids.map(id => ({ id, contextWindow: 128000, maxTokens: 16384, reasoning: true, compat: api === 'anthropic-messages' ? { forceAdaptiveThinking: true, supportsMidConvoEffort: id === 'claude-opus-5-5', supportsMidConvoSystemMessages: true } : undefined }));
      providers[provider] = { baseUrl: `http://127.0.0.1:${server.address().port}/${provider}/v1`, api, apiKey: keyFor(api), models };
    }
    writeFileSync(join(agentDir, 'models.json'), JSON.stringify({ providers }));
    const env = { ...process.env, PI_CODING_AGENT_DIR: agentDir, YSK_DEBUG: '1' };
    delete env.PI_SUBAGENT_ACTIVITY_FILE; delete env.YSK_MODEL;
    if (scenario.override) env.YSK_MODEL = scenario.override;
    const checkPromise = new Promise((resolve, reject) => {
      child = spawn('pi', ['--mode', 'rpc', '--offline', '--no-skills', '--no-context-files', '--no-extensions', '-e', process.env.YSK_TEST_SOURCE ?? fileURLToPath(new URL('../extensions/you-should-know/index.ts', import.meta.url)), '--provider', scenario.provider, '--model', scenario.main, '--thinking', 'low', '--session', join(root, 'session.jsonl')], { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'], signal: AbortSignal.timeout(18_000) });
      child.on('error', reject);
      child.on('exit', () => { if (!scenario.abortInFlight && !scenario.abortDuringFallback) reject(new Error(`Pi exited before check: ${stderr}`)); });
      child.stderr.on('data', data => { stderr += data; });
      let buffer = '';
      child.stdout.on('data', data => {
        buffer += data;
        for (;;) {
          const at = buffer.indexOf('\n'); if (at < 0) break;
          const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
          let event; try { event = JSON.parse(line); } catch { continue; }
          if (event.method === 'notify') {
            notices.push(event.message);
            if (scenario.checkStatus && event.message.startsWith('You should know: on')) {
              statusMessage = event.message;
              child.stdin.write(JSON.stringify({ type: 'prompt', message: 'Read receipt.txt seven times, then finish.' }) + '\n');
            }
            if (event.message.startsWith('you-should-know: step 6 ')) resolve(JSON.parse(readFileSync(join(logDir, 'checks.jsonl'), 'utf8').trim().split('\n').at(-1)));
          }
          if (event.type === 'extension_error' || event.type === 'response' && !event.success) reject(new Error(JSON.stringify(event)));
        }
      });
      child.stdin.write(JSON.stringify({ type: 'prompt', message: scenario.checkStatus ? '/ysk status' : 'Read receipt.txt seven times, then finish.' }) + '\n');
    });
    if (scenario.abortInFlight) {
      await primaryRequestSeen;
      child.stdin.write(JSON.stringify({ id: 'abort-check', type: 'new_session' }) + '\n');
      const check = await checkPromise;
      assert.equal(check.outcome, 'aborted', JSON.stringify(check));
      assert.equal(sideRoutes.length, 1, 'the pending primary request is the only provider call');
      assert.equal(sideRoutes[0].isFallback, false);
      const entries = readFileSync(join(logDir, 'checks.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
      assert.equal(entries.some(entry => entry.event === 'ysk_fallback_triggered'), false);
      return;
    }
    if (scenario.abortDuringFallback) {
      await fallbackRequestSeen;
      child.stdin.write(JSON.stringify({ id: 'abort-check', type: 'new_session' }) + '\n');
      const check = await checkPromise;
      assert.equal(check.outcome, 'aborted', JSON.stringify(check));
      const entries = readFileSync(join(logDir, 'checks.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
      assert.ok(entries.some(entry => entry.event === 'ysk_fallback_triggered'));
      assert.equal(entries.some(entry => entry.event === 'ysk_fallback_result' && entry.responseOutcome === 'request_error'), false);
      return;
    }
    const check = await checkPromise;
    assert.equal(check.outcome, scenario.error || scenario.missing || scenario.invalidModel || scenario.invalidThinking || scenario.invalidFallback || scenario.invalidFallbackThinking || scenario.fallbackError ? 'error' : scenario.none ? 'none' : scenario.malformed ? 'parse_failed' : 'shown', JSON.stringify(check));
    if (scenario.invalidModel || scenario.invalidThinking || scenario.invalidFallback || scenario.invalidFallbackThinking) {
      assert.match(check.error, scenario.invalidModel ? /YSK model must be provider\/model-id/ : scenario.invalidFallback ? /YSK fallback model not found: openai\/not-registered/ : scenario.invalidFallbackThinking ? /Invalid YSK fallback thinking level/ : /Invalid YSK thinking level/);
      assert.equal(sidePayload, undefined);
      assert.equal(notices.filter(n => n.startsWith('[ysk:')).length, 0);
      return;
    }
    if (scenario.missing) {
      assert.ok(check.error.includes(`YSK model not found: ${scenario.missingModel ?? 'openai/not-a-registered-model'}`), check.error);
      assert.equal(sidePayload, undefined);
      assert.equal(notices.filter(n => n.startsWith('[ysk:')).length, 0);
      return;
    }
    const primaryRoutes = sideRoutes.filter(route => !route.isFallback);
    assert.equal(primaryRoutes[0]?.payload.model, scenario.side);
    if (scenario.checkStatus) {
      if (scenario.fallback) assert.match(statusMessage, /model minimax-cn\/MiniMax-M3\.1-Flash-Preview · thinking off · fallback openai\/gpt-6-luna · thinking off/);
      else assert.match(statusMessage, /model openai\/gpt-6\.1-sol · thinking high/);
    }
    assert.ok(mainRequestUrls.every(url => url.includes(`/${scenario.provider}/v1/`)), JSON.stringify(mainRequestUrls));
    assert.ok(primaryRoutes.every(route => route.url.includes(`/${scenario.sideProvider ?? scenario.provider}/v1/`)), JSON.stringify(primaryRoutes.map(route => route.url)));
    const effort = p => p.reasoning?.effort ?? p.reasoning_effort ?? p.messages?.findLast(m => m.output_config)?.output_config.effort ?? p.output_config?.effort;
    assert.equal(effort(mainPayload), 'low');
    if (scenario.fallback) {
      const expectedModels = scenario.explain ? [scenario.side, scenario.fallback.model, scenario.side, scenario.fallback.model] : scenario.primaryThrow || scenario.primaryError ? [scenario.side, scenario.fallback.model] : [scenario.side];
      assert.deepEqual(sideRoutes.map(route => route.payload.model), expectedModels);
      assert.deepEqual(sideRoutes.map(route => route.isFallback), expectedModels.map(model => model === scenario.fallback.model));
      assert.ok(sideRoutes.every(route => JSON.stringify(route.payload.input ?? route.payload.messages).includes('Read receipt.txt seven times, then finish.')));
      for (const route of sideRoutes) {
        assert.equal(route.url.includes(`/${route.isFallback ? scenario.fallback.provider : scenario.sideProvider ?? scenario.provider}/v1/`), true, route.url);
        const expectedEffort = route.isFallback && scenario.reconfigureAfterDetect && route.explaining ? 'medium' : route.isFallback ? scenario.fallback.thinking : scenario.thinking;
        const wireEffort = effort(route.payload);
        const routeApi = route.isFallback ? scenario.fallbackApi : scenario.sideApi ?? scenario.api;
        if (expectedEffort === 'off') assert.equal(wireEffort, routeApi === 'openai-responses' ? 'none' : undefined, `${route.provider}/${route.payload.model} via ${routeApi}`);
        else assert.equal(wireEffort, expectedEffort, `${route.provider}/${route.payload.model} via ${routeApi}`);
      }
    } else {
      for (const [index, payload] of sidePayloads.entries()) {
        assert.equal(payload.model, scenario.side);
        assert.equal(effort(payload), scenario.thinkingByRequest?.[index] ?? scenario.thinking);
      }
    }
    if (scenario.explain) {
      assert.equal(sidePayloads.length, scenario.fallback ? 4 : 2, 'detection and explanation use the configured provider request(s)');
      assert.ok(['learn:', 'tag:', 'evidence:', 'explain:'].every(label => sideRequestTexts[0].includes(label)));
    }
    if (scenario.name.startsWith('other Claude')) {
      assert.deepEqual(sidePayload.tools, mainPayload.tools);
      assert.deepEqual(sidePayload.system, mainPayload.system);
      assert.equal(check.align.aligned, true);
    } else {
      assert.equal(sidePayload.tool_choice?.type ?? sidePayload.tool_choice, 'none');
    }
    const noticesShown = notices.filter(n => n.startsWith('[ysk:')).length;
    if (scenario.error) {
      assert.match(check.error, /fixture rejection/);
      assert.equal(noticesShown, 0);
    } else if (scenario.fallbackError) {
      assert.match(check.error, /YSK fallback response failed/);
      assert.equal(noticesShown, 0);
    } else if (scenario.none || scenario.malformed) assert.equal(noticesShown, 0);
    else assert.equal(noticesShown, 1);
    if (scenario.fallback) {
      const entries = readFileSync(join(logDir, 'checks.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
      const triggered = entries.filter(entry => entry.event === 'ysk_fallback_triggered');
      assert.equal(triggered.length, scenario.explain ? 2 : scenario.primaryThrow || scenario.primaryError ? 1 : 0);
      assert.equal(JSON.stringify(entries).includes('Read receipt.txt seven times, then finish.'), false, 'logs do not contain the original prompt');
      if (scenario.primaryError || scenario.primaryThrow || scenario.fallbackError) {
        assert.equal(triggered[0].reason, 'response_error');
        assert.equal(triggered[0].primaryProvider, scenario.provider);
        assert.equal(triggered[0].primaryModel, scenario.side);
        assert.equal(triggered[0].fallbackProvider, scenario.fallback.provider);
        assert.equal(triggered[0].fallbackModel, scenario.fallback.model);
      }
      if (scenario.explain) {
        assert.equal(check.fallbackUsed, true);
        assert.equal(check.fallbackReason, 'response_error');
        assert.ok(check.primaryUsage, 'failed primary usage is retained when Pi provides it');
        assert.ok(check.fallbackUsage, 'fallback response usage is retained');
        assert.equal(check.provider, scenario.fallback.provider);
        assert.equal(check.model, scenario.fallback.model);
        assert.equal(check.responseOutcome, 'stop');
      }
      if (scenario.fallbackError) assert.equal(sideRoutes.length, 2, 'no additional request follows fallback failure');
      if (!scenario.primaryError && !scenario.primaryThrow) assert.equal(check.fallbackUsed, false);
    }
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited; }
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  }
});
