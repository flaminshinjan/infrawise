import { Redis } from "ioredis";
import type { Device, QueueEntry, Session, LabEventType } from "@lab/protocol";

/**
 * All authoritative state lives in Redis. Every multi-key transition runs as a
 * Lua script so it is atomic: no externally visible state can ever show one
 * device assigned to two sessions, and fencing tokens only move forward.
 *
 * Keys (prefix configurable for test isolation):
 *   {p}queue                ZSET  score=enqueuedAt, member=requestId
 *   {p}qe:{requestId}       JSON  QueueEntry
 *   {p}device:{deviceId}    JSON  Device
 *   {p}devices              SET   all device ids
 *   {p}avail                SET   AVAILABLE device ids
 *   {p}session:{id}         JSON  Session
 *   {p}sessions             SET   nonterminal session ids
 *   {p}client-session:{cid} STR   sessionId
 *   {p}client-request:{cid} STR   requestId
 *   {p}fence:{deviceId}     INT   monotonically increasing lease fence
 *   {p}lease:{sessionId}    STR   worker lease with PX TTL (kill -9 proof)
 *   {p}stream-pids:{devId}  JSON  capture subprocess pids for orphan reaping
 *   {p}events               STREAM
 */

const LUA_HELPERS = `
local function getjson(key)
  local raw = redis.call('GET', key)
  if not raw then return nil end
  return cjson.decode(raw)
end
local function setjson(key, value)
  redis.call('SET', key, cjson.encode(value))
end
local function emit(prefix, evtype, fields)
  local args = {'XADD', prefix..'events', 'MAXLEN', '~', '1000', '*', 'type', evtype}
  for k, v in pairs(fields) do
    args[#args+1] = k
    args[#args+1] = tostring(v)
  end
  redis.call(unpack(args))
end
local function nonterminal(state)
  return state == 'RESERVED' or state == 'ACTIVE' or state == 'DISCONNECTED'
      or state == 'ENDING' or state == 'CLEANING'
end
`;

