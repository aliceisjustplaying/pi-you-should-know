import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync, watch } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// This is a local protocol fixture, not a model: seven real read-tool steps make Pi
// fire turn_end, and the side response is held until Pi reports agent_settled.
for (const layout of ['parent', 'flat-child', 'nested-child']) {
  test(`real detection survives idle completion: ${layout}`, { timeout: 20_000 }, async () => {
    const root = mkdtempSync(join(tmpdir(), 'ysk-detection-'));
    const agentDir = join(root, 'agent');
    const logDir = join(agentDir, 'you-should-know');
    mkdirSync(logDir, { recursive: true });
    const logFile = join(logDir, 'checks.jsonl');
    writeFileSync(logFile, '');
    const receipt = join(root, 'receipt.txt');
    writeFileSync(receipt, 'local fixture');
    let child, watcher, settled = false, finishDetection;
    let requests = 0, sideRequests = 0, stderr = '';
    const events = [];
    const server = createServer(async (request, response) => {
      let body = ''; for await (const chunk of request) body += chunk;
      const payload = JSON.parse(body);
      requests++;
      const respond = (delta, finish) => {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        const frame = (value) => response.write(`data: ${JSON.stringify({ id: 'local', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [value] })}\n\n`);
        frame({ index: 0, delta: { role: 'assistant', ...delta }, finish_reason: null });
        frame({ index: 0, delta: {}, finish_reason: finish });
        response.end('data: [DONE]\n\n');
      };
      if (JSON.stringify(payload.messages.at(-1)).includes('These are the last suggestions offered')) {
        sideRequests++;
        finishDetection = () => respond({ content: 'learn: The fixture proves idle delivery.\ntag: Heads up\nevidence: receipt.txt\nexplain: This note was generated after seven real Pi tool steps.' }, 'stop');
        if (settled) finishDetection();
      } else {
        const steps = payload.messages.filter((message) => message.role === 'tool').length;
        if (steps < 7) respond({ tool_calls: [{ index: 0, id: `read-${steps}`, type: 'function', function: { name: 'read', arguments: JSON.stringify({ path: receipt }) } }] }, 'tool_calls');
        else respond({ content: 'Fixture complete.' }, 'stop');
      }
    });
    try {
      server.listen(0, '127.0.0.1'); await once(server, 'listening');
      const port = server.address().port;
      writeFileSync(join(agentDir, 'models.json'), JSON.stringify({ providers: { localfixture: { baseUrl: `http://127.0.0.1:${port}/v1`, api: 'openai-completions', apiKey: 'local-only', models: [{ id: 'fixture', contextWindow: 128000, maxTokens: 1024 }] } } }));
      const activity = join(root, 'parent-artifacts', layout === 'nested-child' ? 'subagent-activity/child.json' : 'subagent-activity-child.json');
      const environment = { ...process.env, PI_CODING_AGENT_DIR: agentDir };
      if (layout !== 'parent') { environment.PI_SUBAGENT_ACTIVITY_FILE = activity; environment.PI_SUBAGENT_NAME = 'fixture-child'; }
      else { delete environment.PI_SUBAGENT_ACTIVITY_FILE; delete environment.PI_SUBAGENT_NAME; }
      const checked = new Promise((resolve, reject) => {
        watcher = watch(logDir, () => {
          const entries = readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
          const check = entries.find((entry) => entry.event === 'check');
          if (check) resolve(check);
        });
        child = spawn('pi', ['--mode', 'rpc', '--offline', '--no-extensions', '-e', (process.env.YSK_TEST_SOURCE ?? fileURLToPath(new URL('../extensions/you-should-know/index.ts', import.meta.url))), '--provider', 'localfixture', '--model', 'fixture', '--thinking', 'off', '--session', join(root, 'session.jsonl')], {
          cwd: root, env: environment, stdio: ['pipe', 'pipe', 'pipe'], signal: AbortSignal.timeout(18_000),
        });
        child.on('error', reject);
        child.stderr.on('data', (data) => { stderr += data; });
        let buffer = '';
        child.stdout.on('data', (data) => {
          buffer += data;
          for (;;) {
            const at = buffer.indexOf('\n'); if (at < 0) break;
            const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
            let event; try { event = JSON.parse(line); } catch { continue; }
            events.push(event);
            if (event.type === 'extension_error') reject(new Error(JSON.stringify(event)));
            if (event.type === 'agent_settled') { settled = true; finishDetection?.(); }
            if (event.type === 'response' && event.success === false) reject(new Error(JSON.stringify(event)));
          }
        });
        child.stdin.write(JSON.stringify({ id: 'run', type: 'prompt', message: 'Read the fixture file seven times, then finish.' }) + '\n');
      });
      const check = await checked;
      assert.equal(check.step, 6);
      assert.equal(check.outcome, layout === 'parent' ? 'shown' : 'relayed', stderr);
      assert.equal(sideRequests, 1);
      assert.equal(requests, 9);
      assert.ok(settled, 'the side request must finish after the main agent settles');
      const notices = events.filter((event) => event.method === 'notify' && event.message?.includes('[ysk:'));
      if (layout === 'parent') assert.equal(notices.length, 1);
      else {
        assert.equal(notices.length, 0);
        const inbox = join(root, 'parent-artifacts/you-should-know-inbox');
        const files = readdirSync(inbox);
        assert.equal(files.length, 1);
        const note = JSON.parse(readFileSync(join(inbox, files[0]), 'utf8'));
        assert.equal(note.from, 'fixture-child');
        assert.equal(note.line, 'The fixture proves idle delivery.');
      }
    } finally {
      watcher?.close();
      if (child && child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited; }
      server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
      rmSync(root, { recursive: true, force: true });
    }
  });
}
