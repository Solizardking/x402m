import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { tick, initJournal } from '../bot.mjs';
import { clientFromEnv } from '../client.mjs';
import { RuntimeError, readConfig, privateDirectory, provisionIdentity, openPrivateDatabase, bindJournal, ProcessLease } from './state.mjs';

// Never return exception messages: the shared client includes upstream error
// bodies, and incoming message text is private.
const errorClass = error => error instanceof RuntimeError ? error.code : 'poll_error';

export function filterInboxClient(client, { db, activationAt, assertLease }) {
  return {
    async execute(capability, args) {
      assertLease();
      if (capability !== 'x402m.inbox') {
        const result = await client.execute(capability, args);
        assertLease(); return result;
      }
      const sender = args.from;
      let cursor = db.prepare('SELECT cursor FROM hosted_history WHERE sender=?').get(sender)?.cursor || 0;
      // Catch up through historical pages without acknowledging them. Persist
      // only the old prefix, so failed current requests remain recoverable.
      for (let page = 0; page < 10; page++) {
        assertLease();
        const result = await client.execute(capability, { ...args, after: cursor, limit: 50 });
        assertLease();
        if (!Array.isArray(result?.messages)) throw new RuntimeError('poll_error');
        let prefix = cursor, barrier = false;
        const messages = [];
        for (const message of result.messages) {
          const timestamp = message?.created_at;
          const eligible = message?.kind === 'request' && Number.isSafeInteger(timestamp) && timestamp >= activationAt;
          if (eligible) { barrier = true; messages.push(message); }
          else if (!barrier && Number.isSafeInteger(message?.seq) && message.seq > prefix) prefix = message.seq;
        }
        if (prefix > cursor) {
          db.prepare('INSERT INTO hosted_history VALUES(?,?) ON CONFLICT(sender) DO UPDATE SET cursor=MAX(cursor,excluded.cursor)').run(sender, prefix);
          cursor = prefix;
        }
        if (messages.length || result.messages.length < 50 || prefix === 0) return { ...result, messages };
        if (result.messages.some(m => !Number.isSafeInteger(m?.seq))) return { ...result, messages: [] };
      }
      return { messages: [] };
    },
  };
}

export class HostedResponder {
  constructor({ env = process.env, now = Date.now, makeClient = clientFromEnv, fetchImpl = fetch } = {}) {
    this.env = env; this.now = now; this.makeClient = makeClient; this.fetchImpl = fetchImpl;
    this.enabled = env.X402M_RESPONDER_ENABLED === '1'; this.configured = false;
    this.phase = this.enabled ? 'configuration_needed' : 'disabled';
    this.lastSuccessfulPollAt = null; this.lastPollSucceeded = false; this.lastError = null;
    this.initialized = false; this.stopping = false; this.active = null;
  }
  async initialize() {
    if (this.initialized) return;
    this.initialized = true;
    try {
      this.config = readConfig(this.env); this.enabled = this.config.enabled;
      if (!this.enabled) return;
      privateDirectory(this.config.storageDir);
      const identity = provisionIdentity(this.config);
      this.db = openPrivateDatabase(this.config.journalPath); initJournal(this.db);
      this.activationAt = bindJournal(this.db, { agentId: this.config.agentId, fingerprint: identity.fingerprint }, this.now());
      this.leaseDb = openPrivateDatabase(join(this.config.storageDir, 'responder-lease.sqlite'));
      this.lease = new ProcessLease(this.leaseDb, { now: this.now, ttlMs: this.config.leaseMs });
      this.leaseAbort = new AbortController();
      const client = await this.makeClient({ ...this.env, X402M_KEY_FILE: identity.keyFile });
      // The desktop client stores fetch as an injectable instance property.
      client.fetch = (url, init) => this.guardedFetch(url, init);
      this.client = filterInboxClient(client, { db: this.db, activationAt: this.activationAt, assertLease: () => this.assertLease() });
      this.configured = true; this.phase = 'waiting_for_poll';
    } catch (error) {
      this.phase = 'configuration_error';
      this.lastError = error instanceof RuntimeError ? error.code : 'configuration_error';
      this.leaseDb?.close(); this.leaseDb = null; this.db?.close(); this.db = null;
      this.lease = null;
    }
  }
  assertLease() {
    if (this.leaseAbort?.signal.aborted) throw new RuntimeError('lease_lost');
    this.lease.assert();
  }
  async guardedFetch(url, init = {}) {
    this.assertLease();
    const signal = AbortSignal.any([init.signal, this.leaseAbort.signal].filter(Boolean));
    const response = await this.fetchImpl(url, { ...init, signal });
    this.assertLease();
    const assertLease = () => this.assertLease();
    return { ok: response.ok, status: response.status, async json() {
      signal.throwIfAborted(); assertLease();
      const data = await response.json();
      signal.throwIfAborted(); assertLease(); return data;
    } };
  }
  async pollOnce() {
    if (!this.configured || !this.enabled || this.stopping || this.active) return false;
    const work = Promise.resolve().then(async () => {
      let fenced = false;
      try {
        if (!this.lease.owns()) {
          if (!this.lease.acquire()) { this.phase = 'waiting_for_lease'; this.lastError = 'lease_busy'; this.lastPollSucceeded = false; return false; }
          this.leaseAbort = new AbortController();
        }
        this.lease.beginPoll(); fenced = true;
        this.phase = 'polling';
        this.heartbeatTimer ||= setInterval(() => {
          try {
            if (!this.lease.heartbeat()) throw new RuntimeError('lease_lost');
          } catch { this.leaseAbort.abort(); this.lastError = 'lease_lost'; this.lastPollSucceeded = false; }
        }, Math.min(10000, Math.floor(this.config.leaseMs / 4)));
        this.heartbeatTimer.unref();
        await tick({ client: this.client, db: this.db, apiKey: this.config.apiKey, model: this.config.model,
          allowedSenders: this.config.allowedSenders, dailyLimit: this.config.dailyLimit,
          fetchImpl: (url, init) => this.guardedFetch(url, init) });
        this.assertLease();
        if (!this.lease.heartbeat()) throw new RuntimeError('lease_lost');
        this.lastSuccessfulPollAt = this.now(); this.lastPollSucceeded = true;
        this.lastError = null; this.phase = 'ready'; return true;
      } catch (error) {
        this.lastError = errorClass(error); this.lastPollSucceeded = false; this.phase = 'poll_error';
        return false;
      } finally {
        if (fenced) {
          try { this.lease.endPoll(); }
          catch { this.lastError = 'storage_error'; this.lastPollSucceeded = false; this.phase = 'poll_error'; }
        }
      }
    });
    this.active = work;
    try { return await work; } finally { this.active = null; }
  }
  status() {
    let owns = false;
    try { owns = Boolean(this.lease?.owns()); } catch {}
    const fresh = this.lastSuccessfulPollAt !== null && this.now() - this.lastSuccessfulPollAt <= (this.config?.leaseMs || 120000) + (this.config?.pollMs || 15000);
    const ready = this.enabled && this.configured && !this.stopping && owns && fresh && this.lastPollSucceeded;
    return { service: 'musebook-x402m-responder', enabled: this.enabled, configured: this.configured,
      ready, status: this.stopping && this.phase !== 'stopped' ? 'stopping' : this.phase,
      configurationNeeded: !this.configured, lastSuccessfulPollAt: this.lastSuccessfulPollAt,
      errorClass: this.lastError };
  }
  start() {
    if (!this.configured || this.loopPromise) return;
    this.loopPromise = (async () => {
      while (!this.stopping) {
        await this.pollOnce();
        if (!this.stopping) await new Promise(resolve => { this.wake = resolve; this.pollTimer = setTimeout(resolve, this.config.pollMs); });
      }
    })();
  }
  async stop({ drainMs = 20000 } = {}) {
    if (this.stopPromise) return this.stopPromise;
    this.stopping = true; clearTimeout(this.pollTimer); this.wake?.();
    this.stopPromise = (async () => {
      const timeout = setTimeout(() => this.leaseAbort?.abort(), drainMs);
      try { await this.active; await this.loopPromise; }
      finally {
        clearTimeout(timeout); clearInterval(this.heartbeatTimer);
        try { this.lease?.release(); } finally { this.leaseDb?.close(); this.db?.close(); }
        this.leaseDb = null; this.db = null; this.phase = 'stopped';
      }
    })();
    return this.stopPromise;
  }
}

