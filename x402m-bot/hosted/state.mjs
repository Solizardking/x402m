import { DatabaseSync } from 'node:sqlite';
import { constants, chmodSync, closeSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, writeFileSync, fsyncSync } from 'node:fs';
import { createPrivateKey, createPublicKey, createHash, randomUUID } from 'node:crypto';
import { isAbsolute, join, relative, resolve } from 'node:path';

export class RuntimeError extends Error {
  constructor(code) { super(code); this.code = code; }
}
const fail = code => { throw new RuntimeError(code); };
const ownerMatches = info => !process.getuid || info.uid === process.getuid();
const validId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/.test(value);
const integer = (value, fallback, min, max) => {
  const n = value === undefined || value === '' ? fallback : Number(value);
  if (!Number.isSafeInteger(n) || n < min || n > max) fail('configuration_error');
  return n;
};

export function readConfig(env = process.env) {
  const enabled = env.X402M_RESPONDER_ENABLED ?? '0';
  if (!['0', '1'].includes(enabled)) fail('configuration_error');
  const base = { enabled: enabled === '1', port: integer(env.PORT, 8080, 0, 65535) };
  // Disabled mode must not inspect a key, touch private state, or create a client.
  if (!base.enabled) return base;
  if (!validId(env.X402M_AGENT_ID) || !env.XAI_API_KEY || env.XAI_API_KEY.length > 8192 ||
      (!env.X402M_PRIVATE_JWK && !env.X402M_KEY_FILE)) fail('configuration_error');
  const parts = (env.X402M_ALLOWED_SENDERS || '').split(',').map(s => s.trim());
  if (!parts.length || parts.length > 100 || parts.some(s => !validId(s))) fail('configuration_error');
  const storage = env.X402M_STORAGE_DIR || '/data';
  if (!isAbsolute(storage) || storage.length > 1024 || storage.includes('\0') || resolve(storage) === '/') fail('configuration_error');
  const storageDir = resolve(storage), journalPath = resolve(env.X402M_JOURNAL || join(storageDir, 'x402m-bot.sqlite'));
  const inside = relative(storageDir, journalPath);
  if (!inside || inside.startsWith('..') || isAbsolute(inside) || journalPath === join(storageDir, 'responder-lease.sqlite') ||
      (env.X402M_KEY_FILE && !isAbsolute(env.X402M_KEY_FILE))) fail('configuration_error');
  const model = env.XAI_MODEL || 'grok-4.7';
  if (!/^[A-Za-z0-9._:/-]{1,160}$/.test(model)) fail('configuration_error');
  const provider = new URL(env.X402M_PROVIDER || 'https://musebook.trade');
  if (provider.origin !== 'https://musebook.trade' || provider.pathname !== '/' || provider.search || provider.hash || provider.username || provider.password) fail('configuration_error');
  return { ...base, agentId: env.X402M_AGENT_ID, allowedSenders: new Set(parts), storageDir, journalPath,
    dailyLimit: integer(env.X402M_DAILY_LIMIT, 100, 1, 10000),
    pollMs: integer(env.X402M_POLL_INTERVAL_MS, 15000, 1000, 60000),
    leaseMs: integer(env.X402M_LEASE_MS, 120000, 30000, 300000),
    model, provider: provider.origin, apiKey: env.XAI_API_KEY,
    privateJwk: env.X402M_PRIVATE_JWK, keyFile: env.X402M_KEY_FILE };
}

export function privateDirectory(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink() || !ownerMatches(info)) fail('storage_error');
  chmodSync(path, 0o700);
}

export function validatePrivateJwk(value) {
  try {
    if (typeof value !== 'string' || Buffer.byteLength(value) > 4096) fail('identity_error');
    const j = JSON.parse(value);
    const canonical = { kty: j.kty, crv: j.crv, x: j.x, d: j.d };
    if (j.kty !== 'OKP' || j.crv !== 'Ed25519' || ![j.x, j.d].every(v => typeof v === 'string' && /^[A-Za-z0-9_-]{43}$/.test(v) && Buffer.from(v, 'base64url').length === 32 && Buffer.from(v, 'base64url').toString('base64url') === v)) fail('identity_error');
    const key = createPrivateKey({ key: canonical, format: 'jwk' });
    if (createPublicKey(key).export({ format: 'jwk' }).x !== j.x) fail('identity_error');
    return { canonical, fingerprint: createHash('sha256').update(j.x).digest('hex') };
  } catch { fail('identity_error'); }
}

function readPrivateFile(path) {
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = fstatSync(fd);
    if (!info.isFile() || !ownerMatches(info) || (info.mode & 0o077) || info.size > 4096) fail('identity_error');
    return validatePrivateJwk(readFileSync(fd, 'utf8'));
  } catch { fail('identity_error'); }
  finally { if (fd !== undefined) closeSync(fd); }
}

