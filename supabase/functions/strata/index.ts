// Strata relay · one Supabase Edge Function, named "strata".
// - signup:  creates an account from an invitation code (public sign-ups can stay off)
// - claude:  calls Claude with the server key and counts what each friend spends against their credit
// - invite, me, friends, topup, approve, decline: invitations and credit. Credit is always paid by the server key.
//   Invitations from the admin come with credit; credit offered in a friend's invitation waits for the admin's approval.
//   No user's own Claude key is ever stored here.
// Secrets: ANTHROPIC_API_KEY (set in Edge Functions → Secrets). SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided by Supabase.
// Settings: turn OFF "Enforce JWT verification" for this function — it checks the user itself.
import { createClient } from 'npm:@supabase/supabase-js@2';

const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
const ANTHROPIC_KEY = Deno.env.get('ANTHROPIC_API_KEY') || '';

const MODELS = ['claude-sonnet-5-5', 'claude-sonnet-4-6'];
// US dollars per million tokens [input, output]. Check claude.com/pricing if Anthropic changes them.
const PRICE: Record<string, number[]> = { 'claude-sonnet-5-5': [2, 10], 'claude-sonnet-4-6': [3, 15], 'claude-haiku-4-5': [1, 5], 'claude-haiku-4-5-20251001': [1, 5] };
// The short identification with web search reads long web pages: the cheaper model does it, the main one takes over if it is unavailable
const ID_MODELS = ['claude-haiku-4-5-20251001', 'claude-sonnet-5-5'];

