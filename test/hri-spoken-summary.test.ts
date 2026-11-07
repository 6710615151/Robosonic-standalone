import assert from "node:assert/strict";
import { test } from "node:test";
import { adapt } from "../lib/hri/adapt";
import { toPublicProfile, type PassportProfileSource } from "../lib/hri/public-profile";
import { ROBOT_PROFILES } from "../lib/hri/robot-profiles";
import { buildDefaultSpeech, buildSpokenSummary } from "../lib/hri/spoken-summary";

const [robotA, robotB] = ROBOT_PROFILES;

// The real path: stored passport → public profile → this robot's plan.
function passport(overrides: Partial<PassportProfileSource> = {}): PassportProfileSource {
  return {
    comfortDistance: -1.3, speed: 1, gaze: "soft", language: "th", speechPace: "slow", greeting: "wai",
    voice: true, captions: "large", noReach: true, anxiety: "high", status: "active", version: 1,
    updatedAt: new Date("2026-11-07T00:00:00Z"), expiresAt: null,
    ...overrides
  };
}
const planFor = (robot: (typeof ROBOT_PROFILES)[number], overrides: Partial<PassportProfileSource> = {}) =>
  adapt(toPublicProfile(passport(overrides)), robot);

test("spoken summary: a full robot says every part of the passport, in Thai", () => {
  assert.equal(
    buildSpokenSummary(planFor(robotA)),
    "สวัสดีครับ ผมจะยืนห่าง ๆ จะเคลื่อนที่ช้า ๆ พูดช้าลง จะไม่จ้องตาคุณ ถ้ามีของให้ ผมจะวางไว้ใกล้ ๆ และจะบอกคุณก่อนทุกครั้งที่จะขยับ ตามที่คุณต้องการครับ"
  );
});

test("spoken summary: and in English, following the passport's language", () => {
  assert.equal(
    buildSpokenSummary(planFor(robotA, { language: "en" })),
    "Hello. I'll keep a wide distance, move slowly, speak more slowly, not stare at you, place items near you, and tell you before every move, as you prefer."
  );
});

test("spoken summary: values that need no special care are left out to keep it short", () => {
  const plain = { comfortDistance: 0, speed: 1, gaze: "direct", speechPace: "normal", noReach: false, anxiety: "low" };
  assert.equal(buildSpokenSummary(planFor(robotA, plain)), "สวัสดีครับ ผมจะยืนระยะกลาง ตามที่คุณต้องการครับ");
  assert.equal(buildSpokenSummary(planFor(robotA, { ...plain, language: "en" })), "Hello. I'll keep a medium distance, as you prefer.");
  assert.equal(buildSpokenSummary(planFor(robotA, { ...plain, comfortDistance: 1.3 })), "สวัสดีครับ ผมจะเข้าใกล้ได้ตามที่คุณสบายใจ ตามที่คุณต้องการครับ");
});

test("spoken summary: a fixed robot with no head only promises what it can do", () => {
  for (const language of ["th", "en"]) {
    const text = buildSpokenSummary(planFor(robotB, { language }));
    if (language === "th") {
      assert.equal(
        text,
        "สวัสดีครับ ผมเป็นหุ่นแบบติดที่ จะไม่เดินเข้าไปหาคุณ ผมไม่มีศีรษะ จะแสดงข้อมูลบนจอแทน พูดช้าลง และถ้ามีของให้ ผมจะวางไว้ใกล้ ๆ ตามที่คุณต้องการ เท่าที่ผมทำได้ครับ"
      );
      for (const promise of ["ยืนห่าง", "ระยะกลาง", "เคลื่อนที่ช้า", "จ้องตา", "ก่อนทุกครั้งที่จะขยับ"]) {
        assert.equal(text.includes(promise), false, promise);
      }
    } else {
      assert.equal(
        text,
        "Hello. I stay in one place and won't move toward you. I have no head, so I'll use my screen instead. I'll speak more slowly, and place items near you, as you prefer, as far as I can."
      );
      for (const promise of ["wide distance", "medium distance", "move slowly", "stare", "before every move"]) {
        assert.equal(text.includes(promise), false, promise);
      }
    }
  }
});

test("spoken summary: never says 'as you prefer' alone when the hardware changed what the person asked", () => {
  // The person asked to be handed things; a robot with no arms has to place them nearby instead.
  const text = buildSpokenSummary(planFor(robotB, { noReach: false }));
  assert.ok(text.includes("วางไว้ใกล้ ๆ"));
  assert.ok(text.endsWith("เท่าที่ผมทำได้ครับ"));
});

test("spoken summary: never mentions feelings or health, at any anxiety level or language", () => {
  const forbidden = /กังวล|กลัว|ความเครียด|สุขภาพ|anxi|nervous|scared|afraid|worried|health/i;
  for (const robot of ROBOT_PROFILES) {
    for (const anxiety of ["low", "medium", "high"]) {
      for (const language of ["th", "en"]) {
        const text = buildSpokenSummary(planFor(robot, { anxiety, language }));
        assert.equal(forbidden.test(text), false, text);
      }
    }
  }
});

test("spoken summary: a name is used only when given", () => {
  assert.ok(buildSpokenSummary(planFor(robotA)).startsWith("สวัสดีครับ ผม"));
  assert.ok(buildSpokenSummary(planFor(robotA), { callName: null }).startsWith("สวัสดีครับ ผม"));
  assert.ok(buildSpokenSummary(planFor(robotA), { callName: "   " }).startsWith("สวัสดีครับ ผม"));
  assert.ok(buildSpokenSummary(planFor(robotA), { callName: "แฟน" }).startsWith("สวัสดีครับคุณแฟน ผม"));
  assert.ok(buildSpokenSummary(planFor(robotA, { language: "en" }), { callName: "Fan" }).startsWith("Hello, Fan. I'll"));
});

test("spoken summary: a robot with no passport says only hello", () => {
  assert.equal(buildDefaultSpeech("th"), "สวัสดีครับ!");
  assert.equal(buildDefaultSpeech("en"), "Hello!");
});
