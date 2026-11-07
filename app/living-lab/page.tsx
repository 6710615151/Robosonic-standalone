import type { Metadata } from "next";
import { cookies } from "next/headers";
import { prisma } from "@/lib/prisma";
import LivingLabClient, { type LabStats, type LabRobot } from "./LivingLabClient";
import { readClientIdentity } from "./identity-actions";
import { identityRequired } from "@/lib/hri/identity-server";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "HRI Wellness Living Lab | Thailand Humanoid Atlas",
  description: "Meet the atlas robot, teach it your comfort boundaries with a wai and a few taps, and carry them to every robot as an HRI Passport.",
  alternates: { canonical: "/living-lab" }
};

// Robots whose registry type is about care, health or companionship: candidates for a passport meeting.
const CARE_TYPES = /hospital|medical|elder|care|rehab|therapy|telepresence|companion|assist|service/i;

export default async function LivingLabPage() {
  const cookieStore = await cookies();
  const lang = (cookieStore.get("lang")?.value || "en") as "en" | "th";

  let stats: LabStats | null = null;
  let robots: LabRobot[] = [];
  try {
    const [passports, sessionCount, meetings, robotRows, sessions, stations] = await Promise.all([
      prisma.hriPassport.findMany({ select: { comfortDistance: true, gaze: true, voice: true, speed: true } }),
      prisma.hriSession.count(),
      prisma.hriSession.count({ where: { protocol: "passport_meeting" } }),
      prisma.robotModel.findMany({ select: { id: true, canonicalName: true, robotType: true, developerOrg: true, manufacturer: true }, orderBy: { canonicalName: "asc" } }),
      prisma.hriSession.findMany({ where: { protocol: "wai_first_calibration" }, select: { summaryJson: true, inputMode: true }, orderBy: { startedAt: "desc" }, take: 500 }),
      prisma.hriSession.findMany({ where: { protocol: "care_journey_station" }, select: { summaryJson: true }, orderBy: { startedAt: "desc" }, take: 2000 })
    ]);
    // Comfort ratings (1-5) given after each hospital-journey station, split by whether the robot used the passport.
    const rated = stations
      .map((s) => s.summaryJson as Record<string, unknown>)
      .filter((s) => typeof s?.comfort === "number" && s.comfort >= 1 && s.comfort <= 5);
    const comfortOf = (mode: string) => rated.filter((s) => s.mode === mode).map((s) => s.comfort as number);
    const n = passports.length;
    const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
    stats = {
      comfortWithPassport: avg(comfortOf("passport")),
      comfortWithout: avg(comfortOf("default")),
      ratings: rated.length,
      passports: n,
      sessions: sessionCount,
      meetings: meetings + stations.length,
      avgDistance: avg(passports.map((p) => p.comfortDistance)),
      softGazeShare: n ? passports.filter((p) => p.gaze === "soft").length / n : null,
      voiceShare: n ? passports.filter((p) => p.voice).length / n : null,
      slowedShare: n ? passports.filter((p) => p.speed < 1).length / n : null,
      tooCloseTotal: sessions.reduce((a, s) => a + num((s.summaryJson as Record<string, unknown>)?.tooClose), 0),
      cameraShare: sessions.length ? sessions.filter((s) => s.inputMode === "camera").length / sessions.length : null,
      distances: passports.map((p) => p.comfortDistance)
    };
    robots = robotRows
      .filter((r) => CARE_TYPES.test(r.robotType))
      .map((r) => ({ id: r.id, name: r.canonicalName, type: r.robotType, org: r.developerOrg ?? r.manufacturer ?? null }));
  } catch (error) {
    console.error("Living Lab: database unavailable", error);
  }

  const identity = await readClientIdentity();
  return <LivingLabClient lang={lang} stats={stats} robots={robots} initialIdentity={identity} identityRequired={identityRequired()} />;
}
