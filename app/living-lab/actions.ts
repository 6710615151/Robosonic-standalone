"use server";

import { revalidatePath } from "next/cache";
import type { Prisma } from "../../generated/prisma";
import { prisma } from "@/lib/prisma";
import { newPassportCode, normalizePassportCode, passportSchema, sessionSchema } from "@/lib/hri/passport";
import { OWNER_LIMITS, ownerPatchSchema } from "@/lib/hri/passport-owner";
import { API_LIMITS } from "@/lib/hri/passport-api";
import { consumeActionLimit, consumeRateLimit, currentClientId, peekRateLimit } from "@/lib/hri/rate-limit";
import { hashToken, isWellFormedToken, issuePassportTokens, tokenMatchesHash } from "@/lib/hri/security";
import { minimiseEvents, minimiseSummary } from "@/lib/hri/session-privacy";
import { currentParticipant, identityRequired } from "@/lib/hri/identity-server";
import { ownerForNewPassport } from "@/lib/hri/identity";

// Saves the comfort passport learned in a Living Lab encounter and the encounter log.
// Public by design (visitors create passports); input is validated, size-limited and rate-limited.
// Returns the two secrets exactly once: accessToken (for the QR / robot API) and editToken (owner only).
// Only their SHA-256 hashes are stored.
//
// Consent is a required argument: the UI asks for it before calibration starts (camera included),
// and the timestamp is kept on the passport as the record of that consent.
//
// Expected refusals are returned, not thrown: Next.js hides thrown messages in production.
//
// Identity is required (decision 1, docs/hri-living-lab-identity-design.md): the passport is linked
// to the participant verified by the Living Lab cookie, or the action refuses with "identity_required".
// HRI_IDENTITY_REQUIRED=false makes it optional: an unverified visitor's passport then has no owner.
export async function createPassportAction(passportRaw: unknown, sessionRaw: unknown, consentRaw: unknown) {
  if (consentRaw !== true) return { ok: false as const, error: "consent_required" as const };
  const parsedPassport = passportSchema.safeParse(passportRaw);
  const parsedSession = sessionSchema.safeParse(sessionRaw);
  if (!parsedPassport.success || !parsedSession.success) return { ok: false as const, error: "invalid" as const };
  const passport = parsedPassport.data;
  const session = parsedSession.data;
  const owner = ownerForNewPassport(await currentParticipant(), identityRequired());
  if (!owner.ok) return { ok: false as const, error: owner.error };
  const decision = await consumeActionLimit("create", 10, 3600);
  if (!decision.allowed) {
    return { ok: false as const, error: "rate_limited" as const, retryAfterSeconds: decision.retryAfterSeconds };
  }

  for (let attempt = 0; attempt < 5; attempt++) {
    const code = newPassportCode();
    const tokens = issuePassportTokens();
    try {
      const created = await prisma.hriPassport.create({
        data: {
          code,
          accessTokenHash: tokens.accessTokenHash,
          editTokenHash: tokens.editTokenHash,
          nickname: passport.nickname || null,
          greeting: passport.greeting,
          comfortDistance: passport.comfortDistance,
          speed: passport.speed,
          gaze: passport.gaze,
          voice: passport.voice,
          language: passport.language,
          anxiety: passport.anxiety,
          captions: passport.captions,
          speechPace: passport.speechPace,
          noReach: passport.noReach,
          consentAt: new Date(),
          ...(owner.participantId ? { participant: { connect: { id: owner.participantId } } } : {}),
          sessions: {
            create: {
              protocol: session.protocol,
              inputMode: session.inputMode,
              robotModelId: session.robotModelId || null,
              eventsJson: minimiseEvents(session.events) as Prisma.InputJsonValue,
              summaryJson: minimiseSummary(session.summary) as Prisma.InputJsonValue,
              endedAt: new Date()
            }
          }
        }
      });
      revalidatePath("/living-lab");
      return { ok: true as const, code: created.code, accessToken: tokens.accessToken, editToken: tokens.editToken };
    } catch (error) {
      // Unique-code collision: try another code.
      if ((error as { code?: string }).code === "P2002") continue;
      throw error;
    }
  }
  return { ok: false as const, error: "code_unavailable" as const };
}

// ---------------- owner access (passport card) ----------------

// One gate for every owner action: the shared failed-lookup budget first (peek), then the
// action's own budget (consume). A caller locked out by the robot API cannot try edit keys either.
async function ownerGate(limits: { scope: string; limit: number; windowSeconds: number }) {
  const caller = await currentClientId();
  const miss = API_LIMITS.misses;
  if (!(await peekRateLimit(`miss:${caller}`, miss.limit, miss.windowSeconds)).allowed) {
    return { ok: false as const, error: "rate_limited" as const };
  }
  const decision = await consumeRateLimit(`${limits.scope}:${caller}`, limits.limit, limits.windowSeconds);
  if (!decision.allowed) return { ok: false as const, error: "rate_limited" as const };
  return { ok: true as const, caller };
}