const SCRIPTS = {
  /**
   * Idempotent request creation.
   * ARGV: prefix, clientId, clientTokenHash, requestId, now
   * Returns: {kind, json} where kind = SESSION | WAITING | JOINED
   */
  joinQueue: `${LUA_HELPERS}
local prefix, clientId, tokenHash, requestId, now =
  ARGV[1], ARGV[2], ARGV[3], ARGV[4], tonumber(ARGV[5])

local sid = redis.call('GET', prefix..'client-session:'..clientId)
if sid then
  local sess = getjson(prefix..'session:'..sid)
  if sess and nonterminal(sess.state) then
    return {'SESSION', cjson.encode(sess)}
  end
  redis.call('DEL', prefix..'client-session:'..clientId)
end

local rid = redis.call('GET', prefix..'client-request:'..clientId)
if rid then
  local qe = getjson(prefix..'qe:'..rid)
  if qe and qe.state == 'WAITING' then
    return {'WAITING', cjson.encode(qe)}
  end
  redis.call('DEL', prefix..'client-request:'..clientId)
end

local entry = {
  requestId = requestId,
  clientId = clientId,
  clientTokenHash = tokenHash,
  enqueuedAt = now,
  state = 'WAITING',
}
setjson(prefix..'qe:'..requestId, entry)
redis.call('ZADD', prefix..'queue', now, requestId)
redis.call('SET', prefix..'client-request:'..clientId, requestId)
emit(prefix, 'QUEUE_JOINED', {clientId = clientId, requestId = requestId})
return {'JOINED', cjson.encode(entry)}
`,

  /**
   * Atomic allocation: pop one available device, pop the oldest valid waiter,
   * increment the fence, create a RESERVED session, bind everything.
   * ARGV: prefix, now, sessionId, claimTokenHash, claimMs, sessionMaxMs, leaseTtlMs
   * Returns: nil (nothing to do) or {sessionJson, deviceJson}
   */
  allocate: `${LUA_HELPERS}
local prefix, now, sessionId, claimTokenHash, claimMs, sessionMaxMs, leaseTtlMs =
  ARGV[1], tonumber(ARGV[2]), ARGV[3], ARGV[4], tonumber(ARGV[5]),
  tonumber(ARGV[6]), tonumber(ARGV[7])

local deviceId = redis.call('SPOP', prefix..'avail')
if not deviceId then return nil end
local device = getjson(prefix..'device:'..deviceId)
if not device or device.state ~= 'AVAILABLE' then
  -- avail set was stale; leave the device out of the pool for the
  -- reconciler to repair rather than assigning an unknown device.
  return nil
end

local waiter = nil
while true do
  local head = redis.call('ZRANGE', prefix..'queue', 0, 0)
  if #head == 0 then break end
  local rid = head[1]
  local qe = getjson(prefix..'qe:'..rid)
  if qe and qe.state == 'WAITING' then
    waiter = qe
    break
  end
  -- cancelled/expired/vanished entries never block the head
  redis.call('ZREM', prefix..'queue', rid)
end

if not waiter then
  redis.call('SADD', prefix..'avail', deviceId)
  return nil
end

local fence = redis.call('INCR', prefix..'fence:'..deviceId)
local session = {
  id = sessionId,
  clientId = waiter.clientId,
  deviceId = deviceId,
  state = 'RESERVED',
  leaseFence = fence,
  claimTokenHash = claimTokenHash,
  createdAt = now,
  expiresAt = now + sessionMaxMs,
  claimDeadline = now + claimMs,
  lastHeartbeatAt = now,
  lastAcceptedInputSeq = 0,
}
setjson(prefix..'session:'..sessionId, session)
redis.call('SADD', prefix..'sessions', sessionId)
redis.call('SET', prefix..'lease:'..sessionId, '1', 'PX', leaseTtlMs)

device.state = 'RESERVED'
device.currentSessionId = sessionId
device.leaseFence = fence
setjson(prefix..'device:'..deviceId, device)

redis.call('ZREM', prefix..'queue', waiter.requestId)
waiter.state = 'CLAIMED'
setjson(prefix..'qe:'..waiter.requestId, waiter)
redis.call('PEXPIRE', prefix..'qe:'..waiter.requestId, 3600000)
redis.call('SET', prefix..'client-session:'..waiter.clientId, sessionId)
redis.call('DEL', prefix..'client-request:'..waiter.clientId)
emit(prefix, 'DEVICE_RESERVED', {
  clientId = waiter.clientId, sessionId = sessionId,
  deviceId = deviceId, requestId = waiter.requestId, fence = fence,
})
return {cjson.encode(session), cjson.encode(device),
        waiter.requestId, tostring(waiter.enqueuedAt)}
`,

  /**
   * Claim a reservation -> ACTIVE.
   * ARGV: prefix, sessionId, clientId, claimTokenHash, now, sessionMaxMs
   * Returns: {'OK', sessionJson, deviceJson} or {'ERR', code}
   */
  claim: `${LUA_HELPERS}
local prefix, sessionId, clientId, tokenHash, now, sessionMaxMs =
  ARGV[1], ARGV[2], ARGV[3], ARGV[4], tonumber(ARGV[5]), tonumber(ARGV[6])
local sess = getjson(prefix..'session:'..sessionId)
if not sess then return {'ERR', 'NOT_FOUND'} end
if sess.clientId ~= clientId then return {'ERR', 'FORBIDDEN'} end
if sess.state == 'ACTIVE' then
  local dev = getjson(prefix..'device:'..sess.deviceId)
  return {'OK', cjson.encode(sess), cjson.encode(dev)}
end
if sess.state ~= 'RESERVED' then return {'ERR', 'BAD_STATE'} end
-- tokenHash '' is the server-internal reconnect-claim path: the client already
-- proved identity via its client token (clientId check above).
if tokenHash ~= '' and sess.claimTokenHash ~= tokenHash then return {'ERR', 'FORBIDDEN'} end
if now > sess.claimDeadline then return {'ERR', 'CLAIM_EXPIRED'} end
sess.state = 'ACTIVE'
sess.activatedAt = now
sess.expiresAt = now + sessionMaxMs
sess.lastHeartbeatAt = now
sess.claimDeadline = nil
setjson(prefix..'session:'..sessionId, sess)
local dev = getjson(prefix..'device:'..sess.deviceId)
if dev then
  dev.state = 'IN_USE'
  setjson(prefix..'device:'..sess.deviceId, dev)
end
emit(prefix, 'SESSION_ACTIVATED', {
  clientId = clientId, sessionId = sessionId, deviceId = sess.deviceId,
})
return {'OK', cjson.encode(sess), cjson.encode(dev)}
`,

  /**
   * Begin termination: session -> ENDING/EXPIRED, device -> CLEANING.
   * ARGV: prefix, sessionId, reason, terminalState(ENDING|EXPIRED), now, expectedFence('' = skip check)
   * Returns: {'OK', sessionJson} or {'ERR', code}
   */
  beginTermination: `${LUA_HELPERS}
local prefix, sessionId, reason, termState, now, expectedFence =
  ARGV[1], ARGV[2], ARGV[3], ARGV[4], tonumber(ARGV[5]), ARGV[6]
local sess = getjson(prefix..'session:'..sessionId)
if not sess then return {'ERR', 'NOT_FOUND'} end
if sess.state == 'ENDING' or sess.state == 'EXPIRED' or sess.state == 'CLEANING'
   or sess.state == 'ENDED' then
  return {'ERR', 'ALREADY_TERMINAL'}
end
if expectedFence ~= '' and tostring(sess.leaseFence) ~= expectedFence then
  return {'ERR', 'FENCE'}
end
sess.state = termState
sess.endReason = reason
setjson(prefix..'session:'..sessionId, sess)
redis.call('DEL', prefix..'client-session:'..sess.clientId)
redis.call('DEL', prefix..'lease:'..sessionId)
local dev = getjson(prefix..'device:'..sess.deviceId)
if dev and dev.currentSessionId == sessionId then
  dev.state = 'CLEANING'
  setjson(prefix..'device:'..sess.deviceId, dev)
end
local evtype = termState == 'EXPIRED' and 'SESSION_EXPIRED' or 'SESSION_ENDED'
emit(prefix, evtype, {
  clientId = sess.clientId, sessionId = sessionId,
  deviceId = sess.deviceId, reason = reason,
})
emit(prefix, 'CLEANUP_STARTED', {sessionId = sessionId, deviceId = sess.deviceId})
return {'OK', cjson.encode(sess)}
`,

  /**
   * Finish cleanup: session -> ENDED; device -> AVAILABLE on success, else
   * failureCount++ and OFFLINE past the threshold.
   * ARGV: prefix, sessionId, deviceId, ok('1'|'0'), now, maxFailures
   * Returns: {'OK', deviceStateAfter} or {'ERR', code}
   */
  finishCleanup: `${LUA_HELPERS}
local prefix, sessionId, deviceId, ok, now, maxFailures =
  ARGV[1], ARGV[2], ARGV[3], ARGV[4], tonumber(ARGV[5]), tonumber(ARGV[6])
local sess = getjson(prefix..'session:'..sessionId)
if sess and sess.state ~= 'ENDED' then
  sess.state = 'ENDED'
  setjson(prefix..'session:'..sessionId, sess)
  redis.call('PEXPIRE', prefix..'session:'..sessionId, 3600000)
end
redis.call('SREM', prefix..'sessions', sessionId)
redis.call('DEL', prefix..'lease:'..sessionId)
local dev = getjson(prefix..'device:'..deviceId)
if not dev then return {'ERR', 'NO_DEVICE'} end
if dev.currentSessionId ~= sessionId then
  -- Another allocation already owns this device; never touch it.
  return {'ERR', 'STALE'}
end
if ok == '1' then
  dev.state = 'AVAILABLE'
  dev.currentSessionId = nil
  dev.failureCount = 0
  dev.lastHealthAt = now
  setjson(prefix..'device:'..deviceId, dev)
  redis.call('SADD', prefix..'avail', deviceId)
  emit(prefix, 'CLEANUP_COMPLETED', {sessionId = sessionId, deviceId = deviceId})
  return {'OK', 'AVAILABLE'}
end
dev.failureCount = (dev.failureCount or 0) + 1
if dev.failureCount >= maxFailures then
  dev.state = 'OFFLINE'
  dev.currentSessionId = nil
  setjson(prefix..'device:'..deviceId, dev)
  emit(prefix, 'DEVICE_OFFLINE', {deviceId = deviceId})
  return {'OK', 'OFFLINE'}
end
setjson(prefix..'device:'..deviceId, dev)
emit(prefix, 'CLEANUP_FAILED', {sessionId = sessionId, deviceId = deviceId, attempt = dev.failureCount})
return {'OK', 'CLEANING'}
`,

  /**
   * Heartbeat / lease renewal for a live session.
   * ARGV: prefix, sessionId, clientId(''=server-side renewal), now, leaseTtlMs
   * Returns: 'OK' | 'GONE'
   */
  heartbeat: `${LUA_HELPERS}
local prefix, sessionId, clientId, now, leaseTtlMs =
  ARGV[1], ARGV[2], ARGV[3], tonumber(ARGV[4]), tonumber(ARGV[5])
local sess = getjson(prefix..'session:'..sessionId)
if not sess or not nonterminal(sess.state) then return 'GONE' end
if clientId ~= '' then
  if sess.clientId ~= clientId then return 'GONE' end
  sess.lastHeartbeatAt = now
  setjson(prefix..'session:'..sessionId, sess)
end
redis.call('SET', prefix..'lease:'..sessionId, '1', 'PX', leaseTtlMs)
return 'OK'
`,

  /**
   * ACTIVE -> DISCONNECTED with a reconnect deadline.
   * ARGV: prefix, sessionId, now, deadline
   * Returns: 'OK' | 'IGNORED'
   */
  markDisconnected: `${LUA_HELPERS}
local prefix, sessionId, now, deadline =
  ARGV[1], ARGV[2], tonumber(ARGV[3]), tonumber(ARGV[4])
local sess = getjson(prefix..'session:'..sessionId)
if not sess or sess.state ~= 'ACTIVE' then return 'IGNORED' end
sess.state = 'DISCONNECTED'
sess.reconnectDeadline = deadline
setjson(prefix..'session:'..sessionId, sess)
emit(prefix, 'CLIENT_DISCONNECTED', {
  clientId = sess.clientId, sessionId = sessionId, deviceId = sess.deviceId,
})
return 'OK'
`,

  /**
   * DISCONNECTED -> ACTIVE for the same client within grace.
   * ARGV: prefix, sessionId, clientId, now
   * Returns: {'OK', sessionJson, deviceJson} or {'ERR', code}
   */
  reconnect: `${LUA_HELPERS}
local prefix, sessionId, clientId, now =
  ARGV[1], ARGV[2], ARGV[3], tonumber(ARGV[4])
local sess = getjson(prefix..'session:'..sessionId)
if not sess then return {'ERR', 'NOT_FOUND'} end
if sess.clientId ~= clientId then return {'ERR', 'FORBIDDEN'} end
if sess.state == 'ACTIVE' then
  local dev = getjson(prefix..'device:'..sess.deviceId)
  return {'OK', cjson.encode(sess), cjson.encode(dev)}
end
if sess.state ~= 'DISCONNECTED' then return {'ERR', 'BAD_STATE'} end
if sess.reconnectDeadline and now > sess.reconnectDeadline then
  return {'ERR', 'GRACE_EXPIRED'}
end
sess.state = 'ACTIVE'
sess.reconnectDeadline = nil
sess.lastHeartbeatAt = now
setjson(prefix..'session:'..sessionId, sess)
redis.call('SET', prefix..'client-session:'..clientId, sessionId)
emit(prefix, 'SESSION_RECONNECTED', {
  clientId = clientId, sessionId = sessionId, deviceId = sess.deviceId,
})
local dev = getjson(prefix..'device:'..sess.deviceId)
return {'OK', cjson.encode(sess), cjson.encode(dev)}
`,

  /**
   * Health transition, atomic against the allocator.
   * ARGV: prefix, deviceId, healthy('1'|'0'), now
   * Returns: 'OK' | 'OFFLINE' | 'RECOVERED' | 'SESSION_UNHEALTHY' | 'MISSING'
   */
  healthUpdate: `${LUA_HELPERS}
local prefix, deviceId, healthy, now = ARGV[1], ARGV[2], ARGV[3], tonumber(ARGV[4])
local dev = getjson(prefix..'device:'..deviceId)
if not dev then return 'MISSING' end
if dev.state == 'AVAILABLE' and healthy == '0' then
  dev.state = 'OFFLINE'
  dev.lastHealthAt = now
  setjson(prefix..'device:'..deviceId, dev)
  redis.call('SREM', prefix..'avail', deviceId)
  emit(prefix, 'DEVICE_OFFLINE', {deviceId = deviceId})
  return 'OFFLINE'
end
if dev.state == 'OFFLINE' and healthy == '1' and not dev.currentSessionId then
  dev.state = 'AVAILABLE'
  dev.failureCount = 0
  dev.lastHealthAt = now
  setjson(prefix..'device:'..deviceId, dev)
  redis.call('SADD', prefix..'avail', deviceId)
  emit(prefix, 'DEVICE_RECOVERED', {deviceId = deviceId})
  return 'RECOVERED'
end
if (dev.state == 'IN_USE' or dev.state == 'RESERVED') and healthy == '0' then
  return 'SESSION_UNHEALTHY'
end
dev.lastHealthAt = now
setjson(prefix..'device:'..deviceId, dev)
if dev.state == 'AVAILABLE' then
  -- self-heal: an AVAILABLE device must be poppable by the allocator
  redis.call('SADD', prefix..'avail', deviceId)
end
return 'OK'
`,

  /**
   * Record the highest applied input sequence without racing state changes.
   * ARGV: prefix, sessionId, seq
   */
  updateInputSeq: `${LUA_HELPERS}
local prefix, sessionId, seq = ARGV[1], ARGV[2], tonumber(ARGV[3])
local sess = getjson(prefix..'session:'..sessionId)
if not sess or not nonterminal(sess.state) then return 'IGNORED' end
if seq > (sess.lastAcceptedInputSeq or 0) then
  sess.lastAcceptedInputSeq = seq
  setjson(prefix..'session:'..sessionId, sess)
end
return 'OK'
`,

  /**
   * Cancel a waiting queue entry.
   * ARGV: prefix, requestId, clientId(''=any, for reaper), reason
   * Returns: 'OK' | 'IGNORED'
   */
  cancelRequest: `${LUA_HELPERS}
local prefix, requestId, clientId, reason = ARGV[1], ARGV[2], ARGV[3], ARGV[4]
local qe = getjson(prefix..'qe:'..requestId)
if not qe or qe.state ~= 'WAITING' then return 'IGNORED' end
if clientId ~= '' and qe.clientId ~= clientId then return 'IGNORED' end
qe.state = reason == 'expired' and 'EXPIRED' or 'CANCELLED'
setjson(prefix..'qe:'..requestId, qe)
redis.call('PEXPIRE', prefix..'qe:'..requestId, 3600000)
redis.call('ZREM', prefix..'queue', requestId)
redis.call('DEL', prefix..'client-request:'..qe.clientId)
local evtype = reason == 'expired' and 'QUEUE_EXPIRED' or 'QUEUE_CANCELLED'
emit(prefix, evtype, {clientId = qe.clientId, requestId = requestId})
return 'OK'
`,
} as const;

