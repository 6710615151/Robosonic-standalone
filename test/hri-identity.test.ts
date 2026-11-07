// Living Lab identity, tested only through its interface (createIdentity): in-memory store,
// in-memory mailer and a fake clock stand in for Postgres, EmailJS and time.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createIdentity, IDENTITY_LIMITS, identityRequiredFromEnv, maskEmail, normaliseEmail, ownerForNewPassport,
  type ChallengeRecord, type IdentityStore, type OtpMailer, type ParticipantRecord
} from "../lib/hri/identity";
import type { RateDecision } from "../lib/hri/passport-api";
import { emailJsMailer } from "../lib/hri/identity-emailjs";

const SECRET = "unit-test-secret-at-least-16";

function harness(opts: { mailerFails?: boolean } = {}) {
  let clock = new Date("2026-11-08T09:00:00Z");
  const challenges: ChallengeRecord[] = [];
  const participants: ParticipantRecord[] = [];
  const sent: { toEmail: string; code: string; language: string }[] = [];
  const counts = new Map<string, number>();
  let nextId = 1;

  const store: IdentityStore = {
    async latestChallenge(email) {
      return [...challenges].reverse().find((c) => c.email === email) ?? null;
    },
    async replaceChallenge({ email, codeHash, expiresAt, now }) {
      for (const c of challenges) if (c.email === email && !c.consumedAt) c.consumedAt = now;
      const row = { id: `c${nextId++}`, email, codeHash, attempts: 0, expiresAt, consumedAt: null, createdAt: now };
      challenges.push(row);
      return row;
    },
    async discardChallenge(id) {
      const i = challenges.findIndex((c) => c.id === id);
      if (i >= 0) challenges.splice(i, 1);
    },
    async recordFailedAttempt(id) {
      const c = challenges.find((x) => x.id === id)!;
      return ++c.attempts;
    },
    async consumeChallenge(id, now) {
      const c = challenges.find((x) => x.id === id);
      if (!c || c.consumedAt) return false;
      c.consumedAt = now;
      return true;
    },
    async upsertParticipant(email) {
      let p = participants.find((x) => x.email === email);
      if (!p) participants.push((p = { id: `p${nextId++}`, email, sessionVersion: 1 }));
      return p;
    },
    async findParticipant(id) {
      return participants.find((x) => x.id === id) ?? null;
    }
  };
  const mailer: OtpMailer = {
    async send(message) {
      if (opts.mailerFails) throw new Error("EmailJS responded 500");
      sent.push(message);
    }
  };
  const consume = async (key: string, limit: number): Promise<RateDecision> => {
    const n = (counts.get(key) ?? 0) + 1;
    counts.set(key, n);
    return { allowed: n <= limit, remaining: Math.max(0, limit - n), retryAfterSeconds: 30 };
  };
  const identity = createIdentity({ mailer, store, consume, now: () => clock, secret: SECRET });
  return {
    identity, challenges, participants, sent,
    advance: (seconds: number) => { clock = new Date(clock.getTime() + seconds * 1000); },
    lastCode: () => sent[sent.length - 1].code
  };
}

const ok = <T extends { ok: boolean }>(r: T) => { assert.equal(r.ok, true, JSON.stringify(r)); return r as Extract<T, { ok: true }>; };

test("requestCode emails a 6-digit code and stores only its hash", async () => {
  const h = harness();
  ok(await h.identity.requestCode("wu@gmail.com", "ip1", "th"));
  assert.equal(h.sent.length, 1);
  assert.match(h.lastCode(), /^\d{6}$/);
  assert.equal(h.sent[0].language, "th");
  assert.equal(h.challenges.length, 1);
  assert.notEqual(h.challenges[0].codeHash, h.lastCode());
  assert.ok(!h.challenges[0].codeHash.includes(h.lastCode()), "the stored hash never contains the code");
});

test("the right code signs the participant in, and the session reads back", async () => {
  const h = harness();
  await h.identity.requestCode("wu@gmail.com", "ip1", "en");
  const res = ok(await h.identity.verifyCode("wu@gmail.com", h.lastCode(), "ip1"));
  assert.equal(res.participant.email, "wu@gmail.com");
  assert.equal(res.maxAgeSeconds, 14 * 24 * 60 * 60, "decision 4: sessions last 14 days");
  assert.deepEqual(await h.identity.readSession(res.sessionToken), res.participant);
});

