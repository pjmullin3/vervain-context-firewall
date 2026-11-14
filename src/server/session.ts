/**
 * Responsibility: Opaque server-owned synthetic demo session store, HMAC cookie signing,
 * persona rotation, concurrency state generation tracking, and per-session spend/rate caps.
 * Trust boundary: Sole source of request authority (`tenantId`, `principalId`, `policyEpoch`,
 * `requestScopeTag`). Never accepts client-supplied authority overrides.
 */

import crypto from 'node:crypto';
import type {
  ArmExecutionView,
  PersonaId,
  SafePersonaView,
} from '../shared/contracts.js';
import { TENANT_FIXTURES } from './fixture.js';

export interface ServerAuthoritySnapshot {
  readonly sessionId: string;
  readonly persona: PersonaId;
  readonly tenantId: 'tenant_alder' | 'tenant_beacon';
  readonly tenantLabel: string;
  readonly principalId: string;
  readonly principalDisplay: string;
  readonly policyId: string;
  readonly policyEpoch: number;
  readonly requestScopeTag: number;
  readonly createdAtMs: number;
  readonly expiresAtMs: number;
  readonly stateGeneration: number;
}

interface MutableSessionRecord {
  readonly sessionId: string;
  readonly persona: PersonaId;
  readonly tenantId: 'tenant_alder' | 'tenant_beacon';
  readonly tenantLabel: string;
  readonly principalId: string;
  readonly principalDisplay: string;
  readonly policyId: string;
  policyEpoch: number;
  readonly initialPolicyEpoch: number;
  readonly requestScopeTag: number;
  readonly createdAtMs: number;
  expiresAtMs: number;
  stateGeneration: number;
  allocatedRunSeq: number;
  committedRunSeq: number;
  geminiCallsUsed: number;
  mutationTimestampsMs: number[];
  inFlightRuns: Map<string, Promise<unknown>>;
  latestPairedRun: {
    runGroupId: string;
    nativeOnly: ArmExecutionView;
    nativePlusVervain: ArmExecutionView;
  } | null;
  latestSingleRun: ArmExecutionView | null;
  receiptIds: string[];
}

export class SessionStore {
  private readonly sessions = new Map<string, MutableSessionRecord>();
  private readonly secret: string;
  private readonly ttlMs: number;
  private readonly maxSessions: number;
  private readonly nowFn: () => number;

  constructor(options: {
    secret: string;
    ttlMs: number;
    maxSessions?: number;
    nowFn?: () => number;
  }) {
    this.secret = options.secret;
    this.ttlMs = options.ttlMs;
    this.maxSessions = options.maxSessions ?? 2048;
    this.nowFn = options.nowFn ?? (() => Date.now());
  }

  private signSessionId(sessionId: string): string {
    const mac = crypto
      .createHmac('sha256', this.secret)
      .update(`vervain.session.v1:${sessionId}`, 'utf8')
      .digest('hex');
    return `${sessionId}.${mac}`;
  }

