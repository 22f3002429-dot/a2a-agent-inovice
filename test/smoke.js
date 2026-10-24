// Run: MOCK_AI=1 DATA_DIR=/tmp/a2a-test node server.js &  then  node test/smoke.js
const B = process.env.BASE || 'http://localhost:8080';
const H = t => ({ Authorization: 'Bearer ' + t, 'A2A-Version': '1.0', 'Content-Type': 'application/a2a+json' });
const post = (p, t, b) => fetch(B + p, { method: 'POST', headers: H(t), body: b ? JSON.stringify(b) : undefined });
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };
(async () => {
  const card = await (await fetch(B + '/.well-known/agent-card.json')).json();
  ok(card.skills[0].id === 'invoice_action_agent', 'card');
  ok((await fetch(B + '/tasks')).status === 401, 'auth required');
  ok((await fetch(B + '/tasks', { headers: { Authorization: 'Bearer user-aaaa', 'A2A-Version': '0.3' } })).status === 400, 'version check');
  const pk = [1, 2].map(i => ({ packageId: 'p' + i, text: `Invoice ${i}. [DOC-${i}-A] [DOC-${i}-B] [DOC-${i}-C]` }));
  const msg = { messageId: 'm1', role: 'ROLE_USER', parts: [{ mediaType: 'application/vnd.ga5.invoice-claim-batch+json', data: { batchId: 'b1', policyRevision: 'r1', packages: pk } }] };
  const [a, b] = await Promise.all([post('/message:send', 'user-aaaa', { message: msg, configuration: { returnImmediately: true } }), post('/message:send', 'user-aaaa', { message: msg })]);
  const ta = (await a.json()).task, tb = (await b.json()).task;
  ok(ta.id === tb.id && ta.status.state === 'TASK_STATE_INPUT_REQUIRED', 'concurrent dedupe + input required');
  ok((await post('/message:send', 'user-aaaa', { message: { ...msg, parts: [] } })).status === 400, 'bad msg');
  const c = await post('/message:send', 'user-aaaa', { message: { ...msg, messageId: 'm1', parts: [{ ...msg.parts[0], data: { ...msg.parts[0].data, batchId: 'zz' } }] } });
  ok(c.status === 409, 'idempotency conflict');
  ok((await fetch(B + '/tasks/' + ta.id, { headers: H('user-bbbb') })).status === 404, 'isolation get');
  ok((await (await fetch(B + '/tasks', { headers: H('user-bbbb') })).json()).tasks.length === 0, 'isolation list');
  const props = ta.artifacts[0].parts[0].data.proposals;
  const res = { message: { messageId: 'r1', taskId: ta.id, contextId: ta.contextId, role: 'ROLE_USER', parts: [{ mediaType: 'application/vnd.ga5.invoice-action-results+json', data: { batchId: 'b1', results: props.map((p, i) => ({ packageId: p.packageId, actionId: p.actionId, action: p.action, outcome: i ? 'REJECTED' : 'ACCEPTED', receiptNonce: 'n' + i })) } }] } };
  const done = (await (await post('/message:send', 'user-aaaa', res)).json()).task;
  ok(done.status.state === 'TASK_STATE_COMPLETED' && done.artifacts[1].parts[0].data.executions.length === 1, 'completed w/ accepted-only receipts');
  ok((await post('/tasks/' + ta.id + ':cancel', 'user-aaaa')).status === 409, 'cancel after terminal = 409');
})();
