import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerHooks, syncBuiltinESMExports } from 'node:module';

const home = mkdtempSync(join(tmpdir(), 'ysk-test-'));
process.env.PI_CODING_AGENT_DIR = join(home, '.pi/agent');
after(() => rmSync(home, { recursive: true, force: true }));
const data = (source) => `data:text/javascript,${encodeURIComponent(source)}`;
registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'node:os') return { url: data(`export const homedir = () => ${JSON.stringify(home)}`), shortCircuit: true };
  if (specifier === '@earendil-works/pi-coding-agent') return { url: data('export class DynamicBorder {}; export const getMarkdownTheme = () => ({})'), shortCircuit: true };
  if (specifier === '@earendil-works/pi-tui') return { url: data('export class Container {}; export class Markdown {}; export class Text {}; export const matchesKey = () => false'), shortCircuit: true };
  return next(specifier, context);
}});
const { default: extension } = await import(process.env.YSK_TEST_SOURCE ?? '../extensions/you-should-know/index.ts');
function open(session, sessionDir = home) {
  const handlers = new Map();
  const notices = [];
  let command;
  extension({ on: (event, handler) => handlers.set(event, handler), registerCommand: (_, value) => { command = value.handler; }, registerShortcut() {} });
  const ctx = {
    mode: 'rpc', hasUI: false, isIdle: () => false,
    sessionManager: { getSessionDir: () => sessionDir, getSessionId: () => session },
    ui: { notify: (message) => notices.push(message) },
  };
  handlers.get('session_start')({}, ctx);
  return { notices, command: (text) => command(text, ctx), input: (text) => handlers.get('input')({ source: 'rpc', text }, ctx), close: () => handlers.get('session_shutdown')({}, ctx) };
}
const state = () => { const file = join(home, '.pi/agent/you-should-know/state.json'); return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { known: [], ignoredInARow: 0, skip: 0 }; };

function openDetection(lines) {
  const handlers = new Map();
  const notices = [];
  let command;
  const model = { provider: 'fixture', id: 'fixture', api: 'openai-completions' };
  extension({ on: (event, handler) => handlers.set(event, handler), registerCommand: (_, value) => { command = value.handler; }, registerShortcut() {} });
  const ctx = {
    mode: 'rpc', hasUI: true, isIdle: () => false, model,
    modelRegistry: {
      find: () => model,
      streamSimple: () => ({ result: async () => ({ content: [{ type: 'text', text: lines.shift() }], stopReason: 'stop', usage: {} }) }),
    },
    getSystemPrompt: () => '',
    sessionManager: { getSessionDir: () => home, getSessionId: () => 'unicode' },
    ui: { notify: (message) => notices.push(message) },
  };
  handlers.get('session_start')({}, ctx);
  return {
    notices,
    check: async (turnIndex) => {
      handlers.get('turn_end')({ turnIndex, context: { llmMessages: [] } }, ctx);
      const log = join(home, '.pi/agent/you-should-know/checks.jsonl');
      for (let i = 0; i < 100; i++) {
        if (existsSync(log) && readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).length >= turnIndex / 6) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(`check ${turnIndex} did not finish`);
    },
    answer: (text) => command(text, ctx),
    close: () => handlers.get('session_shutdown')({}, ctx),
  };
}