type ScriptName = keyof typeof SCRIPTS;

export type StoreResult<T> =
  { ok: true; value: T } | { ok: false; code: string };

export class LabStore {
  private shas = new Map<ScriptName, string>();

  constructor(
    readonly redis: Redis,
    readonly prefix: string,
  ) {}

  key(suffix: string): string {
    return `${this.prefix}${suffix}`;
  }

  private async run(
    name: ScriptName,
    argv: (string | number)[],
  ): Promise<unknown> {
    let sha = this.shas.get(name);
    if (!sha) {
      sha = (await this.redis.script("LOAD", SCRIPTS[name])) as string;
      this.shas.set(name, sha);
    }
    try {
      return await this.redis.evalsha(sha, 0, ...argv.map(String));
    } catch (err) {
      if (err instanceof Error && err.message.includes("NOSCRIPT")) {
        this.shas.delete(name);
        return this.run(name, argv);
      }
      throw err;
    }
  }

  async joinQueue(
    clientId: string,
    clientTokenHash: string,
    requestId: string,
    now: number,
  ): Promise<
    | { kind: "SESSION"; session: Session }
    | { kind: "WAITING" | "JOINED"; entry: QueueEntry }
  > {
    const res = (await this.run("joinQueue", [
      this.prefix,
      clientId,
      clientTokenHash,
      requestId,
      now,
    ])) as [string, string];
    if (res[0] === "SESSION")
      return { kind: "SESSION", session: JSON.parse(res[1]) };
    return { kind: res[0] as "WAITING" | "JOINED", entry: JSON.parse(res[1]) };
  }

