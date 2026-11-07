// Living Lab identity: who owns a passport, proven by a one-time code sent to their email.
// Design: docs/hri-living-lab-identity-design.md
//
// Framework-free and server-only (node:crypto). Everything outside this file is injected through
// IdentityDeps, so the whole flow is unit-tested with an in-memory store and mailer.
//
// Interface (what a caller must know):
// - requestCode(email, caller, language): sends a 6-digit code. Same answer for known and unknown
//   emails. A new code replaces the previous one. Resend is allowed after 60 s.
// - verifyCode(email, code, caller): a code works once, for 10 minutes, and dies after 5 wrong tries.
//   Success creates the participant on first use and returns a signed session token (14 days).
// - readSession(token): never throws; a forged, expired or revoked token returns null.
// Emails are normalised (trim + lowercase) inside; callers pass them as typed.
import { createHmac, randomInt, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { RateDecision } from "./passport-api";

export const IDENTITY_LIMITS = {
  codeTtlSeconds: 10 * 60,
  maxAttempts: 5,
  resendCooldownSeconds: 60,
  sessionMaxAgeSeconds: 14 * 24 * 60 * 60,
  sendPerEmail: { scope: "id-send-email", limit: 3, windowSeconds: 600 },
  sendPerCaller: { scope: "id-send-ip", limit: 10, windowSeconds: 3600 },
  verifyPerCaller: { scope: "id-verify-ip", limit: 30, windowSeconds: 600 }
} as const;

// Used only outside production when HRI_IDENTITY_SECRET is unset (local dev and Playwright), so
// the dev server and the test helper sign session tokens with the same key.
export const DEV_ONLY_IDENTITY_SECRET = "dev-only-living-lab-identity-secret";

export type Participant = { id: string; email: string };
export type IdentityLanguage = "th" | "en";

export type RequestResult =
  | { ok: true; resendInSeconds: number }
  | { ok: false; error: "invalid_email" | "rate_limited" | "send_failed"; retryAfterSeconds?: number };

export type VerifyResult =
  | { ok: true; participant: Participant; sessionToken: string; maxAgeSeconds: number }
  | { ok: false; error: "wrong_code" | "expired" | "too_many_attempts" | "rate_limited"; retryAfterSeconds?: number };

// The external seam. Adapters: emailJsMailer (production, lib/hri/identity-emailjs.ts) and an
// in-memory mailer in the unit tests. send() throws when the message could not be sent.
export type OtpMailer = {
  send(message: { toEmail: string; code: string; expiresInMinutes: number; language: IdentityLanguage }): Promise<void>;
};

export type ChallengeRecord = {
  id: string;
  email: string;
  codeHash: string;
  attempts: number;
  expiresAt: Date;
  consumedAt: Date | null;
  createdAt: Date;
};
export type ParticipantRecord = { id: string; email: string; sessionVersion: number };

// Storage the module needs. Adapters: Prisma (lib/hri/identity-store.ts) and in-memory (tests).
export type IdentityStore = {
  latestChallenge(email: string): Promise<ChallengeRecord | null>;
  // Stores a new challenge and closes every earlier open challenge for the same email.
  replaceChallenge(input: { email: string; codeHash: string; expiresAt: Date; now: Date }): Promise<ChallengeRecord>;
  discardChallenge(id: string): Promise<void>;
  // Increments the attempt counter and returns the new value.
  recordFailedAttempt(id: string): Promise<number>;
  // Marks the challenge consumed. Returns false if another request consumed it first.
  consumeChallenge(id: string, now: Date): Promise<boolean>;
  upsertParticipant(email: string, now: Date): Promise<ParticipantRecord>;
  findParticipant(id: string): Promise<ParticipantRecord | null>;
};

type RateFn = (key: string, limit: number, windowSeconds: number) => Promise<RateDecision>;

export type IdentityDeps = {
  mailer: OtpMailer;
  store: IdentityStore;
  consume: RateFn;
  now: () => Date;
  secret: string;
};

const emailSchema = z.string().max(254).email();
const CODE_PATTERN = /^\d{6}$/;

export function normaliseEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const email = raw.trim().toLowerCase();
  return emailSchema.safeParse(email).success ? email : null;
}

// For screens other people may see: "wutthisak@gmail.com" -> "wu•••@gmail.com".
export function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at < 1) return "•••";
  return `${email.slice(0, Math.min(2, at))}•••${email.slice(at)}`;
}

// Whether a new passport must have a verified owner. On by default; HRI_IDENTITY_REQUIRED=false is the
// event-day fallback for when EmailJS cannot send (quota or outage). Only the exact string "false" turns it off.
export function identityRequiredFromEnv(value: string | undefined): boolean {
  return value?.trim().toLowerCase() !== "false";
}

// Who owns a passport about to be created: the verified participant if there is one; nobody if
// identity is optional; otherwise the save is refused.
export function ownerForNewPassport(participant: Participant | null, required: boolean):
  | { ok: true; participantId: string | null }
  | { ok: false; error: "identity_required" } {
  if (participant) return { ok: true, participantId: participant.id };
  return required ? { ok: false, error: "identity_required" } : { ok: true, participantId: null };
}