test('different Chinese notes keep distinct identities while repeats are suppressed', async () => {
  const directory = join(home, '.pi/agent/you-should-know');
  rmSync(directory, { recursive: true, force: true });
  const client = openDetection([
    'learn: 测试没有运行。\ntag: Heads up\nevidence: test\nexplain: 检查说明。',
    'learn: 部署目标是生产环境。\ntag: Heads up\nevidence: deploy\nexplain: 部署说明。',
    'learn: 部署目标是生产环境！\ntag: Heads up\nevidence: deploy\nexplain: 部署说明。',
    'learn: API超时会影响登录。\ntag: Heads up\nevidence: api\nexplain: 登录说明。',
    'learn: API密钥已过期。\ntag: Heads up\nevidence: api\nexplain: 密钥说明。',
    'learn: ＡＰＩ密钥已过期！\ntag: Heads up\nevidence: api\nexplain: 密钥说明。',
    'learn: API key expired.\ntag: Heads up\nevidence: api\nexplain: The key is no longer valid.',
    'learn: api-key expired!\ntag: Heads up\nevidence: api\nexplain: The key is no longer valid.',
  ]);
  try {
    await client.check(6);
    await client.check(12);
    await client.check(18);
    await client.check(24);
    await client.check(30);
    await client.check(36);
    await client.check(42);
    await client.check(48);
    assert.deepEqual(client.notices.filter((message) => message.includes('[ysk:')).length, 5);
    assert.ok(client.notices.some((message) => message.includes('测试没有运行。')));
    assert.ok(client.notices.some((message) => message.includes('部署目标是生产环境。')));
    assert.ok(client.notices.some((message) => message.includes('API超时会影响登录。')));
    assert.ok(client.notices.some((message) => message.includes('API密钥已过期。')));
    assert.ok(client.notices.some((message) => message.includes('API key expired.')));
    const outcomes = readFileSync(join(directory, 'checks.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line).outcome);
    assert.deepEqual(outcomes, ['shown', 'shown', 'deduped', 'shown', 'shown', 'deduped', 'shown', 'deduped']);
    const firstId = client.notices.find((message) => message.includes('[ysk:')).match(/\[ysk:([^\]]+)\]/)[1];
    await client.answer(`answer ${firstId} knew`);
    client.close();
    const stateFile = join(directory, 'state.json');
    const saved = JSON.parse(readFileSync(stateFile, 'utf8'));
    saved.seen = [];
    writeFileSync(stateFile, JSON.stringify(saved));
    writeFileSync(join(directory, 'checks.jsonl'), '');
    const knownClient = openDetection(['learn: 测试没有运行！\ntag: Heads up\nevidence: test\nexplain: 检查说明。']);
    try {
      await knownClient.check(6);
      assert.equal(knownClient.notices.filter((message) => message.includes('[ysk:')).length, 0);
      assert.equal(JSON.parse(readFileSync(join(directory, 'checks.jsonl'), 'utf8').trim()).outcome, 'deduped');
    } finally { knownClient.close(); }
  } finally { client.close(); }
});

test('symbol-only notes never dedupe on an empty normalized identity', async () => {
  const directory = join(home, '.pi/agent/you-should-know');
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'knowledge.jsonl'), JSON.stringify({ line: '🧨', known: true }) + '\n');
  const client = openDetection([
    'learn: 🎉\ntag: Heads up\nevidence: emoji\nexplain: Celebration note.',
    'learn: ⚠️\ntag: Heads up\nevidence: emoji\nexplain: Warning note.',
    'learn: 🎉\ntag: Heads up\nevidence: emoji\nexplain: Repeated celebration note.',
  ]);
  try {
    await client.check(6);
    await client.check(12);
    await client.check(18);
    const delivered = client.notices.filter((message) => message.includes('[ysk:'));
    assert.equal(delivered.length, 3);
    assert.ok(delivered.some((message) => message.includes('🎉')));
    assert.ok(delivered.some((message) => message.includes('⚠️')));
    const outcomes = readFileSync(join(directory, 'checks.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line).outcome);
    assert.deepEqual(outcomes, ['shown', 'shown', 'shown']);
    assert.deepEqual(state().known, [], 'empty normalized feedback identities are not loaded as known matches');
  } finally { client.close(); }
});

test('emoji notes with variation selectors do not share a mark-only identity', async () => {
  const directory = join(home, '.pi/agent/you-should-know');
  rmSync(directory, { recursive: true, force: true });
  const client = openDetection([
    'learn: ❤️\ntag: Heads up\nevidence: emoji\nexplain: Heart note.',
    'learn: ⚠️\ntag: Heads up\nevidence: emoji\nexplain: Warning note.',
  ]);
  try {
    await client.check(6);
    await client.check(12);
    const delivered = client.notices.filter((message) => message.includes('[ysk:'));
    assert.equal(delivered.length, 2);
    assert.ok(delivered.some((message) => message.includes('❤️')));
    assert.ok(delivered.some((message) => message.includes('⚠️')));
    const outcomes = readFileSync(join(directory, 'checks.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line).outcome);
    assert.deepEqual(outcomes, ['shown', 'shown']);
    const heartId = delivered.find((message) => message.includes('❤️')).match(/\[ysk:([^\]]+)\]/)[1];
    await client.answer(`answer ${heartId} knew`);
    client.close();
    const stateFile = join(directory, 'state.json');
    const saved = JSON.parse(readFileSync(stateFile, 'utf8'));
    saved.seen = [];
    writeFileSync(stateFile, JSON.stringify(saved));
    writeFileSync(join(directory, 'checks.jsonl'), '');
    const warningClient = openDetection(['learn: ⚠️\ntag: Heads up\nevidence: emoji\nexplain: Warning note.']);
    try {
      await warningClient.check(6);
      assert.ok(warningClient.notices.some((message) => message.includes('⚠️')));
      assert.equal(JSON.parse(readFileSync(join(directory, 'checks.jsonl'), 'utf8').trim()).outcome, 'shown');
    } finally { warningClient.close(); }
  } finally { client.close(); }
});

test('RPC prompts count ignored notes and back off, but ysk commands do not', async () => {
  const client = open('backoff');
  for (let i = 0; i < 3; i++) await client.command('test');
  client.input('/ysk status');
  client.input('first user prompt');
  await client.command('status');
  assert.match(client.notices.at(-1), /skip 0/);
  client.input('second user prompt');
  assert.equal(state().ignoredInARow, 3);
  assert.equal(state().skip, 1);
  client.close();
});

 test('a failed atomic replacement preserves the previous session notes', async () => {
  const client = open('interrupted-write');
  await client.command('test');
  const file = join(home, 'artifacts/interrupted-write/you-should-know.json');
  const before = readFileSync(file, 'utf8');
  const rename = fs.renameSync;
  try {
    fs.renameSync = (source, target) => { if (target === file) throw new Error('simulated interrupted replacement'); return rename(source, target); };
    syncBuiltinESMExports();
    await assert.rejects(client.command('test'), /simulated interrupted replacement/);
    assert.equal(readFileSync(file, 'utf8'), before);
    assert.equal(existsSync(file + '.tmp-' + process.pid), false);
  } finally { fs.renameSync = rename; syncBuiltinESMExports(); client.close(); }
});

test('temporary Pi discovery sessions do not create artifacts in the working directory', async () => {
  const cwd = process.cwd();
  process.chdir(home);
  try {
    const client = open('temporary-discovery', '');
    await client.command('test');
    client.close();
    assert.equal(existsSync(join(home, 'artifacts/temporary-discovery')), false);
  } finally { process.chdir(cwd); }
});