  async allocate(args: {
    now: number;
    sessionId: string;
    claimTokenHash: string;
    claimMs: number;
    sessionMaxMs: number;
    leaseTtlMs: number;
  }): Promise<{
    session: Session;
    device: Device;
    requestId: string;
    enqueuedAt: number;
  } | null> {
    const res = (await this.run("allocate", [
      this.prefix,
      args.now,
      args.sessionId,
      args.claimTokenHash,
      args.claimMs,
      args.sessionMaxMs,
      args.leaseTtlMs,
    ])) as [string, string, string, string] | null;
    if (!res) return null;
    return {
      session: JSON.parse(res[0]),
      device: JSON.parse(res[1]),
      requestId: res[2],
      enqueuedAt: Number(res[3]),
    };
  }

  async claim(
    sessionId: string,
    clientId: string,
    claimTokenHash: string,
    now: number,
    sessionMaxMs: number,
  ): Promise<StoreResult<{ session: Session; device: Device }>> {
    const res = (await this.run("claim", [
      this.prefix,
      sessionId,
      clientId,
      claimTokenHash,
      now,
      sessionMaxMs,
    ])) as string[];
    if (res[0] !== "OK") return { ok: false, code: res[1] ?? "UNKNOWN" };
    return {
      ok: true,
      value: { session: JSON.parse(res[1]!), device: JSON.parse(res[2]!) },
    };
  }

