// Strata relay · one Supabase Edge Function, named "strata".
// - signup:  creates an account from an invitation code (public sign-ups can stay off)
// - claude:  calls Claude with the server key and counts what each friend spends against their credit
// - invite, me, friends, topup: invitations and credit. Credit is paid by the server key (invitations from the admin)
//   or by the inviting friend's own Claude key, stored encrypted in Vault (set_key / clear_key).
// Secrets: ANTHROPIC_API_KEY (set in Edge Functions → Secrets). SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided by Supabase.
// Settings: turn OFF "Enforce JWT verification" for this function — it checks the user itself.
import { createClient } from 'npm:@supabase/supabase-js@2';

const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
const ANTHROPIC_KEY = Deno.env.get('ANTHROPIC_API_KEY') || '';

const MODELS = ['claude-sonnet-5-5', 'claude-sonnet-4-6'];
// US dollars per million tokens [input, output]. Check claude.com/pricing if Anthropic changes them.
const PRICE: Record<string, number[]> = { 'claude-sonnet-5-5': [3, 15], 'claude-sonnet-4-6': [3, 15] };
const SEARCH_MICRO = 10000;            // web search: $10 per 1,000 searches
const ADMIN_INVITE_CENTS = 200;        // $2 offered with each invitation sent by the admin
const MAX_TOPUP_CENTS = 2000;
const MAX_OFFER_CENTS = 2000;

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
const clampCents = (v: any, d: number) => Math.max(0, Math.min(Number.isFinite(Number(v)) ? Math.round(Number(v)) : d, MAX_OFFER_CENTS));
async function keyFor(prof: any): Promise<{ key: string, own: boolean }> {
  if (prof.is_admin || prof.server_paid) return { key: ANTHROPIC_KEY, own: false };
  if (prof.sponsor_id) { const { data } = await db.rpc('strata_get_key', { p_uid: prof.sponsor_id }); return { key: data || '', own: true }; }
  return { key: '', own: false };
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
    return json({ ok: true, from: await nameOf(inv.created_by), credit_cents: inv.credit_cents });
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
    await db.from('profiles').insert({ user_id: created.user.id, name, lang, budget_cents: inv.credit_cents, invited_by: inv.created_by, server_paid: !!inv.server_paid, sponsor_id: inv.sponsor_id || null });
    return json({ ok: true, credit_cents: inv.credit_cents });
  }

  // ── signed-in users ──
  const user = await getUser(req);
  if (!user) return json({ error: 'signed_out' }, 401);
  const prof: any = await getProfile(user);

  if (action === 'me') {
    const { count: friends } = prof.is_admin
      ? await db.from('profiles').select('user_id', { count: 'exact', head: true }).eq('server_paid', true)
      : await db.from('profiles').select('user_id', { count: 'exact', head: true }).eq('sponsor_id', user.id);
    const payer = prof.sponsor_id ? await nameOf(prof.sponsor_id) : prof.server_paid ? await nameOf(prof.invited_by) : '';
    return json({ name: prof.name, is_admin: prof.is_admin, budget_cents: prof.budget_cents, spent_micro: prof.spent_micro, remaining_micro: remaining(prof), inviter: await nameOf(prof.invited_by), payer, has_key: !!prof.key_secret_id, key_hint: prof.key_hint || '', friends: friends || 0 });
  }

  if (action === 'claude') {
    const left = remaining(prof);
    if (left !== null && left <= 0) return json({ error: 'no_budget', remaining_micro: 0 }, 402);
    const { key: apiKey, own } = await keyFor(prof);
    if (!apiKey) return json({ error: own ? 'sponsor_key_missing' : (prof.is_admin || prof.server_paid ? 'relay_not_configured' : 'no_budget'), remaining_micro: 0 }, own || !(prof.is_admin || prof.server_paid) ? 402 : 500);
    const b = body.body || {};
    const payload: any = { max_tokens: Math.min(Number(b.max_tokens) || 1000, 4000), messages: b.messages };
    if (b.system) payload.system = b.system;
    if (Array.isArray(b.tools)) payload.tools = b.tools.filter((t: any) => t && /^web_search/.test(t.type)).map((t: any) => ({ ...t, max_uses: Math.min(t.max_uses || 3, 3) }));
    if (!Array.isArray(payload.messages)) return json({ error: 'bad_request' }, 400);
    let res: Response | null = null, data: any = null, model = '';
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
    if (own && res && !res.ok) {
      const msg = (data && data.error && data.error.message) || '';
      if (res.status === 401 || res.status === 403) return json({ error: 'sponsor_key_invalid' }, 402);
      if (/credit/i.test(msg)) return json({ error: 'sponsor_no_credit' }, 402);
    }
    if (res && res.ok && data && data.usage) {
      const u = data.usage, p = PRICE[model] || [3, 15];
      const searches = (u.server_tool_use && u.server_tool_use.web_search_requests) || 0;
      const inTok = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
      const cost = Math.ceil(inTok * p[0] + (u.output_tokens || 0) * p[1] + searches * SEARCH_MICRO);
      const { data: leftAfter } = await db.rpc('strata_spend', { p_uid: user.id, p_micro: cost });
      await db.from('usage').insert({ user_id: user.id, model, input_tokens: inTok, output_tokens: u.output_tokens || 0, searches, cost_micro: cost });
      data.strata = { remaining_micro: prof.is_admin ? null : leftAfter, cost_micro: cost };
    }
    return json(data, res ? res.status : 502);
  }

  if (action === 'invite') {
    let credit = 0, server_paid = false, sponsor_id: string | null = null;
    if (prof.is_admin) { credit = clampCents(body.credit_cents, ADMIN_INVITE_CENTS); server_paid = credit > 0; }
    else if (prof.key_secret_id) { credit = clampCents(body.credit_cents, ADMIN_INVITE_CENTS); sponsor_id = credit > 0 ? user.id : null; }
    for (let i = 0; i < 4; i++) {
      const code = newCode();
      const { error } = await db.from('invites').insert({ code, created_by: user.id, credit_cents: credit, server_paid, sponsor_id });
      if (!error) return json({ code, credit_cents: credit, paid_by: server_paid ? 'server' : sponsor_id ? 'you' : 'none' });
    }
    return json({ error: 'invite_failed' }, 500);
  }

  // My own Claude key, kept encrypted so the friends I invite can spend the credit I offer them
  if (action === 'set_key') {
    const k = String(body.key || '').trim();
    if (!/^sk-ant-[A-Za-z0-9_\-]{20,}$/.test(k)) return json({ error: 'bad_key' }, 400);
    const chk = await fetch('https://api.anthropic.com/v1/models?limit=1', { headers: { 'x-api-key': k, 'anthropic-version': '2023-06-01' } });
    if (chk.status === 401 || chk.status === 403) return json({ error: 'bad_key' }, 400);
    const { error } = await db.rpc('strata_set_key', { p_uid: user.id, p_key: k });
    if (error) return json({ error: 'key_failed', message: error.message }, 500);
    return json({ ok: true, key_hint: k.slice(-4) });
  }
  if (action === 'clear_key') {
    await db.rpc('strata_clear_key', { p_uid: user.id });
    return json({ ok: true });
  }

  // Friends whose credit I pay: everyone the server pays for (admin), or the friends I sponsor with my key
  if (action === 'friends') {
    const q = db.from('profiles').select('*').order('created_at', { ascending: false });
    const { data: rows } = prof.is_admin ? await q.eq('server_paid', true) : await q.eq('sponsor_id', user.id);
    const { data: list } = await db.auth.admin.listUsers({ page: 1, perPage: 1000 });
    const emails: Record<string, string> = {};
    ((list && list.users) || []).forEach((u: any) => { emails[u.id] = u.email; });
    const { count } = await db.from('invites').select('code', { count: 'exact', head: true }).eq('created_by', user.id).is('used_by', null);
    return json({ friends: (rows || []).map((r: any) => ({ id: r.user_id, name: r.name, email: emails[r.user_id] || '', budget_cents: r.budget_cents, spent_micro: r.spent_micro, created_at: r.created_at })), open_invites: count || 0 });
  }
  if (action === 'topup') {
    const cents = Math.max(1, Math.min(Number(body.cents) || 100, MAX_TOPUP_CENTS));
    const { data: row } = await db.from('profiles').select('budget_cents, server_paid, sponsor_id').eq('user_id', body.user_id).maybeSingle();
    if (!row) return json({ error: 'not_found' }, 404);
    const mine = prof.is_admin ? row.server_paid : row.sponsor_id === user.id;
    if (!mine) return json({ error: 'forbidden' }, 403);
    if (!prof.is_admin && !prof.key_secret_id) return json({ error: 'no_key' }, 400);
    await db.from('profiles').update({ budget_cents: row.budget_cents + cents }).eq('user_id', body.user_id);
    return json({ ok: true, budget_cents: row.budget_cents + cents });
  }

  // Delete my account: photos, cloud journal, credit and usage, open invitations, my saved key, then the account itself
  if (action === 'delete_account') {
    if (prof.is_admin) return json({ error: 'admin_cannot_delete' }, 403);
    await db.rpc('strata_clear_key', { p_uid: user.id });
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
