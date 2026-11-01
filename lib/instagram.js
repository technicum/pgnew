// Talking to Instagram (Instagram API with Instagram Login — no Facebook Page
// needed, the creator just needs a Business or Creator account). No extra
// packages, as in lib/googleAuth.js: Node's fetch and crypto. lib/autodm.js is
// the app built on this.
//
// Turned on by four settings in .env; without them AutoDM says it isn't set up
// and every route that needs Instagram 404s:
//   INSTAGRAM_APP_ID, INSTAGRAM_APP_SECRET   Meta app → Instagram → API setup
//   INSTAGRAM_WEBHOOK_VERIFY_TOKEN           any long random string, also typed
//                                            into Meta's webhook settings
//   INSTAGRAM_TOKEN_KEY (or TOKEN_ENC_KEY)   any long random string; encrypts
//                                            tokens at rest. Changing it means
//                                            everyone has to reconnect.
// Optional: INSTAGRAM_REDIRECT_URI or INSTAGRAM_REDIRECT_URL (default
// <origin>/auth/instagram/callback, which must be listed exactly in Meta's
// settings), GRAPH_API_VERSION (default v23.0) and META_APP_SECRET, also
// accepted on signed Meta requests if they're signed with the main app secret.
const crypto = require('crypto');

const AUTH_URL = 'https://www.instagram.com/oauth/authorize';
const TOKEN_URL = 'https://api.instagram.com/oauth/access_token';
const GRAPH = 'https://graph.instagram.com';
const API = `${GRAPH}/${/^v\d+\.\d+$/.test(process.env.GRAPH_API_VERSION || '') ? process.env.GRAPH_API_VERSION : 'v23.0'}`;
const SCOPES = 'instagram_business_basic,instagram_business_manage_messages,instagram_business_manage_comments';

const tokenSecret = () => process.env.INSTAGRAM_TOKEN_KEY || process.env.TOKEN_ENC_KEY;

function instagramEnabled() {
  return Boolean(process.env.INSTAGRAM_APP_ID && process.env.INSTAGRAM_APP_SECRET
    && process.env.INSTAGRAM_WEBHOOK_VERIFY_TOKEN && tokenSecret());
}

function redirectUri(req) {
  return process.env.INSTAGRAM_REDIRECT_URI || process.env.INSTAGRAM_REDIRECT_URL || `${req.protocol}://${req.get('host')}/auth/instagram/callback`;
}

function authUrl(req, state) {
  return `${AUTH_URL}?${new URLSearchParams({
    client_id: process.env.INSTAGRAM_APP_ID,
    redirect_uri: redirectUri(req),
    response_type: 'code',
    scope: SCOPES,
    state,
  })}`;
}

// --- Tokens at rest: AES-256-GCM, stored as iv.tag.ciphertext (base64url) ---
const tokenKey = () => crypto.createHash('sha256').update(String(tokenSecret())).digest();

