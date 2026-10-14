import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const EN = 'learn: The fixture found a billing change.\ntag: Heads up\nevidence: receipt.txt\nexplain: The price changed.';
const MIXED_ZH = 'learn: 等 CI 合并通道的机票单 #3673 已关，但你的 embeddingGemma2 仓的豁免登记单 #4637 还开着\ntag: Heads up\nevidence: receipt.txt\nexplain:\n**豁免登记还开着**\n机票单 #3673 已关，但 embeddingGemma2 仓的豁免登记单 #4637 还开着。';
const ZH_OTHER = 'learn: 缓存查找结果会省 token，但提示词改了会返回过期答案\ntag: Heads up\nevidence: receipt.txt\nexplain:\n**缓存会过期**\n查找结果省了 token，提示词一改就过期。';
const FOLLOW = 'in the language the user is using in this conversation';
const HARD_ZH = 'Write the learn line and the explain text in Simplified Chinese.';
const HARD_EN = 'Write the learn line and the explain text in English.';

async function runCheck({ config, seen, detect = EN, repair, explain } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'ysk-lang-'));
  const agentDir = join(root, 'agent');
  const logDir = join(agentDir, 'you-should-know');
  mkdirSync(logDir, { recursive: true });
  if (config) writeFileSync(join(logDir, 'config.json'), JSON.stringify(config));
  if (seen) writeFileSync(join(logDir, 'state.json'), JSON.stringify({ enabled: true, seen, known: [], ignoredInARow: 0, skip: 0 }));
  const receipt = join(root, 'receipt.txt');
  writeFileSync(receipt, 'local fixture');
  let child, stderr = '';
  const notices = [];
  const sidePayloads = [];
  const counts = { detect: 0, repair: 0, explain: 0, main: 0 };
  const server = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk;
    const payload = JSON.parse(body);
    const blob = JSON.stringify(payload.messages);
    const respond = (content, finish = 'stop') => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const frame = (value) => response.write(`data: ${JSON.stringify({ id: 'local', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [value] })}\n\n`);
      frame({ index: 0, delta: { role: 'assistant', ...(typeof content === 'string' ? { content } : content) }, finish_reason: null });
      frame({ index: 0, delta: {}, finish_reason: finish });
      response.end('data: [DONE]\n\n');
    };
    if (blob.includes('These are the last suggestions offered')) {
      counts.detect++;
      sidePayloads.push(payload);
      respond(detect);
    } else if (blob.includes('Rewrite the following You Should Know note')) {
      counts.repair++;
      sidePayloads.push(payload);
      respond(repair ?? detect);
    } else if (blob.includes('The person watching you work said yes to') || blob.includes('Rewrite the following explanation')) {
      counts.explain++;
      respond(explain ?? detect);
    } else {
      counts.main++;
      const steps = payload.messages.filter((message) => message.role === 'tool').length;
      if (steps < 7) respond({ tool_calls: [{ index: 0, id: `read-${steps}`, type: 'function', function: { name: 'read', arguments: JSON.stringify({ path: receipt }) } }] }, 'tool_calls');
      else respond('Fixture complete.');
    }
  });
  try {
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    writeFileSync(join(agentDir, 'models.json'), JSON.stringify({ providers: { localfixture: { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, api: 'openai-completions', apiKey: 'local-only', models: [{ id: 'fixture', contextWindow: 128000, maxTokens: 1024 }] } } }));
    const env = { ...process.env, PI_CODING_AGENT_DIR: agentDir, YSK_DEBUG: '1' };
    delete env.PI_SUBAGENT_ACTIVITY_FILE; delete env.YSK_MODEL;
    const check = await new Promise((resolve, reject) => {
      child = spawn('pi', ['--mode', 'rpc', '--offline', '--no-skills', '--no-context-files', '--no-extensions', '-e', process.env.YSK_TEST_SOURCE ?? fileURLToPath(new URL('../extensions/you-should-know/index.ts', import.meta.url)), '--provider', 'localfixture', '--model', 'fixture', '--thinking', 'off', '--session', join(root, 'session.jsonl')], { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'], signal: AbortSignal.timeout(18_000) });
      child.on('error', reject);
      child.on('exit', () => reject(new Error(`Pi exited before check: ${stderr}`)));
      child.stderr.on('data', (data) => { stderr += data; });
      let buffer = '';
      child.stdout.on('data', (data) => {
        buffer += data;
        for (;;) {
          const at = buffer.indexOf('\n'); if (at < 0) break;
          const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
          let event; try { event = JSON.parse(line); } catch { continue; }
          if (event.method === 'notify') {
            notices.push(event.message);
            if (event.message.startsWith('you-should-know: step 6 ')) {
              const rows = readFileSync(join(logDir, 'checks.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((row) => JSON.parse(row));
              resolve(rows.find((row) => row.event === 'check') ?? rows.at(-1));
            }
          }
          if (event.type === 'extension_error' || event.type === 'response' && !event.success) reject(new Error(JSON.stringify(event)));
        }
      });
      child.stdin.write(JSON.stringify({ type: 'prompt', message: 'Read receipt.txt seven times, then finish.' }) + '\n');
    });
    return { check, notices, counts, sidePayloads, stderr };
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited; }
    server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  }
}

const detectText = (result) => JSON.stringify(result.sidePayloads[0]?.messages ?? []);
const notes = (result) => result.notices.filter((message) => message.startsWith('[ysk:'));

test('zh mixed Chinese with issue numbers is shown without repair', { timeout: 20_000 }, async () => {
  const result = await runCheck({ config: { language: 'zh' }, detect: MIXED_ZH });
  assert.equal(result.check.outcome, 'shown', result.stderr);
  assert.equal(result.counts.detect, 1);
  assert.equal(result.counts.repair, 0);
  assert.equal(notes(result).length, 1);
  assert.match(notes(result)[0], /embeddingGemma2/);
  assert.match(notes(result)[0], /#4637/);
  assert.equal(detectText(result).includes(HARD_ZH), true);
});

test('zh English note is repaired once and shown in Chinese', { timeout: 20_000 }, async () => {
  const result = await runCheck({ config: { language: 'zh' }, detect: EN, repair: MIXED_ZH });
  assert.equal(result.check.outcome, 'shown', result.stderr);
  assert.equal(result.counts.detect, 1);
  assert.equal(result.counts.repair, 1);
  assert.equal(result.counts.explain, 0);
  assert.equal(notes(result).length, 1);
  assert.match(notes(result)[0], /豁免登记单/);
  assert.equal(notes(result)[0].includes('billing change'), false);
  assert.ok(result.check.repair, JSON.stringify(result.check));
  assert.equal(typeof result.check.repair.ms, 'number');
  assert.match(detectText(result), /Simplified Chinese/);
  assert.equal(detectText(result).includes(FOLLOW), false);
});

test('zh English note that stays English is discarded', { timeout: 20_000 }, async () => {
  const result = await runCheck({ config: { language: 'zh' }, detect: EN, repair: EN });
  assert.equal(result.check.outcome, 'language_rejected', result.stderr);
  assert.equal(result.counts.detect, 1);
  assert.equal(result.counts.repair, 1);
  assert.equal(notes(result).length, 0);
  assert.match(result.check.line, /billing change/);
  assert.ok(result.check.repair, JSON.stringify(result.check));
  assert.ok(result.notices.some((message) => message.includes('language_rejected')));
  assert.ok(result.notices.some((message) => message.includes('repairing language')));
});

test('unconfigured prompt follows the conversation and skips detection', { timeout: 20_000 }, async () => {
  const result = await runCheck({ detect: EN });
  assert.equal(result.check.outcome, 'shown', result.stderr);
  assert.equal(result.counts.repair, 0);
  assert.equal(notes(result).length, 1);
  assert.equal(detectText(result).includes(FOLLOW), true);
  assert.equal(detectText(result).includes(HARD_ZH), false);
  assert.equal(detectText(result).includes(HARD_EN), false);
});

test('two different Chinese notes are not deduped', { timeout: 20_000 }, async () => {
  const previous = ZH_OTHER.match(/^learn: (.+)$/m)[1];
  const result = await runCheck({ seen: [previous], detect: MIXED_ZH });
  assert.equal(result.check.outcome, 'shown', result.stderr);
  assert.equal(result.check.line, MIXED_ZH.match(/^learn: (.+)$/m)[1]);
  assert.equal(notes(result).length, 1);
});

test('invalid language fails the check', { timeout: 20_000 }, async () => {
  const result = await runCheck({ config: { language: 'jp' }, detect: EN });
  assert.equal(result.check.outcome, 'error', result.stderr);
  assert.match(String(result.check.error), /YSK language must be zh or en/);
  assert.equal(result.counts.detect, 0);
  assert.equal(notes(result).length, 0);
});

test('en CJK note is repaired; English note is accepted', { timeout: 20_000 }, async () => {
  const rejected = await runCheck({ config: { language: 'en' }, detect: MIXED_ZH, repair: EN });
  assert.equal(rejected.check.outcome, 'shown', rejected.stderr);
  assert.equal(rejected.counts.repair, 1);
  assert.equal(notes(rejected).length, 1);
  assert.match(notes(rejected)[0], /billing change/);
  assert.equal(detectText(rejected).includes(HARD_EN), true);
  const accepted = await runCheck({ config: { language: 'en' }, detect: EN });
  assert.equal(accepted.check.outcome, 'shown', accepted.stderr);
  assert.equal(accepted.counts.repair, 0);
});