export function healthServer(runtime) {
  const server = createServer({ maxHeaderSize: 8192 }, (req, res) => {
    res.setHeader('cache-control', 'no-store'); res.setHeader('content-type', 'application/json');
    res.setHeader('x-content-type-options', 'nosniff'); res.setHeader('connection', 'close');
    const end = (status, body) => {
      const json = JSON.stringify(body); res.writeHead(status, { 'content-length': Buffer.byteLength(json) });
      res.end(req.method === 'HEAD' ? undefined : json); req.resume();
    };
    if (!req.url || req.url.length > 64) return end(414, { errorClass: 'request_rejected' });
    if (!['GET', 'HEAD'].includes(req.method)) return end(405, { errorClass: 'method_not_allowed' });
    if (req.headers['transfer-encoding'] || (req.headers['content-length'] && req.headers['content-length'] !== '0')) return end(413, { errorClass: 'request_rejected' });
    if (!['/health', '/ready'].includes(req.url)) return end(404, { errorClass: 'not_found' });
    const status = runtime.status(); return end(req.url === '/ready' && !status.ready ? 503 : 200, status);
  });
  server.maxHeadersCount = 24; server.maxConnections = 64;
  server.requestTimeout = 5000; server.headersTimeout = 5000; server.keepAliveTimeout = 1000;
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.umask(0o077);
  const runtime = new HostedResponder();
  await runtime.initialize();
  const server = healthServer(runtime);
  server.listen(runtime.config?.port ?? 8080, '0.0.0.0', () => {
    console.log(JSON.stringify({ event: 'responder_started', ...runtime.status() })); runtime.start();
  });
  const shutdownError = () => { console.error(JSON.stringify({ event: 'shutdown_error', errorClass: 'shutdown_error' })); process.exitCode = 1; };
  server.on('error', () => { console.error(JSON.stringify({ event: 'server_error', errorClass: 'server_error' })); process.exitCode = 1; void runtime.stop().catch(shutdownError); });
  let stopping = false;
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, async () => {
    if (stopping) return; stopping = true;
    server.close(); server.closeIdleConnections();
    try { await runtime.stop(); console.log(JSON.stringify({ event: 'responder_stopped' })); }
    catch { shutdownError(); }
  });
}