function encryptToken(token) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', tokenKey(), iv);
  const data = Buffer.concat([cipher.update(String(token), 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map((b) => b.toString('base64url')).join('.');
}

function decryptToken(stored) {
  const [iv, tag, data] = String(stored).split('.').map((p) => Buffer.from(p, 'base64url'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', tokenKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

// --- Meta's signatures ---
const appSecrets = () => [process.env.INSTAGRAM_APP_SECRET, process.env.META_APP_SECRET].filter(Boolean);

function sameBytes(a, b) {
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// X-Hub-Signature-256 on webhooks: sha256=<hex HMAC of the raw body>.
function validWebhookSignature(rawBody, header) {
  const match = /^sha256=([a-f0-9]{64})$/i.exec(String(header || ''));
  if (!match || !rawBody) return false;
  const given = Buffer.from(match[1], 'hex');
  return appSecrets().some((secret) => sameBytes(crypto.createHmac('sha256', secret).update(rawBody).digest(), given));
}

// signed_request on the deauthorize and data-deletion callbacks: the payload,
// or null if the signature is wrong.
function parseSignedRequest(signed) {
  const [sig, body] = String(signed || '').split('.');
  if (!sig || !body) return null;
  const given = Buffer.from(sig, 'base64url');
  if (!appSecrets().some((secret) => sameBytes(crypto.createHmac('sha256', secret).update(body).digest(), given))) return null;
  try {
    return JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch (err) {
    return null;
  }
}

// --- Graph API ---
class InstagramError extends Error {
  constructor(status, body) {
    const e = body?.error || {};
    super(e.message || body?.error_message || `Instagram request failed (${status})`);
    this.status = status;
    this.metaCode = e.code ?? body?.code;
    // 190: the token is expired or was revoked — the creator must reconnect.
    this.tokenInvalid = this.metaCode === 190;
  }
}

async function readJson(res) {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new InstagramError(res.status, body);
  return body;
}

// Code from the callback → { accessToken, expiresIn, scopedId, scopes }. The token
// response is the short-lived token; it's swapped for the 60-day one.
async function exchangeCode(code, req) {
  const short = await readJson(await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.INSTAGRAM_APP_ID,
      client_secret: process.env.INSTAGRAM_APP_SECRET,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri(req),
      code: String(code).replace(/#_$/, ''),
    }),
  }));
  const first = Array.isArray(short.data) ? short.data[0] : short;
  if (!first?.access_token) throw new Error('Instagram didn’t return an access token.');
  const long = await readJson(await fetch(`${GRAPH}/access_token?${new URLSearchParams({
    grant_type: 'ig_exchange_token',
    client_secret: process.env.INSTAGRAM_APP_SECRET,
    access_token: first.access_token,
  })}`));
  return { accessToken: long.access_token, expiresIn: Number(long.expires_in) || 0, scopedId: String(first.user_id || ''), scopes: [].concat(first.permissions || []).join(',') };
}

async function refreshToken(accessToken) {
  const body = await readJson(await fetch(`${GRAPH}/refresh_access_token?${new URLSearchParams({ grant_type: 'ig_refresh_token', access_token: accessToken })}`));
  return { accessToken: body.access_token, expiresIn: Number(body.expires_in) || 0 };
}

const authed = (accessToken) => ({ Authorization: `Bearer ${accessToken}` });

// user_id here is the professional account id that webhooks are addressed to
// (entry.id) — not the app-scoped id from the token response.
async function fetchProfile(accessToken) {
  const fields = 'user_id,username,name,profile_picture_url,account_type';
  return readJson(await fetch(`${API}/me?fields=${fields}`, { headers: authed(accessToken), signal: AbortSignal.timeout(5000) }));
}

async function subscribeToComments(accessToken) {
  return readJson(await fetch(`${API}/me/subscribed_apps?subscribed_fields=comments`, { method: 'POST', headers: authed(accessToken) }));
}

async function unsubscribe(accessToken) {
  return readJson(await fetch(`${API}/me/subscribed_apps`, { method: 'DELETE', headers: authed(accessToken) }));
}

async function listMedia(accessToken, limit = 30) {
  const fields = 'id,caption,media_product_type,timestamp';
  const body = await readJson(await fetch(`${API}/me/media?fields=${fields}&limit=${limit}`, { headers: authed(accessToken) }));
  return body.data || [];
}

// A private reply: a DM to the person who wrote this comment. Instagram allows
// one per comment, within 7 days of it.
async function sendPrivateReply(accessToken, commentId, text) {
  return readJson(await fetch(`${API}/me/messages`, {
    method: 'POST',
    headers: { ...authed(accessToken), 'Content-Type': 'application/json' },
    body: JSON.stringify({ recipient: { comment_id: commentId }, message: { text } }),
  }));
}

async function replyToComment(accessToken, commentId, text) {
  return readJson(await fetch(`${API}/${encodeURIComponent(commentId)}/replies`, {
    method: 'POST',
    headers: { ...authed(accessToken), 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: text }),
  }));
}

module.exports = {
  instagramEnabled, authUrl, encryptToken, decryptToken, validWebhookSignature, parseSignedRequest,
  exchangeCode, refreshToken, fetchProfile, subscribeToComments, unsubscribe, listMedia, sendPrivateReply, replyToComment,
};