// Cost of one Claude answer, in millionths of a dollar, from its usage block
function costOf(model: string, u: any) {
  const p = PRICE[model] || [3, 15];
  const searches = (u.server_tool_use && u.server_tool_use.web_search_requests) || 0;
  const inTok = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
  return { inTok, outTok: u.output_tokens || 0, searches, cost: Math.ceil(inTok * p[0] + (u.output_tokens || 0) * p[1] + searches * SEARCH_MICRO) };
}
const tag = (f: any) => String(f || '').replace(/[^a-z0-9_]/gi, '').slice(0, 24) || null;
const SEARCH_MICRO = 10000;            // web search: $10 per 1,000 searches
const ADMIN_INVITE_CENTS = 200;        // $2 offered with each invitation sent by the admin
const MAX_TOPUP_CENTS = 2000;
const MAX_OFFER_CENTS = 2000;
const MAX_FRIEND_OFFER_CENTS = 500;   // what a friend may ask the admin to offer

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...CORS, 'content-type': 'application/json' } });
declare const EdgeRuntime: any;
// One Claude call with the server key (newest model first), its cost charged and recorded
async function claudeCall(payload: any, models: string[] = MODELS) {
  let res: Response | null = null, data: any = null, model = '';
  const t0 = Date.now();
  for (const m of models) {
    model = m;
    res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ ...payload, model: m }),
    });
    data = await res.json().catch(() => ({}));
    const msg = (data && data.error && data.error.message) || '';
    if (res.status === 404 || (res.status === 400 && /model/i.test(msg) && /not.*found|invalid/i.test(msg))) continue;
    break;
  }
  return { res, data, model, ms: Date.now() - t0 };
}
async function charge(uid: string, model: string, usage: any, feature: string, scan: string | null, ms: number, via: string) {
  const c = costOf(model, usage);
  const { data: leftAfter } = await db.rpc('strata_spend', { p_uid: uid, p_micro: c.cost });
  await db.from('usage').insert({ user_id: uid, model, input_tokens: c.inTok, output_tokens: c.outTok, searches: c.searches, cost_micro: c.cost, feature, scan_id: scan, ms, via });
  return { cost: c.cost, left: leftAfter };
}
function textOf(data: any) {
  const blocks = (data && data.content) || []; let last = -1;
  blocks.forEach((b: any, k: number) => { if (b.type === 'web_search_tool_result' || b.type === 'server_tool_use') last = k; });
  return blocks.slice(last + 1).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('');
}
function parseJSON(t: string) {
  try { return JSON.parse(t); } catch { /* next */ }
  const f = t.match(/```(?:json)?\s*([\s\S]*?)```/); if (f) { try { return JSON.parse(f[1]); } catch { /* next */ } }
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch { /* next */ } }
  return null;
}
function callError(res: Response | null, data: any) {
  const msg = (data && data.error && data.error.message) || '';
  if (!res) return 'network';
  if (res.status === 429 || res.status === 529) return 'rate_limited';
  if (/credit/i.test(msg)) return 'no_credit';
  return 'upstream_error';
}
// Give back what a failed scan cost: its calls are marked refunded and taken off the user's spending
async function refundScan(uid: string, scan: string) {
  const { data: rows } = await db.from('usage').select('id, cost_micro').eq('user_id', uid).eq('scan_id', scan).eq('refunded', false);
  const total = (rows || []).reduce((x: number, r: any) => x + (Number(r.cost_micro) || 0), 0);
  if (total > 0) {
    await db.rpc('strata_spend', { p_uid: uid, p_micro: -total });
    await db.from('usage').update({ refunded: true }).in('id', (rows || []).map((r: any) => r.id));
  }
  await db.from('scan_jobs').update({ refunded: true }).eq('id', scan).eq('user_id', uid);
}
const jobSet = (id: string, uid: string, v: any) => db.from('scan_jobs').update({ ...v, updated_at: new Date().toISOString() }).eq('id', id).eq('user_id', uid);
// The whole scan on the server, so it finishes even if the phone goes to sleep:
// pass 1 without web search; if Claude is unsure, pass 2 with one web search; a failed answer is retried once without search
async function runScanJob(uid: string, prof: any, j: any) {
  const id = j.id, kind = j.kind, t0 = Date.now();
  const content = (text: string) => j.image ? [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: j.image } }, { type: 'text', text }] : text;
  const maxTok = Math.min(Number(j.max_tokens) || 6000, 6000);
  const stillOn = async () => { const { data } = await db.from('scan_jobs').select('status').eq('id', id).maybeSingle(); return data && data.status === 'running'; };
  const budgetOk = async () => { if (prof.is_admin) return true; const { data } = await db.from('profiles').select('budget_cents, spent_micro').eq('user_id', uid).maybeSingle(); return !!data && data.budget_cents * 10000 - data.spent_micro > 0; };
  try {
    await jobSet(id, uid, { stage: 'recog' });
    let d1: any = null;
    if (j.search) {
      const r1 = await claudeCall({ max_tokens: maxTok, messages: [{ role: 'user', content: content(j.prompt + (j.note || '')) }] });
      if (r1.res && r1.res.ok && r1.data && r1.data.usage) {
        await charge(uid, r1.model, r1.data.usage, kind + '_pass1', id, r1.ms, 'server');
        d1 = parseJSON(textOf(r1.data));
        const nature = Array.isArray(j.nature) ? j.nature : [];
        if (d1 && d1.identified !== false && (d1.confidence === 'high' || (j.trusted && d1.confidence !== 'low') || nature.indexOf(d1.category) >= 0)) {
          await jobSet(id, uid, { status: 'done', stage: 'write', result: d1 }); return;
        }
      } else if (r1.res && (r1.res.status === 429 || r1.res.status === 529 || r1.res.status >= 500)) { /* go on to pass 2 */ }
      if (!(await stillOn())) return;
      if (!(await budgetOk())) { await jobSet(id, uid, { status: 'error', error: 'no_budget' }); return; }
      await jobSet(id, uid, { stage: 'search' });
      // Unsure: a short identification with one web search, instead of rewriting every card with search results.
      // If it confirms the first guess, the cards already written are kept; otherwise they are rewritten for the right work, without search.
      if (d1 && d1.title) {
        const ask = (j.image ? 'Identify the work in this photo.' : 'Identify this work: ' + j.prompt.slice(-400)) +
          ' A first look suggested: "' + d1.title + '"' + (d1.creator ? ' by ' + d1.creator : '') + (d1.date ? ' (' + d1.date + ')' : '') + '.' +
          ' Use the web_search tool once to check it. Reply with only JSON: {"first_guess_correct": true or false, "identified": true or false, "title": "exact title of the work, building, book or species", "creator": "artist, architect, author, or scientific name", "date": "year or period", "confidence": "high", "medium" or "low"}';
        const idPayload = { max_tokens: 700, tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 1 }], messages: [{ role: 'user', content: content(ask) }] };
        let ri = await claudeCall(idPayload, ID_MODELS);
        if (!(ri.res && ri.res.ok) && ri.model !== MODELS[0]) ri = await claudeCall(idPayload, MODELS);   // the cheaper model refused: the main one does it
        if (ri.res && ri.res.ok && ri.data && ri.data.usage) {
          await charge(uid, ri.model, ri.data.usage, kind + '_identify', id, ri.ms, 'server');
          const idf = parseJSON(textOf(ri.data));
          if (idf && (idf.first_guess_correct === true || idf.identified === false)) {
            // confirmed (or still unknown: the first answer already tells its style and context)
            if (idf.first_guess_correct === true) d1.confidence = 'high';
            await jobSet(id, uid, { status: 'done', stage: 'write', result: d1 }); return;
          }
          if (idf && idf.identified !== false && idf.title) {
            if (!(await stillOn()) || !(await budgetOk())) { if (!(await budgetOk())) await jobSet(id, uid, { status: 'error', error: 'no_budget' }); return; }
            await jobSet(id, uid, { stage: 'write' });
            const known = '\n\nA web search identified this work as: "' + idf.title + '"' + (idf.creator ? ' by ' + idf.creator : '') + (idf.date ? ' (' + idf.date + ')' : '') +
              '. Write about this work. Set "identified" to true and "confidence" to "high".';
            const rw = await claudeCall({ max_tokens: maxTok, messages: [{ role: 'user', content: content(j.prompt + known) }] });
            if (rw.res && rw.res.ok && rw.data && rw.data.usage) {
              await charge(uid, rw.model, rw.data.usage, kind + '_rewrite', id, rw.ms, 'server');
              const d2 = parseJSON(textOf(rw.data));
              if (d2 && d2.title) { await jobSet(id, uid, { status: 'done', stage: 'write', result: d2 }); return; }
            }
          }
        }
        // the identification could not settle it: the full search pass below, as before
        if (!(await stillOn())) return;
        if (Date.now() - t0 > 75000) { await jobSet(id, uid, { status: 'done', stage: 'write', result: d1 }); return; }
      }
    }
    let withSearch = !!j.search;
    for (let attempt = 0; attempt < 2; attempt++) {
      const payload: any = { max_tokens: maxTok, messages: [{ role: 'user', content: content(j.prompt) }] };
      if (withSearch) payload.tools = [{ type: 'web_search_20250305', name: 'web_search', max_uses: 1 }];
      const r = await claudeCall(payload);
      if (r.res && r.res.ok && r.data && r.data.usage) {
        await charge(uid, r.model, r.data.usage, kind + (withSearch ? '_search' : '_nosearch'), id, r.ms, 'server');
        const d = parseJSON(textOf(r.data));
        if (d && d.title) { await jobSet(id, uid, { status: 'done', stage: 'write', result: d }); return; }
      } else if (r.res && r.res.status === 400 && withSearch) { withSearch = false; continue; }
      // one more try without web search, only if there is time left before the server stops this run
      if (attempt === 0 && Date.now() - t0 < 95000 && (await stillOn()) && (await budgetOk())) { withSearch = false; continue; }
      await jobSet(id, uid, { status: 'error', error: r.res && r.res.ok ? 'invalid_json' : callError(r.res, r.data) });
      await refundScan(uid, id); return;
    }
  } catch (e) {
    await jobSet(id, uid, { status: 'error', error: 'upstream_error' });
    await refundScan(uid, id);
  }
}
// A scan still "running" long after the server's time limit was stopped by the platform: it failed, and is refunded
async function settleStale(uid: string, jobs: any[]) {
  for (const j of jobs) {
    if (j.status === 'running' && Date.now() - new Date(j.updated_at).getTime() > 180000) {
      j.status = 'error'; j.error = 'timeout';
      await jobSet(j.id, uid, { status: 'error', error: 'timeout' }); await refundScan(uid, j.id);
    }
  }
  return jobs;
}
const jobView = (j: any, withImage = false) => ({ id: j.id, status: j.status, stage: j.stage, kind: j.kind, error: j.error, result: j.status === 'done' ? j.result : null,
  image: withImage ? j.image : undefined, consumed: j.consumed, created_at: j.created_at });

