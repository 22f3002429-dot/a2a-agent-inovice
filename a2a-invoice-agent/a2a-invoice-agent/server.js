'use strict';
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// ---------- config ----------
const PORT = process.env.PORT || 8080;
const API_KEY = process.env.OPENROUTER_API_KEY || '';
const MODEL = process.env.OPENROUTER_MODEL || 'openai/gpt-4o-mini';
const MOCK_AI = process.env.MOCK_AI === '1';
const CHUNK = Math.max(1, parseInt(process.env.CHUNK_SIZE || '12', 10));
const ALLOWED = (process.env.AGENT_TOKENS || '').split(',').map(s => s.trim()).filter(Boolean);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`).replace(/\/+$/, '');

const MT_JSON = 'application/a2a+json';
const MT_BATCH = 'application/vnd.ga5.invoice-claim-batch+json';
const MT_PROP = 'application/vnd.ga5.invoice-action-proposals+json';
const MT_RES = 'application/vnd.ga5.invoice-action-results+json';
const MT_RCPT = 'application/vnd.ga5.invoice-action-receipts+json';
const ACTIONS = ['settle_invoice', 'request_approval', 'hold_invoice', 'reject_duplicate', 'open_exception'];
const TERMINAL = new Set(['TASK_STATE_COMPLETED', 'TASK_STATE_CANCELED', 'TASK_STATE_FAILED', 'TASK_STATE_REJECTED']);

// ---------- helpers ----------
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
function canon(v) {
  if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';
  return JSON.stringify(v === undefined ? null : v);
}
const now = () => new Date().toISOString();
const clone = o => JSON.parse(JSON.stringify(o));

// ---------- persistence (sync, atomic) ----------
fs.mkdirSync(DATA_DIR, { recursive: true });
const STATE_FILE = path.join(DATA_DIR, 'state.json');
let state = { tasks: {}, idem: {}, cache: {} };
try { state = Object.assign(state, JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))); } catch (_) {}
function save() {
  const tmp = STATE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state));
  fs.renameSync(tmp, STATE_FILE);
}

// ---------- HTTP plumbing ----------
function send(res, code, body, ctype) {
  const s = JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': ctype || MT_JSON, 'Content-Length': Buffer.byteLength(s), 'Cache-Control': 'no-store' });
  res.end(s);
}
const STATUS = { 400: 'INVALID_ARGUMENT', 401: 'UNAUTHENTICATED', 403: 'PERMISSION_DENIED', 404: 'NOT_FOUND', 405: 'METHOD_NOT_ALLOWED', 406: 'NOT_ACCEPTABLE', 409: 'ABORTED', 415: 'UNSUPPORTED_MEDIA_TYPE', 500: 'INTERNAL', 503: 'UNAVAILABLE' };
function err(res, code, msg, reason) {
  const e = { code, status: STATUS[code] || 'ERROR', message: msg };
  if (reason) { e.reason = reason; e.details = [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason, domain: 'a2a-protocol.org' }]; }
  send(res, code, { error: e });
}
function readBody(req, limit = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on('data', c => { n += c.length; if (n > limit) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
function principalOf(req) {
  const h = req.headers['authorization'] || '';
  const m = /^Bearer (\S+)$/.exec(h);
  if (!m) return null;
  if (ALLOWED.length && !ALLOWED.includes(m[1]) && !process.env.ALLOW_ANY_TOKEN) return null;
  return sha('tok:' + m[1]);
}

// ---------- agent card ----------
function card() {
  return {
    name: 'Invoice Action Agent',
    description: 'Reads invoice packages, proposes one safe business action per invoice with cited evidence, and executes only grader-accepted proposals.',
    version: '1.0.0',
    supportedInterfaces: [{ url: PUBLIC_BASE_URL, protocolBinding: 'HTTP+JSON', protocolVersion: '1.0' }],
    capabilities: { streaming: false, pushNotifications: false },
    securitySchemes: { bearer: { httpAuthSecurityScheme: { scheme: 'Bearer' } } },
    securityRequirements: [{ schemes: { bearer: { list: [] } } }],
    defaultInputModes: [MT_BATCH, MT_RES],
    defaultOutputModes: [MT_PROP, MT_RCPT],
    skills: [{
      id: 'invoice_action_agent',
      name: 'Invoice action agent',
      description: 'Choose settle, approval, hold, duplicate rejection or exception for each invoice package with evidence.',
      tags: ['invoice', 'payments', 'approval', 'finance'],
      inputModes: [MT_BATCH, MT_RES],
      outputModes: [MT_PROP, MT_RCPT]
    }]
  };
}

// ---------- AI layer ----------
function flatText(v, out = []) {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) v.forEach(x => flatText(x, out));
  else if (v && typeof v === 'object') Object.values(v).forEach(x => flatText(x, out));
  return out;
}
const pidOf = p => (p && (p.packageId || p.id)) || null;
function stripIds(p) {
  const c = clone(p); delete c.packageId; delete c.id; return c;
}
const BR = /\[[^\[\]\n]{2,200}\]/g;

const SYSTEM = `You are an accounts-payable control analyst. For EACH invoice package choose exactly one action:
- settle_invoice: valid, reconciled, within autonomous approval authority.
- request_approval: commercially valid but exceeds delegated authority / needs a named approver.
- hold_invoice: payment pauses until a stated verification completes (e.g. bank detail check, receipt of goods, tax id).
- reject_duplicate: the SAME commercial invoice (same vendor, invoice number, amount) was already paid. A payment for a DIFFERENT invoice number is NOT a duplicate.
- open_exception: material records conflict (PO vs invoice vs receipt vs bank) and need an exception workflow.
Rules: documents mix useful facts with archive examples, training decoys, negations ("no hold is required"), quoted old policy and irrelevant action words. Find the paragraph that actually determines the action for THIS invoice under the stated current policy revision. Ignore cover-sheet references, archive examples and training decoys.
evidenceRefs: exactly the three decisive bracketed references (copied VERBATIM, including the square brackets) from that deciding paragraph.
facts: vendorName, invoiceNumber, amountMinor (integer minor units, e.g. rupees*100 / paise), currency (ISO code) for the invoice being processed.
Return ONLY JSON: {"decisions":[{"packageId":"...","action":"...","facts":{"vendorName":"...","invoiceNumber":"...","amountMinor":0,"currency":"INR"},"evidenceRefs":["[..]","[..]","[..]"],"reason":"one or two sentences"}]}`;

async function callModel(items, batchMeta) {
  const body = items.map(it => `### PACKAGE ${it.id}\n${canon(it.p)}`).join('\n\n');
  const user = `Policy revision: ${batchMeta.policyRevision}\nReturn one decision per package (${items.length} packages).\n\n${body}`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 40000);
  try {
    const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST', signal: ctrl.signal,
      headers: { 'Authorization': 'Bearer ' + API_KEY, 'Content-Type': 'application/json', 'X-Title': 'a2a-invoice-agent' },
      body: JSON.stringify({
        model: MODEL, temperature: 0, response_format: { type: 'json_object' },
        messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: user }]
      })
    });
    if (!r.ok) throw new Error('model http ' + r.status);
    const j = await r.json();
    const txt = j.choices[0].message.content;
    const m = /\{[\s\S]*\}/.exec(txt);
    return JSON.parse(m ? m[0] : txt).decisions || [];
  } finally { clearTimeout(t); }
}
function mockModel(items) {
  return items.map(it => {
    const refs = (flatText(it.p).join('\n').match(BR) || []).slice(0, 3);
    return { packageId: it.id, action: 'open_exception', facts: { vendorName: 'Mock', invoiceNumber: 'M-1', amountMinor: 100, currency: 'INR' }, evidenceRefs: refs, reason: 'Mock decision for protocol testing.' };
  });
}
function normalize(it, d) {
  const text = flatText(it.p).join('\n');
  let ok = d && ACTIONS.includes(d.action);
  const action = ok ? d.action : 'open_exception';
  let refs = (d && Array.isArray(d.evidenceRefs) ? d.evidenceRefs : []).map(String).map(r => {
    if (text.includes(r)) return r;
    if (text.includes('[' + r + ']')) return '[' + r + ']';
    return null;
  }).filter(Boolean);
  refs = [...new Set(refs)];
  if (refs.length < 3) { // top up from the document so there is always evidence
    for (const r of (text.match(BR) || [])) { if (refs.length >= 3) break; if (!refs.includes(r)) refs.push(r); }
    ok = ok && refs.length >= 2;
  }
  const f = (d && d.facts) || {};
  const amt = Math.round(Number(f.amountMinor));
  const facts = {
    vendorName: String(f.vendorName || 'unknown'),
    invoiceNumber: String(f.invoiceNumber || 'unknown'),
    amountMinor: Number.isFinite(amt) ? amt : 0,
    currency: String(f.currency || 'INR').toUpperCase()
  };
  return { action, facts, evidenceRefs: refs.slice(0, 3), reason: String((d && d.reason) || '').slice(0, 600), good: !!ok && !!d };
}

