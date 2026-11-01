// Talking to Meta for Instagram (Instagram API with Unified Login). No extra
// packages, as in lib/googleAuth.js: Node's fetch and crypto. routes/instagram.js
// is the connect flow, lib/autodm.js the app built on this.
//
// Login is Facebook Login for Business with a config_id: the configuration in
// the App Dashboard sets the permissions and the token's expiry, so no scope is
// sent. The result is a Business Integration System User token, owned by the
// client's business portfolio. So, unlike Instagram Login:
//   - everything goes to graph.facebook.com; graph.instagram.com rejects it
//   - /me is the system user, so paths use the Instagram account's own id
//   - there's no refresh: a dead token means the client connects again
//
// Turned on by these in .env; without them AutoDM says it isn't set up:
//   META_APP_ID, META_APP_SECRET     App settings → Basic (not the Instagram ones)
//   FB_LOGIN_CONFIG_ID               Facebook Login for Business → Configurations
//   INSTAGRAM_WEBHOOK_VERIFY_TOKEN   any long random string, also typed into
//                                    Meta's webhook settings
//   TOKEN_ENC_KEY (or INSTAGRAM_TOKEN_KEY)  any long random string; encrypts
//                                    tokens at rest. Changing it means everyone
//                                    has to reconnect.
// Optional: META_REDIRECT_URI (default <origin>/auth/instagram/callback, which
// must be listed exactly in Meta's settings) and GRAPH_API_VERSION (default v26.0).
const crypto = require('crypto');

const VERSION = /^v\d+\.\d+$/.test(process.env.GRAPH_API_VERSION || '') ? process.env.GRAPH_API_VERSION : 'v26.0';
const AUTH_URL = `https://www.facebook.com/${VERSION}/dialog/oauth`;
const API = `https://graph.facebook.com/${VERSION}`;
// What AutoDM can't work without; the configuration has to include these.
const REQUIRED_SCOPES = ['instagram_basic', 'instagram_manage_messages', 'instagram_manage_comments'];

const appId = () => process.env.META_APP_ID;
const appSecret = () => process.env.META_APP_SECRET;
const tokenSecret = () => process.env.TOKEN_ENC_KEY || process.env.INSTAGRAM_TOKEN_KEY;

function instagramEnabled() {
  return Boolean(appId() && appSecret() && process.env.FB_LOGIN_CONFIG_ID
    && process.env.INSTAGRAM_WEBHOOK_VERIFY_TOKEN && tokenSecret());
}

function redirectUri(req) {
  return process.env.META_REDIRECT_URI || `${req.protocol}://${req.get('host')}/auth/instagram/callback`;
}