test("a code works only once", async () => {
  const h = harness();
  await h.identity.requestCode("wu@gmail.com", "ip1", "en");
  const code = h.lastCode();
  ok(await h.identity.verifyCode("wu@gmail.com", code, "ip1"));
  const again = await h.identity.verifyCode("wu@gmail.com", code, "ip1");
  assert.deepEqual(again, { ok: false, error: "expired" });
});

test("five wrong codes kill the challenge, even if the sixth is right", async () => {
  const h = harness();
  await h.identity.requestCode("wu@gmail.com", "ip1", "en");
  const right = h.lastCode();
  const wrong = right === "000000" ? "111111" : "000000";
  for (let i = 1; i < IDENTITY_LIMITS.maxAttempts; i++) {
    assert.deepEqual(await h.identity.verifyCode("wu@gmail.com", wrong, "ip1"), { ok: false, error: "wrong_code" });
  }
  assert.deepEqual(await h.identity.verifyCode("wu@gmail.com", wrong, "ip1"), { ok: false, error: "too_many_attempts" });
  assert.deepEqual(await h.identity.verifyCode("wu@gmail.com", right, "ip1"), { ok: false, error: "too_many_attempts" });
  assert.equal(h.participants.length, 0);
});

test("a code expires after 10 minutes", async () => {
  const h = harness();
  await h.identity.requestCode("wu@gmail.com", "ip1", "en");
  h.advance(IDENTITY_LIMITS.codeTtlSeconds + 1);
  assert.deepEqual(await h.identity.verifyCode("wu@gmail.com", h.lastCode(), "ip1"), { ok: false, error: "expired" });
});

test("a new code replaces the old one, and resend waits 60 seconds", async () => {
  const h = harness();
  ok(await h.identity.requestCode("wu@gmail.com", "ip1", "en"));
  const first = h.lastCode();
  const tooSoon = await h.identity.requestCode("wu@gmail.com", "ip1", "en");
  assert.equal(tooSoon.ok, false);
  assert.equal(!tooSoon.ok && tooSoon.error, "rate_limited");
  h.advance(IDENTITY_LIMITS.resendCooldownSeconds);
  ok(await h.identity.requestCode("wu@gmail.com", "ip1", "en"));
  const second = h.lastCode();
  if (first !== second) {
    assert.equal((await h.identity.verifyCode("wu@gmail.com", first, "ip1")).ok, false, "old code no longer works");
  }
  ok(await h.identity.verifyCode("wu@gmail.com", second, "ip1"));
});

test("emails are normalised: the same person however they type it", async () => {
  const h = harness();
  await h.identity.requestCode("  Wu@GMail.com ", "ip1", "en");
  const a = ok(await h.identity.verifyCode("wu@gmail.com", h.lastCode(), "ip1"));
  h.advance(61);
  await h.identity.requestCode("WU@gmail.COM", "ip1", "en");
  const b = ok(await h.identity.verifyCode(" wu@gmail.com", h.lastCode(), "ip1"));
  assert.equal(a.participant.id, b.participant.id);
  assert.equal(h.participants.length, 1);
  assert.equal(normaliseEmail("not an email"), null);
  assert.deepEqual(await h.identity.requestCode("not an email", "ip1", "en"), { ok: false, error: "invalid_email" });
});

test("known and unknown emails get the same answer (no enumeration)", async () => {
  const h = harness();
  await h.identity.requestCode("known@x.org", "ip1", "en");
  ok(await h.identity.verifyCode("known@x.org", h.lastCode(), "ip1"));
  h.advance(61);
  const known = await h.identity.requestCode("known@x.org", "ip2", "en");
  const unknown = await h.identity.requestCode("nobody@x.org", "ip2", "en");
  assert.deepEqual(known, unknown);
});

test("a failed send leaves no usable code and does not start the cooldown", async () => {
  const h = harness({ mailerFails: true });
  assert.deepEqual(await h.identity.requestCode("wu@gmail.com", "ip1", "en"), { ok: false, error: "send_failed" });
  assert.equal(h.challenges.length, 0);
  assert.deepEqual(await h.identity.requestCode("wu@gmail.com", "ip1", "en"), { ok: false, error: "send_failed" }, "retry is not blocked by a cooldown");
});

