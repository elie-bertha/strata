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
const PRICE: Record<string, number[]> = { 'claude-sonnet-5-5': [2, 10], 'claude-sonnet-4-6': [3, 15], 'claude-haiku-4-5': [1, 5] };

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
      feature: tag(body.feature), ms: Math.max(0, Math.min(Number(body.ms) || 0, 600000)), via: 'own' });
    return json({ ok: true });
  }

  if (action === 'claude') {
    const left = remaining(prof);
    if (left !== null && left <= 0) return json({ error: prof.requested_cents > 0 ? 'pending_approval' : 'no_budget', remaining_micro: 0 }, 402);
    if (!ANTHROPIC_KEY) return json({ error: 'relay_not_configured' }, 500);
    const apiKey = ANTHROPIC_KEY;
    const b = body.body || {};
    const payload: any = { max_tokens: Math.min(Number(b.max_tokens) || 1000, 4000), messages: b.messages };
    if (b.system) payload.system = b.system;
    if (Array.isArray(b.tools)) payload.tools = b.tools.filter((t: any) => t && /^web_search/.test(t.type)).map((t: any) => ({ ...t, max_uses: Math.min(t.max_uses || 3, 3) }));
    if (!Array.isArray(payload.messages)) return json({ error: 'bad_request' }, 400);
    let res: Response | null = null, data: any = null, model = '';
    const t0 = Date.now();
    for (const m of MODELS) {
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
        feature: tag(body.feature), ms: Date.now() - t0, via: 'relay' });
      data.strata = { remaining_micro: prof.is_admin ? null : leftAfter, cost_micro: c.cost };
    }
    return json(data, res ? res.status : 502);
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
    await db.from('invites').delete().eq('created_by', user.id).is('used_by', null);
    await db.from('profiles').delete().eq('user_id', user.id);
    const { error } = await db.auth.admin.deleteUser(user.id);
    if (error) return json({ error: 'delete_failed', message: error.message }, 500);
    return json({ ok: true });
  }

  return json({ error: 'unknown_action' }, 400);
});