// Looks a passport up by access token, then verifies the presented edit token against its hash.
// Every failure is counted as a miss, so holding the access token alone can never unlock editing.
async function ownedPassport(accessTokenRaw: string, editTokenRaw: string, caller: string) {
  const { limit, windowSeconds } = API_LIMITS.misses;
  const miss = async () => {
    await consumeRateLimit(`miss:${caller}`, limit, windowSeconds);
    return null;
  };
  if (!isWellFormedToken(accessTokenRaw) || !isWellFormedToken(editTokenRaw)) return miss();
  const passport = await prisma.hriPassport.findUnique({
    where: { accessTokenHash: hashToken(accessTokenRaw) },
    select: { id: true, editTokenHash: true, version: true, nickname: true, anxiety: true }
  });
  if (!passport || !tokenMatchesHash(editTokenRaw, passport.editTokenHash)) return miss();
  return passport;
}

// Owner-only view of a passport: the nickname and the anxiety level never appear in the public
// card HTML or the robot API, only in this response after the edit token has been verified.
export async function getOwnerViewAction(accessTokenRaw: string, editTokenRaw: string) {
  const gate = await ownerGate(OWNER_LIMITS.unlock);
  if (!gate.ok) return { ok: false as const, error: gate.error };
  const passport = await ownedPassport(accessTokenRaw, editTokenRaw, gate.caller);
  if (!passport) return { ok: false as const, error: "not_found" as const };
  return { ok: true as const, owner: { nickname: passport.nickname, anxiety: passport.anxiety } };
}

// Applies an owner edit to the preference fields only, then bumps the passport version so robots
// that cache the profile can detect the change. Version, tokens, status and consent stay untouched.
export async function updatePassportAction(accessTokenRaw: string, editTokenRaw: string, patchRaw: unknown) {
  const parsed = ownerPatchSchema.safeParse(patchRaw);
  if (!parsed.success || Object.keys(parsed.data).length === 0) {
    return { ok: false as const, error: "invalid" as const };
  }
  const gate = await ownerGate(OWNER_LIMITS.update);
  if (!gate.ok) return { ok: false as const, error: gate.error };
  const passport = await ownedPassport(accessTokenRaw, editTokenRaw, gate.caller);
  if (!passport) return { ok: false as const, error: "not_found" as const };

  const patch = parsed.data;
  const data: Prisma.HriPassportUpdateInput = { ...patch, version: { increment: 1 } };
  if ("nickname" in patch) {
    const nickname = patch.nickname?.trim();
    data.nickname = nickname ? nickname : null;
  }
  const updated = await prisma.hriPassport.update({
    where: { id: passport.id },
    data,
    select: { version: true, updatedAt: true }
  });
  // No revalidatePath here: both pages are force-dynamic, and revalidating the current card route
  // would make Next refresh it before the client can show the "saved" state.
  return { ok: true as const, version: updated.version, updatedAt: updated.updatedAt.toISOString() };
}

// Hard delete, as agreed: the passport row is removed (sessions survive with passportId = null),
// so the access token in the QR stops working immediately. No revalidation: refreshing the card
// route after deleting would render the 404 page instead of the client's "Passport deleted" screen.
export async function deletePassportAction(accessTokenRaw: string, editTokenRaw: string) {
  const gate = await ownerGate(OWNER_LIMITS.delete);
  if (!gate.ok) return { ok: false as const, error: gate.error };
  const passport = await ownedPassport(accessTokenRaw, editTokenRaw, gate.caller);
  if (!passport) return { ok: false as const, error: "not_found" as const };
  await prisma.hriPassport.delete({ where: { id: passport.id } });
  return { ok: true as const };
}

// Records one care-journey station (or a meeting) between a passport holder and a registry robot,
// including the person's 1-5 comfort rating in the summary.
// Rate-limited; unknown codes count toward the same guessing budget as the robot API.
export async function recordMeetingAction(codeRaw: string, sessionRaw: unknown) {
  const code = normalizePassportCode(codeRaw);
  const parsedSession = sessionSchema.safeParse(sessionRaw);
  if (!parsedSession.success) return { ok: false as const, error: "invalid" as const };
  const session = parsedSession.data;
  if (!(await consumeActionLimit("meeting", 60, 600)).allowed) return { ok: false as const, error: "rate_limited" as const };
  const caller = await currentClientId();
  const { limit, windowSeconds } = API_LIMITS.misses;
  if (!(await peekRateLimit(`miss:${caller}`, limit, windowSeconds)).allowed) {
    return { ok: false as const, error: "rate_limited" as const };
  }
  const passport = await prisma.hriPassport.findUnique({ where: { code }, select: { id: true } });
  if (!passport) {
    await consumeRateLimit(`miss:${caller}`, limit, windowSeconds);
    return { ok: false as const, error: "not_found" as const };
  }

  const robotModelId = session.robotModelId
    ? (await prisma.robotModel.findUnique({ where: { id: session.robotModelId }, select: { id: true } }))?.id ?? null
    : null;

  await prisma.hriSession.create({
    data: {
      protocol: session.protocol === "wai_first_calibration" ? "passport_meeting" : session.protocol,
      inputMode: session.inputMode,
      passportId: passport.id,
      robotModelId,
      eventsJson: minimiseEvents(session.events) as Prisma.InputJsonValue,
      summaryJson: minimiseSummary(session.summary) as Prisma.InputJsonValue,
      endedAt: new Date()
    }
  });
  revalidatePath("/living-lab");
  return { ok: true as const };
}