  private verifyCookieToken(rawToken: string): string | null {
    const parts = rawToken.split('.');
    if (parts.length !== 2) return null;
    const [sessionId, suppliedMac] = parts;
    if (!sessionId || !suppliedMac) return null;
    if (!/^[0-9a-f]{64}$/.test(sessionId) || !/^[0-9a-f]{64}$/.test(suppliedMac)) {
      return null;
    }
    const expectedMac = crypto
      .createHmac('sha256', this.secret)
      .update(`vervain.session.v1:${sessionId}`, 'utf8')
      .digest('hex');
    const a = Buffer.from(suppliedMac, 'hex');
    const b = Buffer.from(expectedMac, 'hex');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return null;
    }
    return sessionId;
  }

  private pruneExpiredIfNeeded(nowMs: number): void {
    if (this.sessions.size < this.maxSessions) return;
    for (const [id, rec] of this.sessions.entries()) {
      if (rec.expiresAtMs <= nowMs) {
        this.sessions.delete(id);
      }
    }
    while (this.sessions.size >= this.maxSessions) {
      const oldestKey = this.sessions.keys().next().value;
      if (oldestKey === undefined) break;
      this.sessions.delete(oldestKey);
    }
  }

  /**
   * Creates a new server-owned synthetic session for `persona` and invalidates
   * `previousCookieToken` if supplied (session rotation on persona switch).
   */
  public createOrRotateSession(
    persona: PersonaId,
    previousCookieToken?: string | null,
    principalDisplayOverrideForTest?: string,
  ): { cookieToken: string; snapshot: ServerAuthoritySnapshot } {
    if (previousCookieToken) {
      const oldId = this.verifyCookieToken(previousCookieToken);
      if (oldId) {
        const existing = this.sessions.get(oldId);
        if (existing) {
          existing.stateGeneration += 1;
          this.sessions.delete(oldId);
        }
      }
    }

    const nowMs = this.nowFn();
    this.pruneExpiredIfNeeded(nowMs);

    const fixture = TENANT_FIXTURES[persona];
    const sessionId = crypto.randomBytes(32).toString('hex');
    const record: MutableSessionRecord = {
      sessionId,
      persona: fixture.persona,
      tenantId: fixture.tenantId,
      tenantLabel: fixture.tenantLabel,
      principalId: fixture.principalId,
      principalDisplay: principalDisplayOverrideForTest ?? fixture.principalDisplay,
      policyId: fixture.policyId,
      policyEpoch: fixture.initialPolicyEpoch,
      initialPolicyEpoch: fixture.initialPolicyEpoch,
      requestScopeTag: fixture.requestScopeTag,
      createdAtMs: nowMs,
      expiresAtMs: nowMs + this.ttlMs,
      stateGeneration: 1,
      allocatedRunSeq: 0,
      committedRunSeq: 0,
      geminiCallsUsed: 0,
      mutationTimestampsMs: [],
      inFlightRuns: new Map(),
      latestPairedRun: null,
      latestSingleRun: null,
      receiptIds: [],
    };
    this.sessions.set(sessionId, record);

    return {
      cookieToken: this.signSessionId(sessionId),
      snapshot: this.toSnapshot(record),
    };
  }

  public resolveCookieToken(
    cookieToken: string | null | undefined,
  ):
    | { ok: true; snapshot: ServerAuthoritySnapshot }
    | { ok: false; reason: 'missing_or_invalid' | 'expired' } {
    if (!cookieToken) {
      return { ok: false, reason: 'missing_or_invalid' };
    }
    const sessionId = this.verifyCookieToken(cookieToken);
    if (!sessionId) {
      return { ok: false, reason: 'missing_or_invalid' };
    }
    const record = this.sessions.get(sessionId);
    if (!record) {
      return { ok: false, reason: 'missing_or_invalid' };
    }
    const nowMs = this.nowFn();
    if (record.expiresAtMs <= nowMs) {
      this.sessions.delete(sessionId);
      return { ok: false, reason: 'expired' };
    }
    return { ok: true, snapshot: this.toSnapshot(record) };
  }

  public getSnapshotBySessionId(
    sessionId: string,
  ):
    | { ok: true; snapshot: ServerAuthoritySnapshot }
    | { ok: false; reason: 'missing' | 'expired' } {
    const record = this.sessions.get(sessionId);
    if (!record) {
      return { ok: false, reason: 'missing' };
    }
    if (record.expiresAtMs <= this.nowFn()) {
      this.sessions.delete(sessionId);
      return { ok: false, reason: 'expired' };
    }
    return { ok: true, snapshot: this.toSnapshot(record) };
  }

  public incrementPolicyEpoch(sessionId: string): number | null {
    const record = this.sessions.get(sessionId);
    if (!record || record.expiresAtMs <= this.nowFn()) {
      return null;
    }
    record.policyEpoch += 1;
    return record.policyEpoch;
  }

  public expireSessionNow(sessionId: string): void {
    const record = this.sessions.get(sessionId);
    if (record) {
      record.expiresAtMs = this.nowFn() - 1;
    }
  }

  /**
   * Resets only this synthetic session's run history and restores its initial policy epoch,
   * while incrementing `stateGeneration` so any delayed in-flight run cannot overwrite state.
   */
  public resetSessionState(sessionId: string): ServerAuthoritySnapshot | null {
    const record = this.sessions.get(sessionId);
    if (!record || record.expiresAtMs <= this.nowFn()) {
      return null;
    }
    record.policyEpoch = record.initialPolicyEpoch;
    record.stateGeneration += 1;
    record.latestPairedRun = null;
    record.latestSingleRun = null;
    record.receiptIds = [];
    record.inFlightRuns.clear();
    return this.toSnapshot(record);
  }

  public checkAndRecordMutationRate(sessionId: string, limitPerMinute: number): boolean {
    const record = this.sessions.get(sessionId);
    if (!record) return false;
    const nowMs = this.nowFn();
    const cutoff = nowMs - 60_000;
    record.mutationTimestampsMs = record.mutationTimestampsMs.filter((t) => t > cutoff);
    if (record.mutationTimestampsMs.length >= limitPerMinute) {
      return false;
    }
    record.mutationTimestampsMs.push(nowMs);
    return true;
  }

  public reserveGeminiCalls(sessionId: string, count: number, maxPerSession: number): boolean {
    const record = this.sessions.get(sessionId);
    if (!record) return false;
    if (record.geminiCallsUsed + count > maxPerSession) {
      return false;
    }
    record.geminiCallsUsed += count;
    return true;
  }

  /**
   * Coalesces duplicate clicks on the same action (`actionKey`) while a run is in flight
   * for the same `stateGeneration`.
   */
  public runIdempotentInFlight<T>(
    sessionId: string,
    actionKey: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const record = this.sessions.get(sessionId);
    if (!record) {
      return fn();
    }
    const scopedKey = `${record.stateGeneration}:${actionKey}`;
    const existing = record.inFlightRuns.get(scopedKey);
    if (existing) {
      return existing as Promise<T>;
    }
    const promise = fn().finally(() => {
      if (record.inFlightRuns.get(scopedKey) === promise) {
        record.inFlightRuns.delete(scopedKey);
      }
    });
    record.inFlightRuns.set(scopedKey, promise);
    return promise;
  }

  public allocateRunTicket(sessionId: string): { stateGeneration: number; runSeq: number } | null {
    const record = this.sessions.get(sessionId);
    if (!record || record.expiresAtMs <= this.nowFn()) return null;
    record.allocatedRunSeq += 1;
    return {
      stateGeneration: record.stateGeneration,
      runSeq: record.allocatedRunSeq,
    };
  }

  public registerSessionReceipt(
    sessionId: string,
    expectedGeneration: number,
    receiptId: string,
  ): boolean {
    const record = this.sessions.get(sessionId);
    if (!record || record.expiresAtMs <= this.nowFn()) return false;
    if (record.stateGeneration !== expectedGeneration) return false;
    if (!record.receiptIds.includes(receiptId)) {
      record.receiptIds.push(receiptId);
    }
    return true;
  }

  public ownsReceipt(sessionId: string, receiptId: string): boolean {
    const record = this.sessions.get(sessionId);
    if (!record || record.expiresAtMs <= this.nowFn()) return false;
    return record.receiptIds.includes(receiptId);
  }

  public commitPairedRunIfLatest(
    sessionId: string,
    ticket: { stateGeneration: number; runSeq: number },
    pairedRun: {
      runGroupId: string;
      nativeOnly: ArmExecutionView;
      nativePlusVervain: ArmExecutionView;
    },
  ): boolean {
    const record = this.sessions.get(sessionId);
    if (!record || record.expiresAtMs <= this.nowFn()) return false;
    if (record.stateGeneration !== ticket.stateGeneration) return false;
    if (ticket.runSeq <= record.committedRunSeq) return false;
    record.committedRunSeq = ticket.runSeq;
    record.latestPairedRun = pairedRun;
    return true;
  }

  public commitSingleRunIfLatest(
    sessionId: string,
    ticket: { stateGeneration: number; runSeq: number },
    singleRun: ArmExecutionView,
  ): boolean {
    const record = this.sessions.get(sessionId);
    if (!record || record.expiresAtMs <= this.nowFn()) return false;
    if (record.stateGeneration !== ticket.stateGeneration) return false;
    if (ticket.runSeq <= record.committedRunSeq) return false;
    record.committedRunSeq = ticket.runSeq;
    record.latestSingleRun = singleRun;
    return true;
  }

  public getSessionRunsView(sessionId: string): {
    latestPairedRun: {
      runGroupId: string;
      nativeOnly: ArmExecutionView;
      nativePlusVervain: ArmExecutionView;
    } | null;
    latestSingleRun: ArmExecutionView | null;
    recentReceiptIds: readonly string[];
  } | null {
    const record = this.sessions.get(sessionId);
    if (!record || record.expiresAtMs <= this.nowFn()) return null;
    return {
      latestPairedRun: record.latestPairedRun,
      latestSingleRun: record.latestSingleRun,
      recentReceiptIds: [...record.receiptIds].slice(-20),
    };
  }

  public toSafePersonaView(snapshot: ServerAuthoritySnapshot): SafePersonaView {
    return {
      persona: snapshot.persona,
      tenantLabel: snapshot.tenantLabel,
      principalDisplay: snapshot.principalDisplay,
      policyId: snapshot.policyId,
      policyEpoch: snapshot.policyEpoch,
      sessionHandlePreview: `ses_${snapshot.sessionId.slice(0, 8)}`,
      expiresAtIso: new Date(snapshot.expiresAtMs).toISOString(),
      fixtureNotice: 'synthetic_fixture_not_authentication',
    };
  }

  private toSnapshot(record: MutableSessionRecord): ServerAuthoritySnapshot {
    return Object.freeze({
      sessionId: record.sessionId,
      persona: record.persona,
      tenantId: record.tenantId,
      tenantLabel: record.tenantLabel,
      principalId: record.principalId,
      principalDisplay: record.principalDisplay,
      policyId: record.policyId,
      policyEpoch: record.policyEpoch,
      requestScopeTag: record.requestScopeTag,
      createdAtMs: record.createdAtMs,
      expiresAtMs: record.expiresAtMs,
      stateGeneration: record.stateGeneration,
    });
  }
}

export function buildSetCookieHeader(params: {
  cookieName: string;
  cookieToken: string;
  maxAgeSeconds: number;
  isProduction: boolean;
}): string {
  const parts = [
    `${params.cookieName}=${params.cookieToken}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.max(0, Math.floor(params.maxAgeSeconds))}`,
  ];
  if (params.isProduction) {
    parts.push('Secure');
  }
  return parts.join('; ');
}

export function extractCookieFromHeader(
  cookieHeader: string | undefined,
  cookieName: string,
): string | null {
  if (!cookieHeader) return null;
  const pairs = cookieHeader.split(';');
  let found: string | null = null;
  for (const rawPair of pairs) {
    const eqIdx = rawPair.indexOf('=');
    if (eqIdx === -1) continue;
    const name = rawPair.slice(0, eqIdx).trim();
    const val = rawPair.slice(eqIdx + 1).trim();
    if (name === cookieName) {
      if (found !== null) {
        // Duplicate session cookie in single Cookie header -> reject ambiguity
        return null;
      }
      found = val;
    }
  }
  return found;
}