function authUrl(req, state) {
  return `${AUTH_URL}?${new URLSearchParams({
    client_id: appId(),
    redirect_uri: redirectUri(req),
    state,
    config_id: process.env.FB_LOGIN_CONFIG_ID,
    response_type: 'code',
    override_default_response_type: 'true',
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
function sameBytes(a, b) {
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// X-Hub-Signature-256 on webhooks: sha256=<hex HMAC of the raw body>.
function validWebhookSignature(rawBody, header) {
  const match = /^sha256=([a-f0-9]{64})$/i.exec(String(header || ''));
  if (!match || !rawBody) return false;
  return sameBytes(crypto.createHmac('sha256', appSecret()).update(rawBody).digest(), Buffer.from(match[1], 'hex'));
}

// signed_request on the deauthorize and data-deletion callbacks: the payload,
// or null if the signature is wrong.
function parseSignedRequest(signed) {
  const [sig, body] = String(signed || '').split('.');
  if (!sig || !body) return null;
  if (!sameBytes(crypto.createHmac('sha256', appSecret()).update(body).digest(), Buffer.from(sig, 'base64url'))) return null;
  try {
    return JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch (err) {
    return null;
  }
}

// --- Graph API ---
const noTokens = (text) => String(text || '').replace(/EAA[A-Za-z0-9]+/g, '[token]');

class InstagramError extends Error {
  constructor(status, body) {
    const e = body?.error || {};
    super(noTokens(e.message) || `Instagram request failed (${status})`);
    this.status = status;
    this.metaCode = e.code;
    // 190: the token expired or was revoked — the client must connect again.
    this.tokenInvalid = this.metaCode === 190;
    // Meta's error, safe to log.
    this.meta = { status, type: e.type, code: e.code, subcode: e.error_subcode, fbtrace_id: e.fbtrace_id };
  }
}

async function readJson(res) {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new InstagramError(res.status, body);
  return body;
}

const authed = (accessToken) => ({ Authorization: `Bearer ${accessToken}` });

// The code from the callback → the system user token. It goes out exactly as
// issued; only the Instagram Login flow has a #_ to strip.
async function exchangeCode(code, req) {
  const body = await readJson(await fetch(`${API}/oauth/access_token?${new URLSearchParams({
    client_id: appId(),
    client_secret: appSecret(),
    redirect_uri: redirectUri(req),
    code,
  })}`));
  if (!body.access_token) throw new Error('Meta didn’t return an access token.');
  return body.access_token;
}

// What the token is: { valid, type, scopes, expiresAt } — expiresAt null means it never expires.
async function inspectToken(accessToken) {
  const { data = {} } = await readJson(await fetch(`${API}/debug_token?${new URLSearchParams({
    input_token: accessToken,
    access_token: `${appId()}|${appSecret()}`,
  })}`));
  const seconds = Number(data.expires_at) || 0;
  return {
    valid: !!data.is_valid,
    type: String(data.type || ''),
    scopes: data.scopes || [],
    expiresAt: seconds ? new Date(seconds * 1000) : null,
  };
}

// The app-scoped id of the system user, and the client's business portfolio.
async function fetchBusiness(accessToken) {
  return readJson(await fetch(`${API}/me?fields=id,client_business_id`, { headers: authed(accessToken) }));
}

async function listAssignedAccounts(accessToken) {
  const body = await readJson(await fetch(`${API}/me/assigned_instagram_accounts?fields=id,username`, { headers: authed(accessToken) }));
  return body.data || [];
}

async function fetchProfile(accessToken, igUserId) {
  const fields = 'id,username,name,profile_picture_url';
  return readJson(await fetch(`${API}/${encodeURIComponent(igUserId)}?fields=${fields}`, { headers: authed(accessToken), signal: AbortSignal.timeout(5000) }));
}

async function subscribeToComments(accessToken, igUserId) {
  return readJson(await fetch(`${API}/${encodeURIComponent(igUserId)}/subscribed_apps?subscribed_fields=comments`, { method: 'POST', headers: authed(accessToken) }));
}

async function unsubscribe(accessToken, igUserId) {
  return readJson(await fetch(`${API}/${encodeURIComponent(igUserId)}/subscribed_apps`, { method: 'DELETE', headers: authed(accessToken) }));
}

async function listMedia(accessToken, igUserId, limit = 30) {
  const fields = 'id,caption,media_product_type,timestamp';
  const body = await readJson(await fetch(`${API}/${encodeURIComponent(igUserId)}/media?fields=${fields}&limit=${limit}`, { headers: authed(accessToken) }));
  return body.data || [];
}

// A private reply: a DM to the person who wrote this comment. Instagram allows
// one per comment, within 7 days of it.
async function sendPrivateReply(accessToken, igUserId, commentId, text) {
  return readJson(await fetch(`${API}/${encodeURIComponent(igUserId)}/messages`, {
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
  REQUIRED_SCOPES, instagramEnabled, authUrl, encryptToken, decryptToken, validWebhookSignature, parseSignedRequest,
  exchangeCode, inspectToken, fetchBusiness, listAssignedAccounts, fetchProfile, subscribeToComments, unsubscribe,
  listMedia, sendPrivateReply, replyToComment,
};