  async beginTermination(
    sessionId: string,
    reason: string,
    terminalState: "ENDING" | "EXPIRED",
    now: number,
    expectedFence?: number,
  ): Promise<StoreResult<Session>> {
    const res = (await this.run("beginTermination", [
      this.prefix,
      sessionId,
      reason,
      terminalState,
      now,
      expectedFence === undefined ? "" : String(expectedFence),
    ])) as string[];
    if (res[0] !== "OK") return { ok: false, code: res[1] ?? "UNKNOWN" };
    return { ok: true, value: JSON.parse(res[1]!) };
  }

  async finishCleanup(
    sessionId: string,
    deviceId: string,
    ok: boolean,
    now: number,
    maxFailures: number,
  ): Promise<StoreResult<"AVAILABLE" | "OFFLINE" | "CLEANING">> {
    const res = (await this.run("finishCleanup", [
      this.prefix,
      sessionId,
      deviceId,
      ok ? "1" : "0",
      now,
      maxFailures,
    ])) as string[];
    if (res[0] !== "OK") return { ok: false, code: res[1] ?? "UNKNOWN" };
    return { ok: true, value: res[1] as "AVAILABLE" | "OFFLINE" | "CLEANING" };
  }

  async heartbeat(
    sessionId: string,
    clientId: string | null,
    now: number,
    leaseTtlMs: number,
  ): Promise<"OK" | "GONE"> {
    return (await this.run("heartbeat", [
      this.prefix,
      sessionId,
      clientId ?? "",
      now,
      leaseTtlMs,
    ])) as "OK" | "GONE";
  }