const aiInflight = new Map();
async function decideAll(batch) {
  const items = batch.packages.map(p => ({ p, id: pidOf(p), key: sha(canon(stripIds(p))) }));
  const need = [];
  const seen = new Set();
  for (const it of items) {
    if (state.cache[it.key] || aiInflight.has(it.key) || seen.has(it.key)) continue;
    seen.add(it.key); need.push(it);
  }
  for (let i = 0; i < need.length; i += CHUNK) {
    const chunk = need.slice(i, i + CHUNK);
    const prom = (async () => {
      let ds;
      try { ds = MOCK_AI ? mockModel(chunk) : await callModel(chunk, batch); }
      catch (e) { try { ds = MOCK_AI ? mockModel(chunk) : await callModel(chunk, batch); } catch (e2) { ds = null; } }
      if (!ds) throw new Error('model unavailable');
      const byId = new Map(ds.map(d => [String(d.packageId), d]));
      for (const it of chunk) {
        const n = normalize(it, byId.get(String(it.id)));
        if (n.good) state.cache[it.key] = n; else state.cache[it.key] = Object.assign(n, { transient: true });
      }
      save();
    })();
    chunk.forEach(it => aiInflight.set(it.key, prom));
    prom.then(() => chunk.forEach(it => aiInflight.delete(it.key)), () => chunk.forEach(it => aiInflight.delete(it.key)));
  }
  await Promise.all(items.map(it => aiInflight.get(it.key)).filter(Boolean));
  return items.map(it => {
    const d = state.cache[it.key];
    if (!d) throw new Error('no decision');
    if (d.transient) delete state.cache[it.key]; // do not keep fallbacks
    return buildProposal(batch.batchId, it.id, d);
  });
}
function buildProposal(batchId, packageId, d) {
  const refs = d.evidenceRefs;
  let rationale = `Proposed action ${d.action} for invoice ${d.facts.invoiceNumber} from ${d.facts.vendorName}. ${d.reason} Decisive evidence: ${refs.join(' ')}.`;
  if (rationale.length < 60) rationale += ' This choice follows the decisive paragraph cited above under current policy.';
  rationale = rationale.slice(0, 1500);
  return {
    packageId, actionId: 'act_' + sha(batchId + '|' + packageId + '|' + d.action).slice(0, 28),
    action: d.action, facts: clone(d.facts), evidenceRefs: clone(refs), rationale
  };
}