export function createIdentity(deps: IdentityDeps) {
  if (!deps.secret || deps.secret.length < 16) throw new Error("Identity secret must be at least 16 characters.");
  const L = IDENTITY_LIMITS;
  const hmac = (purpose: string, value: string) => createHmac("sha256", deps.secret).update(`${purpose}:${value}`).digest();
  const codeHash = (email: string, code: string) => hmac("otp", `${email}:${code}`).toString("hex");
  const emailKey = (email: string) => hmac("email", email).toString("base64url").slice(0, 22);
  const sameHex = (a: string, b: string) => {
    const x = Buffer.from(a, "hex");
    const y = Buffer.from(b, "hex");
    return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
  };
  const secondsUntil = (date: Date) => Math.max(0, Math.ceil((date.getTime() - deps.now().getTime()) / 1000));

  const sessionSignature = (payload: string) => hmac("session", payload).toString("base64url");

  async function requestCode(emailRaw: unknown, caller: string, language: IdentityLanguage): Promise<RequestResult> {
    const email = normaliseEmail(emailRaw);
    if (!email) return { ok: false, error: "invalid_email" };

    const byCaller = await deps.consume(`${L.sendPerCaller.scope}:${caller}`, L.sendPerCaller.limit, L.sendPerCaller.windowSeconds);
    if (!byCaller.allowed) return { ok: false, error: "rate_limited", retryAfterSeconds: byCaller.retryAfterSeconds };

    const now = deps.now();
    const latest = await deps.store.latestChallenge(email);
    if (latest && !latest.consumedAt) {
      const resendAt = new Date(latest.createdAt.getTime() + L.resendCooldownSeconds * 1000);
      if (resendAt > now) return { ok: false, error: "rate_limited", retryAfterSeconds: secondsUntil(resendAt) };
    }

    const byEmail = await deps.consume(`${L.sendPerEmail.scope}:${emailKey(email)}`, L.sendPerEmail.limit, L.sendPerEmail.windowSeconds);
    if (!byEmail.allowed) return { ok: false, error: "rate_limited", retryAfterSeconds: byEmail.retryAfterSeconds };

    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    const challenge = await deps.store.replaceChallenge({
      email,
      codeHash: codeHash(email, code),
      expiresAt: new Date(now.getTime() + L.codeTtlSeconds * 1000),
      now
    });
    try {
      await deps.mailer.send({ toEmail: email, code, expiresInMinutes: L.codeTtlSeconds / 60, language });
    } catch {
      // Nothing usable is left behind, and the resend cooldown does not apply to a failed send.
      await deps.store.discardChallenge(challenge.id);
      return { ok: false, error: "send_failed" };
    }
    return { ok: true, resendInSeconds: L.resendCooldownSeconds };
  }

  async function verifyCode(emailRaw: unknown, codeRaw: unknown, caller: string): Promise<VerifyResult> {
    const byCaller = await deps.consume(`${L.verifyPerCaller.scope}:${caller}`, L.verifyPerCaller.limit, L.verifyPerCaller.windowSeconds);
    if (!byCaller.allowed) return { ok: false, error: "rate_limited", retryAfterSeconds: byCaller.retryAfterSeconds };

    const email = normaliseEmail(emailRaw);
    const code = typeof codeRaw === "string" ? codeRaw.replace(/\s+/g, "") : "";
    if (!email) return { ok: false, error: "wrong_code" };

    const challenge = await deps.store.latestChallenge(email);
    if (!challenge || challenge.consumedAt) return { ok: false, error: "expired" };
    if (challenge.attempts >= L.maxAttempts) return { ok: false, error: "too_many_attempts" };
    const now = deps.now();
    if (challenge.expiresAt <= now) return { ok: false, error: "expired" };

    if (!CODE_PATTERN.test(code) || !sameHex(codeHash(email, code), challenge.codeHash)) {
      const attempts = await deps.store.recordFailedAttempt(challenge.id);
      return { ok: false, error: attempts >= L.maxAttempts ? "too_many_attempts" : "wrong_code" };
    }
    if (!(await deps.store.consumeChallenge(challenge.id, now))) return { ok: false, error: "expired" };

    const participant = await deps.store.upsertParticipant(email, now);
    const expiresAt = Math.floor(now.getTime() / 1000) + L.sessionMaxAgeSeconds;
    const payload = `${participant.id}.${expiresAt}.${participant.sessionVersion}`;
    return {
      ok: true,
      participant: { id: participant.id, email: participant.email },
      sessionToken: `${payload}.${sessionSignature(payload)}`,
      maxAgeSeconds: L.sessionMaxAgeSeconds
    };
  }

  async function readSession(token: string | null | undefined): Promise<Participant | null> {
    try {
      if (!token) return null;
      const parts = token.split(".");
      if (parts.length !== 4) return null;
      const [id, expiresRaw, versionRaw, signature] = parts;
      const payload = `${id}.${expiresRaw}.${versionRaw}`;
      const expected = Buffer.from(sessionSignature(payload));
      const given = Buffer.from(signature);
      if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
      if (Number(expiresRaw) * 1000 <= deps.now().getTime()) return null;
      const participant = await deps.store.findParticipant(id);
      if (!participant || String(participant.sessionVersion) !== versionRaw) return null;
      return { id: participant.id, email: participant.email };
    } catch {
      return null;
    }
  }

  return { requestCode, verifyCode, readSession };
}

export type Identity = ReturnType<typeof createIdentity>;