  async markDisconnected(
    sessionId: string,
    now: number,
    deadline: number,
  ): Promise<"OK" | "IGNORED"> {
    return (await this.run("markDisconnected", [
      this.prefix,
      sessionId,
      now,
      deadline,
    ])) as "OK" | "IGNORED";
  }

  async reconnect(
    sessionId: string,
    clientId: string,
    now: number,
  ): Promise<StoreResult<{ session: Session; device: Device }>> {
    const res = (await this.run("reconnect", [
      this.prefix,
      sessionId,
      clientId,
      now,
    ])) as string[];
    if (res[0] !== "OK") return { ok: false, code: res[1] ?? "UNKNOWN" };
    return {
      ok: true,
      value: { session: JSON.parse(res[1]!), device: JSON.parse(res[2]!) },
    };
  }

  async cancelRequest(
    requestId: string,
    clientId: string | null,
    reason: "cancelled" | "expired",
  ): Promise<"OK" | "IGNORED"> {
    return (await this.run("cancelRequest", [
      this.prefix,
      requestId,
      clientId ?? "",
      reason,
    ])) as "OK" | "IGNORED";
  }

  // ---------- plain reads / writes ----------

  async getSession(sessionId: string): Promise<Session | null> {
    const raw = await this.redis.get(this.key(`session:${sessionId}`));
    return raw ? (JSON.parse(raw) as Session) : null;
  }

  async getDevice(deviceId: string): Promise<Device | null> {
    const raw = await this.redis.get(this.key(`device:${deviceId}`));
    return raw ? (JSON.parse(raw) as Device) : null;
  }