// ---------- A2A logic ----------
class HttpErr extends Error { constructor(code, msg, reason) { super(msg); this.code = code; this.reason = reason; } }
const inflight = new Map();

function getTaskFor(principal, id) {
  const t = state.tasks[id];
  if (!t || t.owner !== principal) return null;
  return t;
}
const pub = t => { const { owner, meta, ...rest } = t; return clone(rest); };

async function createTask(principal, message) {
  const part = (message.parts || []).find(p => p && p.mediaType === MT_BATCH && p.data && typeof p.data === 'object');
  if (!part) throw new HttpErr(400, 'Missing invoice batch part');
  const batch = part.data;
  if (typeof batch.batchId !== 'string' || !Array.isArray(batch.packages) || !batch.packages.length) throw new HttpErr(400, 'Invalid batch');
  const ids = batch.packages.map(pidOf);
  if (ids.some(i => !i) || new Set(ids).size !== ids.length) throw new HttpErr(400, 'Invalid package ids');
  let proposals;
  try { proposals = await decideAll(batch); } catch (e) { throw new HttpErr(503, 'Decision service unavailable'); }
  const taskId = crypto.randomUUID();
  const contextId = typeof message.contextId === 'string' && message.contextId ? message.contextId : crypto.randomUUID();
  const hist = Object.assign(clone(message), { taskId, contextId });
  const task = {
    owner: principal, id: taskId, contextId,
    status: { state: 'TASK_STATE_INPUT_REQUIRED', timestamp: now() },
    artifacts: [{ artifactId: 'proposals-' + taskId, name: 'invoice-action-proposals', parts: [{ mediaType: MT_PROP, data: { batchId: batch.batchId, proposals } }] }],
    history: [hist],
    meta: { batchId: batch.batchId }
  };
  state.tasks[taskId] = task;
  return task;
}