const remaining = (p: any) => p.is_admin ? null : p.budget_cents * 10000 - p.spent_micro;

function newCode() {
  const a = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let s = '';
  for (const b of crypto.getRandomValues(new Uint8Array(8))) s += a[b % a.length];
  return s;
}
async function getUser(req: Request) {
  const tok = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!tok || tok.startsWith('sb_')) return null;
  const { data } = await db.auth.getUser(tok);
  return data && data.user || null;
}
async function getProfile(user: any) {
  const { data } = await db.from('profiles').select('*').eq('user_id', user.id).maybeSingle();
  if (data) return data;
  const row = { user_id: user.id, name: (user.user_metadata && user.user_metadata.name) || '', budget_cents: 0 };
  await db.from('profiles').insert(row);
  return { ...row, spent_micro: 0, is_admin: false, invited_by: null };
}
const clampCents = (v: any, d: number, max = MAX_OFFER_CENTS) => Math.max(0, Math.min(Number.isFinite(Number(v)) ? Math.round(Number(v)) : d, max));
async function adminName() {
  const { data } = await db.from('profiles').select('name').eq('is_admin', true).limit(1).maybeSingle();
  return (data && data.name || '').split(/\s+/)[0];
}
async function nameOf(uid: string | null) {
  if (!uid) return '';
  const { data } = await db.from('profiles').select('name').eq('user_id', uid).maybeSingle();
  return (data && data.name || '').split(/\s+/)[0];
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'method' }, 405);
  let body: any;
  try { body = await req.json(); } catch { return json({ error: 'bad_request' }, 400); }
  const action = body && body.action;

  // ── public: look at an invitation, create an account from it ──
  if (action === 'check_invite') {
    const { data: inv } = await db.from('invites').select('*').eq('code', String(body.code || '').toUpperCase()).maybeSingle();
    if (!inv || inv.used_by) return json({ ok: false });
    return json({ ok: true, from: await nameOf(inv.created_by), credit_cents: inv.credit_cents, needs_approval: inv.credit_cents > 0 && !inv.server_paid, approver: await adminName() });
  }
  if (action === 'signup') {
    const code = String(body.code || '').toUpperCase(), email = String(body.email || '').trim().toLowerCase();
    const password = String(body.password || ''), name = String(body.name || '').trim().slice(0, 60), lang = String(body.lang || 'en').slice(0, 5);
    if (!name || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || password.length < 6) return json({ error: 'invalid_fields' }, 400);
    const { data: inv } = await db.from('invites').select('*').eq('code', code).maybeSingle();
    if (!inv || inv.used_by) return json({ error: 'invite_invalid' }, 400);
    const now = new Date().toISOString();
    const { data: created, error } = await db.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { name, profile_updated_at: now } });
    if (error || !created.user) return json({ error: /already|registered|exists/i.test(error && error.message || '') ? 'email_taken' : 'signup_failed', message: error && error.message }, 400);
    const { data: claimed } = await db.from('invites').update({ used_by: created.user.id, used_at: now }).eq('code', code).is('used_by', null).select();
    if (!claimed || !claimed.length) { await db.auth.admin.deleteUser(created.user.id); return json({ error: 'invite_invalid' }, 400); }
    const approved = !!inv.server_paid;
    await db.from('profiles').insert({ user_id: created.user.id, name, lang, invited_by: inv.created_by, server_paid: approved || inv.credit_cents > 0,
      budget_cents: approved ? inv.credit_cents : 0, requested_cents: approved ? 0 : inv.credit_cents });
    return json({ ok: true, credit_cents: approved ? inv.credit_cents : 0, requested_cents: approved ? 0 : inv.credit_cents });
  }

  // ── signed-in users ──
  const user = await getUser(req);
  if (!user) return json({ error: 'signed_out' }, 401);
  const prof: any = await getProfile(user);

  if (action === 'me') {
    const { count: friends } = prof.is_admin
      ? await db.from('profiles').select('user_id', { count: 'exact', head: true }).eq('is_admin', false)
      : await db.from('profiles').select('user_id', { count: 'exact', head: true }).eq('invited_by', user.id);
    const { count: pending } = prof.is_admin ? await db.from('profiles').select('user_id', { count: 'exact', head: true }).gt('requested_cents', 0) : { count: 0 };
    const admin = await adminName();
    return json({ name: prof.name, is_admin: prof.is_admin, budget_cents: prof.budget_cents, spent_micro: prof.spent_micro, remaining_micro: remaining(prof),
      requested_cents: prof.requested_cents || 0, inviter: await nameOf(prof.invited_by), payer: prof.server_paid ? admin : '', approver: admin, friends: friends || 0, pending: pending || 0 });
  }

  // Calls made with the user's own Claude key: recorded to measure speed and cost, never charged to any credit
  if (action === 'log') {
    const u = body.usage || {}, model = String(body.model || '').slice(0, 40);
    const c = costOf(model, u);
    await db.from('usage').insert({ user_id: user.id, model, input_tokens: c.inTok, output_tokens: c.outTok, searches: c.searches, cost_micro: c.cost,
      feature: tag(body.feature), scan_id: tag(body.scan), ms: Math.max(0, Math.min(Number(body.ms) || 0, 600000)), via: 'own' });
    return json({ ok: true });
  }

  // Real time of a scan, measured on the phone from the scan to the result page on screen
  if (action === 'scan_time') {
    await db.from('usage').insert({ user_id: user.id, model: null, input_tokens: 0, output_tokens: 0, searches: 0, cost_micro: 0,
      feature: 'scan_total', scan_id: tag(body.scan), ms: Math.max(0, Math.min(Number(body.ms) || 0, 600000)), via: 'phone' });
    return json({ ok: true });
  }

  // ── Scans run on the server: start one, follow it, collect the finished ones ──
  if (action === 'scan_start') {
    const left = remaining(prof);
    if (left !== null && left <= 0) return json({ error: prof.requested_cents > 0 ? 'pending_approval' : 'no_budget' }, 402);
    if (!ANTHROPIC_KEY) return json({ error: 'relay_not_configured' }, 500);
    const id = tag(body.scan);
    if (!id || typeof body.prompt !== 'string') return json({ error: 'bad_request' }, 400);
    const image = typeof body.image === 'string' && body.image.length < 4000000 ? body.image : null;
    const kind = image ? 'scan' : 'text';
    const { error } = await db.from('scan_jobs').insert({ id, user_id: user.id, status: 'running', stage: 'prepared', kind, image });
    if (error) return json({ error: 'job_failed', message: error.message }, 500);
    const j = { id, kind, image, prompt: body.prompt, note: String(body.note || ''), search: body.search !== false, trusted: !!body.trusted,
      nature: Array.isArray(body.nature) ? body.nature : [], max_tokens: body.max_tokens };
    EdgeRuntime.waitUntil(runScanJob(user.id, prof, j));
    return json({ ok: true, id });
  }
  if (action === 'scan_status') {
    const { data: j } = await db.from('scan_jobs').select('*').eq('id', tag(body.scan)).eq('user_id', user.id).maybeSingle();
    if (!j) return json({ error: 'not_found' }, 404);
    await settleStale(user.id, [j]);
    return json(jobView(j));
  }
  // Scans finished (or still running) that the phone has not collected yet, e.g. after the app was closed
  if (action === 'scan_pending') {
    const { data: jobs } = await db.from('scan_jobs').select('*').eq('user_id', user.id).eq('consumed', false)
      .gte('created_at', new Date(Date.now() - 7 * 86400000).toISOString()).order('created_at', { ascending: true });
    const list = await settleStale(user.id, jobs || []);
    return json({ jobs: list.filter((j: any) => j.status === 'done' || j.status === 'running').map((j: any) => jobView(j, true)) });
  }
  // The phone has the result: the job is closed and its copy of the photo deleted
  if (action === 'scan_ack') {
    await db.from('scan_jobs').update({ consumed: true, image: null, updated_at: new Date().toISOString() }).eq('id', tag(body.scan)).eq('user_id', user.id);
    return json({ ok: true });
  }
  if (action === 'scan_cancel') {
    await db.from('scan_jobs').update({ status: 'cancelled', consumed: true, image: null, updated_at: new Date().toISOString() }).eq('id', tag(body.scan)).eq('user_id', user.id).eq('status', 'running');
    return json({ ok: true });
  }

  if (action === 'claude') {
    const left = remaining(prof);
    if (left !== null && left <= 0) return json({ error: prof.requested_cents > 0 ? 'pending_approval' : 'no_budget', remaining_micro: 0 }, 402);
    if (!ANTHROPIC_KEY) return json({ error: 'relay_not_configured' }, 500);
    const apiKey = ANTHROPIC_KEY;
    const b = body.body || {};
    const payload: any = { max_tokens: Math.min(Number(b.max_tokens) || 1000, 6000), messages: b.messages };
    if (b.system) payload.system = b.system;
    if (Array.isArray(b.tools)) payload.tools = b.tools.filter((t: any) => t && /^web_search/.test(t.type)).map((t: any) => ({ ...t, max_uses: Math.min(t.max_uses || 1, 3) }));
    if (!Array.isArray(payload.messages)) return json({ error: 'bad_request' }, 400);
    let res: Response | null = null, data: any = null, model = '';
    const t0 = Date.now();
    // small tasks may ask for the cheaper model; anything else uses the main one
    const models = b.model === 'claude-haiku-4-5-20251001' ? [b.model, ...MODELS] : MODELS;
    for (const m of models) {
      model = m;
      res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({ ...payload, model: m }),
      });
      data = await res.json().catch(() => ({}));
      const msg = (data && data.error && data.error.message) || '';
      if (res.status === 404 || (res.status === 400 && /model/i.test(msg) && /not.*found|invalid/i.test(msg))) continue;
      break;
    }
    if (res && res.ok && data && data.usage) {
      const c = costOf(model, data.usage);
      const { data: leftAfter } = await db.rpc('strata_spend', { p_uid: user.id, p_micro: c.cost });
      await db.from('usage').insert({ user_id: user.id, model, input_tokens: c.inTok, output_tokens: c.outTok, searches: c.searches, cost_micro: c.cost,
        feature: tag(body.feature), scan_id: tag(body.scan), ms: Date.now() - t0, via: 'relay' });
      data.strata = { remaining_micro: prof.is_admin ? null : leftAfter, cost_micro: c.cost };
    }
    return json(data, res ? res.status : 502);
  }

  // Admin dashboard: per user, scans per day, credit used, and the speed and cost of each scan (all its passes together)
  if (action === 'stats') {
    if (!prof.is_admin) return json({ error: 'forbidden' }, 403);
    const days = Math.max(0, Math.min(Number(body.days) || 0, 3650));
    let q = db.from('usage').select('user_id, at, feature, scan_id, ms, cost_micro, searches, refunded').order('at', { ascending: true }).limit(20000);
    if (days) q = q.gte('at', new Date(Date.now() - days * 86400000).toISOString());
    const { data: rows, error } = await q;
    if (error) return json({ error: 'stats_failed', message: error.message }, 500);
    const { data: profs } = await db.from('profiles').select('user_id, name, is_admin');
    const names: Record<string, string> = {};
    (profs || []).forEach((p: any) => { names[p.user_id] = p.name || '—'; });
    const day = (iso: string) => new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Europe/Madrid' });
    const pct = (a: number[], p: number) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)]; };
    const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
    const summary = (scans: any[]) => {
      const ms = scans.map((x) => x.real != null ? x.real : x.ms), cost = scans.map((x) => x.cost), mc = scans.map((x) => x.ms);
      const perDay: Record<string, number> = {}, acc: Record<string, number[]> = {};
      scans.forEach((x) => { perDay[x.day] = (perDay[x.day] || 0) + 1; const a = acc[x.day] || (acc[x.day] = [0, 0]); a[0] += x.real != null ? x.real : x.ms; a[1] += x.cost; });
      // average time and cost of the scans of each day, to follow the trend
      const perDayAvg: Record<string, any> = {};
      Object.keys(acc).forEach((d) => { perDayAvg[d] = { ms: Math.round(acc[d][0] / perDay[d]), cost_micro: Math.round(acc[d][1] / perDay[d]) }; });
      return { scans: scans.length, advanced: scans.filter((x) => x.advanced).length, simple: scans.filter((x) => !x.advanced).length, per_day: perDay, per_day_avg: perDayAvg,
        ms: { avg: scans.length ? Math.round(sum(ms) / scans.length) : null, min: ms.length ? Math.min(...ms) : null, max: ms.length ? Math.max(...ms) : null, p90: pct(ms, 0.9) },
        ms_claude: { avg: scans.length ? Math.round(sum(mc) / scans.length) : null, min: mc.length ? Math.min(...mc) : null, max: mc.length ? Math.max(...mc) : null, p90: pct(mc, 0.9) },
        cost_micro: { avg: scans.length ? Math.round(sum(cost) / scans.length) : null, min: cost.length ? Math.min(...cost) : null, max: cost.length ? Math.max(...cost) : null, p90: pct(cost, 0.9) } };
    };
    const users: Record<string, any> = {}, scansBy: Record<string, any> = {};
    for (const r of rows || []) {
      const u = users[r.user_id] || (users[r.user_id] = { id: r.user_id, name: names[r.user_id] || '—', credit_micro: 0, calls: 0 });
      const k = r.user_id + '|' + r.scan_id;
      if (r.feature === 'scan_total') { if (scansBy[k]) scansBy[k].real = Number(r.ms) || 0; continue; }
      u.calls++;
      if (!r.refunded) u.credit_micro += Number(r.cost_micro) || 0;
      if (!r.scan_id) continue;
      const sc = scansBy[k] || (scansBy[k] = { user: r.user_id, day: day(r.at), ms: 0, cost: 0, advanced: false, real: null });
      sc.ms += Number(r.ms) || 0; sc.cost += Number(r.cost_micro) || 0;
      if (!/pass1$/.test(r.feature || '')) sc.advanced = true;
    }
    const all = Object.values(scansBy);
    const list = Object.values(users).map((u: any) => ({ ...u, ...summary(all.filter((x: any) => x.user === u.id)) }))
      .sort((a: any, b: any) => b.scans - a.scans || b.credit_micro - a.credit_micro);
    const total = { name: 'Total', credit_micro: sum(list.map((u: any) => u.credit_micro)), calls: (rows || []).filter((r: any) => r.feature !== 'scan_total').length, ...summary(all) };
    return json({ days, total, users: list });
  }

  if (action === 'invite') {
    const credit = prof.is_admin ? clampCents(body.credit_cents, ADMIN_INVITE_CENTS) : clampCents(body.credit_cents, ADMIN_INVITE_CENTS, MAX_FRIEND_OFFER_CENTS);
    const server_paid = prof.is_admin && credit > 0;
    for (let i = 0; i < 4; i++) {
      const code = newCode();
      const { error } = await db.from('invites').insert({ code, created_by: user.id, credit_cents: credit, server_paid });
      if (!error) return json({ code, credit_cents: credit, needs_approval: credit > 0 && !server_paid, approver: await adminName() });
    }
    return json({ error: 'invite_failed' }, 500);
  }

  // People I invited (everyone, for the admin), with their credit and any request waiting for approval
  if (action === 'friends') {
    const q = db.from('profiles').select('*').eq('is_admin', false).order('created_at', { ascending: false });
    const { data: rows } = prof.is_admin ? await q : await q.eq('invited_by', user.id);
    const emails: Record<string, string> = {};
    if (prof.is_admin) {
      const { data: list } = await db.auth.admin.listUsers({ page: 1, perPage: 1000 });
      ((list && list.users) || []).forEach((u: any) => { emails[u.id] = u.email; });
    }
    const names: Record<string, string> = {};
    for (const r of rows || []) if (r.invited_by && !(r.invited_by in names)) names[r.invited_by] = await nameOf(r.invited_by);
    const { count } = await db.from('invites').select('code', { count: 'exact', head: true }).eq('created_by', user.id).is('used_by', null);
    return json({ open_invites: count || 0, friends: (rows || []).map((r: any) => ({ id: r.user_id, name: r.name, email: emails[r.user_id] || '', budget_cents: r.budget_cents, spent_micro: r.spent_micro,
      requested_cents: r.requested_cents || 0, invited_by: names[r.invited_by] || '', created_at: r.created_at })) });
  }
  if (action === 'topup' || action === 'approve' || action === 'decline') {
    if (!prof.is_admin) return json({ error: 'forbidden' }, 403);
    const { data: row } = await db.from('profiles').select('budget_cents, requested_cents, is_admin').eq('user_id', body.user_id).maybeSingle();
    if (!row || row.is_admin) return json({ error: 'not_found' }, 404);
    let upd: any;
    if (action === 'topup') upd = { budget_cents: row.budget_cents + Math.max(1, Math.min(Number(body.cents) || 100, MAX_TOPUP_CENTS)), server_paid: true };
    else if (action === 'approve') upd = { budget_cents: row.budget_cents + (row.requested_cents || 0), requested_cents: 0, server_paid: true };
    else upd = { requested_cents: 0 };
    await db.from('profiles').update(upd).eq('user_id', body.user_id);
    return json({ ok: true, ...upd });
  }

  // Delete my account: photos, cloud journal, credit and usage, open invitations, then the account itself
  if (action === 'delete_account') {
    if (prof.is_admin) return json({ error: 'admin_cannot_delete' }, 403);
    const { data: files } = await db.storage.from('photos').list(user.id, { limit: 1000 });
    if (files && files.length) await db.storage.from('photos').remove(files.map((f: any) => user.id + '/' + f.name));
    await db.from('scans').delete().eq('user_id', user.id);
    await db.from('usage').delete().eq('user_id', user.id);
    await db.from('scan_jobs').delete().eq('user_id', user.id);
    await db.from('invites').delete().eq('created_by', user.id).is('used_by', null);
    await db.from('profiles').delete().eq('user_id', user.id);
    const { error } = await db.auth.admin.deleteUser(user.id);
    if (error) return json({ error: 'delete_failed', message: error.message }, 500);
    return json({ ok: true });
  }

  return json({ error: 'unknown_action' }, 400);
});