  async listDeviceIds(): Promise<string[]> {
    return this.redis.smembers(this.key("devices"));
  }

  async listNonterminalSessionIds(): Promise<string[]> {
    return this.redis.smembers(this.key("sessions"));
  }

  async hasLease(sessionId: string): Promise<boolean> {
    return (await this.redis.exists(this.key(`lease:${sessionId}`))) === 1;
  }

  async getQueueEntry(requestId: string): Promise<QueueEntry | null> {
    const raw = await this.redis.get(this.key(`qe:${requestId}`));
    return raw ? (JSON.parse(raw) as QueueEntry) : null;
  }

  async getClientSessionId(clientId: string): Promise<string | null> {
    return this.redis.get(this.key(`client-session:${clientId}`));
  }

  async getClientRequestId(clientId: string): Promise<string | null> {
    return this.redis.get(this.key(`client-request:${clientId}`));
  }

  /** Ordered waiting request ids (authoritative queue order). */
  async queueOrder(): Promise<string[]> {
    return this.redis.zrange(this.key("queue"), 0, -1);
  }

  async queueDepth(): Promise<number> {
    return this.redis.zcard(this.key("queue"));
  }

  async setDevice(device: Device): Promise<void> {
    await this.redis.set(
      this.key(`device:${device.id}`),
      JSON.stringify(device),
    );
  }

  async registerDevice(device: Device, available: boolean): Promise<void> {
    const multi = this.redis.multi();
    multi.sadd(this.key("devices"), device.id);
    multi.set(this.key(`device:${device.id}`), JSON.stringify(device));
    if (available) multi.sadd(this.key("avail"), device.id);
    else multi.srem(this.key("avail"), device.id);
    await multi.exec();
  }

  async unregisterDevice(deviceId: string): Promise<void> {
    const multi = this.redis.multi();
    multi.srem(this.key("devices"), deviceId);
    multi.srem(this.key("avail"), deviceId);
    multi.del(this.key(`device:${deviceId}`));
    await multi.exec();
  }

  async setDeviceAvailability(
    deviceId: string,
    available: boolean,
  ): Promise<void> {
    if (available) await this.redis.sadd(this.key("avail"), deviceId);
    else await this.redis.srem(this.key("avail"), deviceId);
  }

  async updateSessionInputSeq(sessionId: string, seq: number): Promise<void> {
    await this.run("updateInputSeq", [this.prefix, sessionId, seq]);
  }

  async healthUpdate(
    deviceId: string,
    healthy: boolean,
    now: number,
  ): Promise<"OK" | "OFFLINE" | "RECOVERED" | "SESSION_UNHEALTHY" | "MISSING"> {
    return (await this.run("healthUpdate", [
      this.prefix,
      deviceId,
      healthy ? "1" : "0",
      now,
    ])) as "OK" | "OFFLINE" | "RECOVERED" | "SESSION_UNHEALTHY" | "MISSING";
  }

  async setStreamPids(deviceId: string, pids: number[]): Promise<void> {
    if (pids.length === 0)
      await this.redis.del(this.key(`stream-pids:${deviceId}`));
    else
      await this.redis.set(
        this.key(`stream-pids:${deviceId}`),
        JSON.stringify(pids),
      );
  }

  async getStreamPids(deviceId: string): Promise<number[]> {
    const raw = await this.redis.get(this.key(`stream-pids:${deviceId}`));
    return raw ? (JSON.parse(raw) as number[]) : [];
  }

  async emitEvent(
    type: LabEventType,
    fields: Record<string, string | number>,
  ): Promise<void> {
    const args: string[] = ["type", type];
    for (const [k, v] of Object.entries(fields)) args.push(k, String(v));
    await this.redis.xadd(
      this.key("events"),
      "MAXLEN",
      "~",
      1000,
      "*",
      ...args,
    );
  }

  async recentEvents(count = 50): Promise<Record<string, string>[]> {
    const rows = (await this.redis.xrevrange(
      this.key("events"),
      "+",
      "-",
      "COUNT",
      count,
    )) as [string, string[]][];
    return rows.map(([id, fields]) => {
      const out: Record<string, string> = { id };
      for (let i = 0; i < fields.length; i += 2)
        out[fields[i]!] = fields[i + 1]!;
      return out;
    });
  }
}