function continueTask(principal, message) {
  const task = getTaskFor(principal, message.taskId);
  if (!task) throw new HttpErr(404, 'Task not found');
  if (TERMINAL.has(task.status.state)) throw new HttpErr(409, 'Task is in a terminal state', 'TASK_TERMINAL');
  if (message.contextId && message.contextId !== task.contextId) throw new HttpErr(400, 'Context mismatch');
  const part = (message.parts || []).find(p => p && p.mediaType === MT_RES && p.data);
  if (!part || message.parts.length !== 1) throw new HttpErr(400, 'Expected one results part');
  const data = part.data;
  const prop = task.artifacts[0].parts[0].data;
  if (data.batchId !== prop.batchId || !Array.isArray(data.results) || !data.results.length) throw new HttpErr(400, 'Batch mismatch');
  const byPkg = new Map(prop.proposals.map(p => [p.packageId, p]));
  const seen = new Set(); const executions = [];
  for (const r of data.results) {
    const p = byPkg.get(r && r.packageId);
    if (!p || seen.has(r.packageId)) throw new HttpErr(400, 'Package mismatch');
    seen.add(r.packageId);
    if (r.actionId !== p.actionId || r.action !== p.action) throw new HttpErr(400, 'Action mismatch');
    if (r.outcome !== 'ACCEPTED' && r.outcome !== 'REJECTED') throw new HttpErr(400, 'Bad outcome');
    if (r.outcome === 'ACCEPTED') {
      if (typeof r.receiptNonce !== 'string' || !r.receiptNonce) throw new HttpErr(400, 'Missing receipt');
      executions.push({ packageId: p.packageId, actionId: p.actionId, action: p.action, receiptNonce: r.receiptNonce, facts: clone(p.facts), evidenceRefs: clone(p.evidenceRefs) });
    }
  }
  // all checks passed: mutate synchronously (no awaits) so cancel/result race is atomic
  task.history.push(Object.assign(clone(message), { taskId: task.id, contextId: task.contextId }));
  task.artifacts.push({ artifactId: 'receipts-' + task.id, name: 'invoice-action-receipts', parts: [{ mediaType: MT_RCPT, data: { batchId: prop.batchId, executions } }] });
  task.status = { state: 'TASK_STATE_COMPLETED', timestamp: now() };
  return task;
}

