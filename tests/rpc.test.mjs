import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';

const extension = (process.env.YSK_TEST_SOURCE ?? fileURLToPath(new URL('../extensions/you-should-know/index.ts', import.meta.url)));
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'ysk-rpc-'));
  const agentDir = join(root, 'agent');
  const children = new Set();
  return {
    root, agentDir,
    state: () => JSON.parse(readFileSync(join(agentDir, 'you-should-know/state.json'), 'utf8')),
    async open(name = 'session') {
      const session = join(root, name + '.jsonl');
      try { writeFileSync(session, '', { flag: 'wx' }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
      const child = spawn('pi', ['--mode', 'rpc', '--offline', '--no-extensions', '-e', extension, '--session-dir', root, '--session', session], {
        cwd: root, env: { ...process.env, PI_CODING_AGENT_DIR: agentDir }, stdio: ['pipe', 'pipe', 'pipe'], signal: AbortSignal.timeout(15_000),
      });
      const exited = once(child, 'exit');
      let buffer = '', stderr = '', sequence = 0;
      const events = [], pending = new Map(), waiters = new Set();
      child.stderr.on('data', (data) => { stderr += data; });
      child.stdout.on('data', (data) => {
        buffer += data;
        for (;;) {
          const at = buffer.indexOf('\n'); if (at < 0) break;
          const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
          let event; try { event = JSON.parse(line); } catch { continue; }
          events.push(event);
          for (const waiter of waiters) if (waiter.predicate(event)) { waiters.delete(waiter); waiter.resolve(event); }
          if (event.type === 'response') pending.get(event.id)?.(event);
        }
      });
      const send = async (record) => {
        const id = String(++sequence);
        const response = await new Promise((resolve, reject) => {
          pending.set(id, resolve);
          child.once('error', reject);
          child.stdin.write(JSON.stringify({ ...record, id }) + '\n');
        });
        pending.delete(id);
        assert.equal(response.success, true, response.error ?? stderr);
        return response.data;
      };
      const client = {
        events, send,
        waitFor(predicate) {
          const found = events.find(predicate);
          if (found) return Promise.resolve(found);
          return new Promise((resolve, reject) => { waiters.add({predicate, resolve}); child.once("error", reject); child.once("exit", () => reject(new Error("Pi exited before the expected event"))); });
        },
        command: (message) => send({ type: 'prompt', message }),
        async close() { child.kill('SIGTERM'); await exited; children.delete(client); },
      };
      children.add(client);
      client.session = await send({ type: 'get_state' });
      return client;
    },
    async close() { for (const child of children) await child.close(); rmSync(root, { recursive: true, force: true }); },
  };
}
const testNoteId = async (client) => {
  await client.command('/ysk test');
  const note = client.events.findLast((event) => event.method === 'notify' && event.message?.includes('[ysk:'));
  assert.ok(note, 'Pi must emit the note through RPC');
  return note.message.match(/\[ysk:([^\]]+)\]/)[1];
};

test('Knew and Undo survive real Pi process restarts', async () => {
  const f = fixture();
  try {
    let client = await f.open();
    const id = await testNoteId(client);
    await client.close(); client = await f.open();
    await client.command(`/ysk answer ${id} knew`);
    assert.ok(f.state().known.includes('This is a test note from /ysk test.'));
    await client.close(); client = await f.open();
    await client.command(`/ysk answer ${id} undo`);
    assert.ok(!f.state().known.includes('This is a test note from /ysk test.'));
  } finally { await f.close(); }
});

test('a stale Pi process cannot erase another session’s Knew or resurrect its Undo', async () => {
  const f = fixture();
  try {
    const stale = await f.open('stale');
    const writer = await f.open('writer');
    const id = await testNoteId(writer);
    await writer.command(`/ysk answer ${id} knew`);
    await stale.command('/ysk off');
    assert.ok(f.state().known.includes('This is a test note from /ysk test.'));
    await writer.command(`/ysk answer ${id} undo`);
    await stale.command('/ysk on');
    assert.ok(!f.state().known.includes('This is a test note from /ysk test.'));
  } finally { await f.close(); }
});

test('an idle parent persists a relayed note before its next turn and keeps it after restart', async () => {
  const f = fixture();
  try {
    let parent = await f.open();
    const delivered = parent.waitFor(event => event.type === "message_end" && event.message?.customType === "you-should-know");
    const inbox = join(f.root, 'artifacts', parent.session.sessionId, 'you-should-know-inbox');
    mkdirSync(inbox, { recursive: true });
    writeFileSync(join(inbox, 'child-note.json'), JSON.stringify({ line: 'The child found a migration problem.', tag: 'Heads up', from: 'child' }));
    await delivered;
    await parent.close(); parent = await f.open();
    const { messages } = await parent.send({ type: 'get_messages' });
    assert.equal(messages.filter((message) => message.role === 'custom' && message.customType === 'you-should-know' && message.content.includes('migration problem')).length, 1);
    assert.equal(parent.events.filter((event) => event.type === 'agent_start').length, 0);
  } finally { await f.close(); }
});