test("forged, expired or revoked session tokens read as nobody", async () => {
  const h = harness();
  await h.identity.requestCode("wu@gmail.com", "ip1", "en");
  const { sessionToken } = ok(await h.identity.verifyCode("wu@gmail.com", h.lastCode(), "ip1"));
  const [id, exp, ver, sig] = sessionToken.split(".");
  const flip = (s: string) => s.slice(0, -1) + (s.endsWith("A") ? "B" : "A");
  assert.equal(await h.identity.readSession(`${id}.${exp}.${ver}.${flip(sig)}`), null, "tampered signature");
  assert.equal(await h.identity.readSession(`${id}.${Number(exp) + 999}.${ver}.${sig}`), null, "extended expiry");
  assert.equal(await h.identity.readSession("garbage"), null);
  assert.equal(await h.identity.readSession(undefined), null);
  h.participants[0].sessionVersion++;
  assert.equal(await h.identity.readSession(sessionToken), null, "sign out everywhere");
  h.participants[0].sessionVersion--;
  h.advance(IDENTITY_LIMITS.sessionMaxAgeSeconds + 1);
  assert.equal(await h.identity.readSession(sessionToken), null, "expired after 14 days");
});

test("per-client limits stop code guessing across many emails", async () => {
  const h = harness();
  const { limit } = IDENTITY_LIMITS.verifyPerCaller;
  for (let i = 0; i < limit; i++) await h.identity.verifyCode(`x${i}@x.org`, "123456", "attacker");
  const blocked = await h.identity.verifyCode("victim@x.org", "123456", "attacker");
  assert.equal(!blocked.ok && blocked.error, "rate_limited");
});

test("HRI_IDENTITY_REQUIRED: on unless set to exactly false (event-day fallback)", () => {
  assert.equal(identityRequiredFromEnv(undefined), true);
  assert.equal(identityRequiredFromEnv(""), true);
  assert.equal(identityRequiredFromEnv("true"), true);
  assert.equal(identityRequiredFromEnv("0"), true, "only \"false\" turns it off, so a typo keeps the safe default");
  assert.equal(identityRequiredFromEnv("false"), false);
  assert.equal(identityRequiredFromEnv(" FALSE "), false);
});

test("passport owner: verified participant always linked; without one, refused unless identity is optional", () => {
  const p = { id: "p1", email: "wu@gmail.com" };
  assert.deepEqual(ownerForNewPassport(p, true), { ok: true, participantId: "p1" });
  assert.deepEqual(ownerForNewPassport(p, false), { ok: true, participantId: "p1" }, "fallback still links verified people");
  assert.deepEqual(ownerForNewPassport(null, true), { ok: false, error: "identity_required" });
  assert.deepEqual(ownerForNewPassport(null, false), { ok: true, participantId: null });
});

test("maskEmail hides the address on shared screens", () => {
  assert.equal(maskEmail("wutthisak@gmail.com"), "wu•••@gmail.com");
  assert.equal(maskEmail("a@b.co"), "a•••@b.co");
});

test("createIdentity refuses a short secret", () => {
  assert.throws(() => createIdentity({ secret: "short" } as never));
});

test("EmailJS adapter: posts the code with the private key, and throws on a non-2xx", async () => {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const fakeFetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)) });
    return new Response("", { status: calls.length === 1 ? 200 : 403 });
  }) as unknown as typeof fetch;
  const mailer = emailJsMailer({ serviceId: "svc", templateIdTh: "tpl_th", templateIdEn: "tpl_en", publicKey: "pub", privateKey: "priv" }, fakeFetch);
  await mailer.send({ toEmail: "wu@gmail.com", code: "123456", expiresInMinutes: 10, language: "th" });
  assert.equal(calls[0].url, "https://api.emailjs.com/api/v1.0/email/send");
  assert.deepEqual(calls[0].body, {
    service_id: "svc", template_id: "tpl_th", user_id: "pub", accessToken: "priv",
    template_params: { to_email: "wu@gmail.com", passcode: "123456", expires_minutes: 10 }
  });
  await assert.rejects(mailer.send({ toEmail: "wu@gmail.com", code: "123456", expiresInMinutes: 10, language: "en" }), /403/);
});