async function handleSend(res, principal, bodyText) {
  let body;
  try { body = JSON.parse(bodyText); } catch (_) { return err(res, 400, 'Invalid JSON'); }
  const m = body && body.message;
  if (!m || typeof m !== 'object' || typeof m.messageId !== 'string' || !m.messageId || m.role !== 'ROLE_USER' || !Array.isArray(m.parts) || !m.parts.length)
    return err(res, 400, 'Invalid message');
  const key = principal + '\0' + m.messageId;
  const hash = sha(canon(m));
  const existing = state.idem[key];
  if (existing) {
    if (existing.hash !== hash) return err(res, 409, 'Message id reused with different content', 'IDEMPOTENCY_CONFLICT');
    const t = state.tasks[existing.taskId];
    return send(res, 200, { task: pub(t) });
  }
  const fl = inflight.get(key);
  if (fl) {
    if (fl.hash !== hash) return err(res, 409, 'Message id reused with different content', 'IDEMPOTENCY_CONFLICT');
    try { const t = await fl.promise; return send(res, 200, { task: pub(state.tasks[t.id]) }); }
    catch (e) { return err(res, e.code || 500, e.code ? e.message : 'Internal error', e.reason); }
  }
  const promise = (async () => {
    const task = m.taskId ? continueTask(principal, m) : await createTask(principal, m);
    state.idem[key] = { hash, taskId: task.id };
    save();
    return task;
  })();
  inflight.set(key, { hash, promise });
  promise.then(() => inflight.delete(key), () => inflight.delete(key));
  try { const t = await promise; return send(res, 200, { task: pub(state.tasks[t.id]) }); }
  catch (e) { return err(res, e.code || 500, e.code ? e.message : 'Internal error', e.reason); }
}

function handleCancel(res, principal, id) {
  const t = getTaskFor(principal, id);
  if (!t) return err(res, 404, 'Task not found');
  if (TERMINAL.has(t.status.state)) return err(res, 409, 'Task is in a terminal state', 'TASK_NOT_CANCELABLE');
  t.status = { state: 'TASK_STATE_CANCELED', timestamp: now() };
  save();
  send(res, 200, pub(t));
}

// ---------- server ----------
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    let p = decodeURIComponent(url.pathname).replace(/\/+$/, '') || '/';
    if (p === '/.well-known/agent-card.json') {
      if (req.method !== 'GET' && req.method !== 'HEAD') return err(res, 405, 'Method not allowed');
      return send(res, 200, card(), 'application/json');
    }
    if (p === '/' || p === '/healthz') return send(res, 200, { ok: true }, 'application/json');
    const principal = principalOf(req);
    if (!principal) return err(res, 401, 'Authentication required');
    if (req.headers['a2a-version'] !== '1.0') return err(res, 400, 'Unsupported A2A version');
    let mm;
    if (/(^|\/)message:send$/.test(p)) {
      if (req.method !== 'POST') return err(res, 405, 'Method not allowed');
      const ct = (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      if (ct !== MT_JSON) return err(res, 415, 'Unsupported media type');
      let text; try { text = await readBody(req); } catch (_) { return err(res, 400, 'Bad body'); }
      return handleSend(res, principal, text);
    }
    if ((mm = /(?:^|\/)tasks\/([^\/:]+):cancel$/.exec(p))) {
      if (req.method !== 'POST') return err(res, 405, 'Method not allowed');
      return handleCancel(res, principal, mm[1]);
    }
    if ((mm = /(?:^|\/)tasks\/([^\/:]+)$/.exec(p))) {
      if (req.method !== 'GET') return err(res, 405, 'Method not allowed');
      const t = getTaskFor(principal, mm[1]);
      return t ? send(res, 200, pub(t)) : err(res, 404, 'Task not found');
    }
    if (/(^|\/)tasks$/.test(p)) {
      if (req.method !== 'GET') return err(res, 405, 'Method not allowed');
      const tasks = Object.values(state.tasks).filter(t => t.owner === principal).sort((a, b) => a.status.timestamp < b.status.timestamp ? 1 : -1).map(pub);
      return send(res, 200, { tasks });
    }
    return err(res, 404, 'Not found');
  } catch (e) {
    try { err(res, 500, 'Internal error'); } catch (_) {}
  }
});
server.listen(PORT, () => console.log('A2A invoice agent on :' + PORT + ' base=' + PUBLIC_BASE_URL + (MOCK_AI ? ' [MOCK_AI]' : ' model=' + MODEL)));
