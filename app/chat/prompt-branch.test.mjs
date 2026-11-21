import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

function load(files, globals = {}) {
  const ctx = vm.createContext({ tr: (text) => text, ...globals });
  for (const file of files) {
    vm.runInContext(readFileSync(new URL(`./public/${file}.js`, import.meta.url), 'utf8'), ctx, { filename: `${file}.js` });
  }
  return (expression) => vm.runInContext(expression, ctx);
}

const get = load(['view-chat']);
const targetOf = get('promptBranchTarget');
const create = get('createPromptBranch');
const text = (text) => ({ type: 'text', text });
const event = (seq, ...content) => ({ type: 'user/message', seq, surfaceOp: 'append', data: { source: { kind: 'user' }, content } });

test('fork request uses the exact inclusive predecessor, even seq zero', async () => {
  const requests = [];
  const Api = load(['api'], {
    crypto: { randomUUID: () => 'test-rpc' },
    fetch: async (url, options) => {
      requests.push([url, JSON.parse(options.body).payload.args]);
      return { ok: true, json: async () => ({ result: { ok: true, value: { sessionId: 'child' } } }) };
    },
  })('Api');
  const target = targetOf(event(1, text('one\n'), text('two')));
  assert.equal(target.editText, 'one\ntwo');
  assert.equal((await create(Api, 'source', target)).sessionId, 'child');
  await create(Api, 'source', targetOf(event(50, text('later'))));
  assert.deepEqual(requests, [
    ['/api/session/fork', { request: { sessionId: 'source', atSeq: 0 } }],
    ['/api/session/fork', { request: { sessionId: 'source', atSeq: 49 } }],
  ]);
});

test('seq-zero prompt creates a fresh session only in the verified source workspace', async () => {
  const calls = [];
  const api = { createSession: (...args) => { calls.push(args); return { sessionId: 'fresh' }; } };
  const target = targetOf(event(0, text('first')));
  const header = { cwd: '/original', agentPreset: 'preset' };
  for (const workspace of [null, { workspaceId: 'other', path: '/other' }]) {
    await assert.rejects(create(api, 'source', target, header, workspace), /workspace could not be verified/);
  }
  assert.deepEqual(calls, []);
  assert.equal((await create(api, 'source', target, header, { workspaceId: 'original', path: '/original' })).sessionId, 'fresh');
  assert.deepEqual(calls, [['original', 'preset']]);
});

test('attachments and other non-text parts permit skipping but never text-only resending', () => {
  for (const type of ['image', 'file', 'unknown']) {
    const target = targetOf(event(9, text('caption'), { type }));
    assert.equal(target.atSeq, 8);
    assert.equal(target.editText, null);
  }
});

test('only durable append-origin human prompts can be selected', () => {
  const prompt = event(12, text('hi'));
  for (const e of [
    { ...prompt, seq: -1 }, { ...prompt, seq: 1.5 }, { ...prompt, seq: undefined },
    { ...prompt, surfaceOp: { op: 'replace' } },
    { ...prompt, data: { source: { kind: 'agent-message' } } },
    { ...prompt, type: 'assistant/message' },
  ]) assert.equal(targetOf(e), null);
});

test('a rejected exact cut is not retried with a different boundary or workspace', async () => {
  const api = { forkSession: async () => { throw new Error('fork unavailable'); } };
  await assert.rejects(create(api, 'source', targetOf(event(7, text('edit')))), /fork unavailable/);
});

test('a fork stays in ordinary chat routing despite having a parent', async () => {
  const fork = { sessionId: 'fork', parentSessionId: 'source' };
  const subagent = { sessionId: 'sub', parentSessionId: 'source', origin: 'subagent' };
  const Store = load(['store'], {
    clearTimeout,
    document: { addEventListener() {} },
    window: { addEventListener() {} },
    Api: {
      listSessions: async () => ({ items: [fork, subagent] }),
      modelCatalog: async () => ({}),
      mux: { open: () => () => {} },
    },
  })('Store');
  await Store.start();
  assert.equal(Store.S.sessions.get('fork'), fork);
  assert.equal(Store.routeOf('fork'), '#/s/fork');
  assert.equal(Store.routeOf('sub'), '#/s/source/sub/sub');
});