export function provisionIdentity({ storageDir, privateJwk, keyFile }) {
  if (!privateJwk) {
    const identity = readPrivateFile(keyFile);
    return { keyFile, fingerprint: identity.fingerprint };
  }
  const identity = validatePrivateJwk(privateJwk);
  const directory = join(storageDir, 'identity'), path = join(directory, 'agent.private.jwk');
  if (keyFile && resolve(keyFile) !== path) fail('configuration_error');
  privateDirectory(storageDir);
  privateDirectory(directory);
  let fd;
  try {
    fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    writeFileSync(fd, JSON.stringify(identity.canonical));
    fsyncSync(fd);
    closeSync(fd); fd = undefined;
    const directoryFd = openSync(directory, constants.O_RDONLY);
    try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
  } catch (error) {
    if (error.code !== 'EEXIST') fail('identity_error');
    const existing = readPrivateFile(path);
    if (JSON.stringify(existing.canonical) !== JSON.stringify(identity.canonical)) fail('identity_error');
  } finally { if (fd !== undefined) closeSync(fd); }
  return { keyFile: path, fingerprint: identity.fingerprint };
}

export function openPrivateDatabase(path) {
  let fd;
  try {
    fd = openSync(path, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
    const info = fstatSync(fd);
    if (!info.isFile() || !ownerMatches(info) || (info.mode & 0o077)) fail('storage_error');
  } finally { if (fd !== undefined) closeSync(fd); }
  const db = new DatabaseSync(path);
  db.exec('PRAGMA busy_timeout=250; PRAGMA synchronous=FULL;');
  return db;
}

export function bindJournal(db, { agentId, fingerprint }, now = Date.now()) {
  db.exec('CREATE TABLE IF NOT EXISTS hosted_meta(name TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS hosted_history(sender TEXT PRIMARY KEY,cursor INTEGER NOT NULL)');
  db.exec('BEGIN IMMEDIATE');
  try {
    const get = name => db.prepare('SELECT value FROM hosted_meta WHERE name=?').get(name)?.value;
    const existing = get('agent_id');
    if (existing && (existing !== agentId || get('identity_fingerprint') !== fingerprint)) fail('identity_error');
    for (const [name, value] of Object.entries({ agent_id: agentId, identity_fingerprint: fingerprint, activation_ms: String(now) })) {
      db.prepare('INSERT OR IGNORE INTO hosted_meta VALUES(?,?)').run(name, value);
    }
    const activation = Number(get('activation_ms'));
    if (!Number.isSafeInteger(activation) || activation <= 0) fail('storage_error');
    db.exec('COMMIT');
    return activation;
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

const busy = error => error.errcode === 5 || /locked|busy/i.test(error.message || '');
export class ProcessLease {
  constructor(db, { now = Date.now, ttlMs = 120000, owner = randomUUID() } = {}) {
    this.db = db; this.now = now; this.ttlMs = ttlMs; this.owner = owner; this.fenced = false;
    db.exec('CREATE TABLE IF NOT EXISTS hosted_lease(singleton INTEGER PRIMARY KEY CHECK(singleton=1), owner TEXT NOT NULL, until_ms INTEGER NOT NULL)');
  }
  acquire() {
    try { this.db.exec('BEGIN IMMEDIATE'); }
    catch (error) { if (busy(error)) return false; throw error; }
    try {
      const now = this.now(), previous = this.db.prepare('SELECT owner,until_ms FROM hosted_lease WHERE singleton=1').get();
      if (previous && previous.owner !== this.owner && previous.until_ms > now) { this.db.exec('COMMIT'); return false; }
      this.db.prepare('INSERT INTO hosted_lease VALUES(1,?,?) ON CONFLICT(singleton) DO UPDATE SET owner=excluded.owner,until_ms=excluded.until_ms').run(this.owner, now + this.ttlMs);
      this.db.exec('COMMIT'); return true;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  owns() {
    const row = this.db.prepare('SELECT owner,until_ms FROM hosted_lease WHERE singleton=1').get();
    return row?.owner === this.owner && row.until_ms > this.now();
  }
  assert() { if (!this.owns()) fail('lease_lost'); }
  heartbeat() {
    const now = this.now();
    return this.db.prepare('UPDATE hosted_lease SET until_ms=? WHERE singleton=1 AND owner=? AND until_ms>?').run(now + this.ttlMs, this.owner, now).changes === 1;
  }
  beginPoll() {
    // A held write transaction prevents a second process taking an expired
    // lease while this process is paused or awaiting a provider response.
    // Reply journaling uses a different DB, so it still commits before send.
    try { this.db.exec('BEGIN IMMEDIATE'); }
    catch (error) { if (busy(error)) fail('lease_busy'); throw error; }
    this.fenced = true;
    try { this.assert(); } catch (error) { this.endPoll(); throw error; }
  }
  endPoll() {
    if (!this.fenced) return;
    try { this.db.exec('COMMIT'); } finally { this.fenced = false; }
  }
  release() {
    this.endPoll();
    this.db.prepare('UPDATE hosted_lease SET until_ms=0 WHERE singleton=1 AND owner=?').run(this.owner);
  }
}
