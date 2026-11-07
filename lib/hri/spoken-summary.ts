// What a robot says to the person after reading their passport: how it will look after them.
// Pure and client-safe. Unit-tested in test/hri-spoken-summary.test.ts.
//
// Built only from the BehaviourPlan, so each robot describes what its own hardware will really do.
// People nearby can hear this, so it speaks to the person and never mentions feelings or health:
// a calm demeanour is described only by what the robot will do.
import type { BehaviourPlan } from "./adapt";

type Language = BehaviourPlan["language"];

const PHRASES = {
  th: {
    hello: (name?: string) => (name ? `สวัสดีครับคุณ${name}` : "สวัสดีครับ"),
    fixed: "ผมเป็นหุ่นแบบติดที่ จะไม่เดินเข้าไปหาคุณ",
    screen: "ผมไม่มีศีรษะ จะแสดงข้อมูลบนจอแทน",
    distance: { far: "ผมจะยืนห่าง ๆ", medium: "ผมจะยืนระยะกลาง", close: "ผมจะเข้าใกล้ได้ตามที่คุณสบายใจ" },
    slowMove: "จะเคลื่อนที่ช้า ๆ",
    slowSpeech: "พูดช้าลง",
    softGaze: "จะไม่จ้องตาคุณ",
    placeNearby: "ถ้ามีของให้ ผมจะวางไว้ใกล้ ๆ",
    announce: "จะบอกคุณก่อนทุกครั้งที่จะขยับ",
    close: "ตามที่คุณต้องการครับ",
    closeLimited: "ตามที่คุณต้องการ เท่าที่ผมทำได้ครับ"
  },
  en: {
    hello: (name?: string) => (name ? `Hello, ${name}.` : "Hello."),
    fixed: "I stay in one place and won't move toward you.",
    screen: "I have no head, so I'll use my screen instead.",
    distance: { far: "keep a wide distance", medium: "keep a medium distance", close: "come close, as you like" },
    slowMove: "move slowly",
    slowSpeech: "speak more slowly",
    softGaze: "not stare at you",
    placeNearby: "place items near you",
    announce: "tell you before every move",
    close: "as you prefer.",
    closeLimited: "as you prefer, as far as I can."
  }
} as const;

function joinThai(clauses: string[]) {
  if (clauses.length < 2) return clauses.join("");
  return `${clauses.slice(0, -1).join(" ")} และ${clauses[clauses.length - 1]}`;
}

function joinEnglish(clauses: string[]) {
  if (clauses.length === 0) return "";
  if (clauses.length === 1) return `I'll ${clauses[0]},`;
  return `I'll ${clauses.slice(0, -1).join(", ")}, and ${clauses[clauses.length - 1]},`;
}

export function buildSpokenSummary(plan: BehaviourPlan, opts: { callName?: string | null } = {}): string {
  const say = PHRASES[plan.language];
  const clauses: string[] = [];
  if (!plan.distance.fixed) clauses.push(say.distance[plan.distance.band]);
  if (plan.movement.mobile && plan.movement.band === "slow") clauses.push(say.slowMove);
  if (plan.speechRate < 1) clauses.push(say.slowSpeech);
  if (plan.eyeContact === "soft") clauses.push(say.softGaze);
  if (plan.handover === "place_nearby") clauses.push(say.placeNearby);
  // A robot that cannot move has no move to announce.
  if (plan.demeanor === "calm" && plan.movement.mobile) clauses.push(say.announce);

  // When the hardware changed something, "as you prefer" alone would not be true.
  const closing = plan.adaptations.length > 0 ? say.closeLimited : say.close;
  return [
    say.hello(opts.callName?.trim() || undefined),
    plan.distance.fixed ? say.fixed : "",
    plan.eyeMechanism === "screen_cue" ? say.screen : "",
    plan.language === "th" ? joinThai(clauses) : joinEnglish(clauses),
    closing
  ]
    .filter(Boolean)
    .join(" ");
}

// What a robot with no passport says: nothing about the person, because it knows nothing about them.
export function buildDefaultSpeech(language: Language): string {
  return language === "th" ? "สวัสดีครับ!" : "Hello!";
}
