"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import QRCode from "qrcode";
import { BadgeCheck, Camera, CameraOff, Hand, HeartHandshake, Mic, Pause, Play, ScanFace, Snail, Volume2, VolumeX } from "lucide-react";
import RobotStage from "@/app/components/robot/RobotStage";
import type { RobotBehavior, RobotEvent } from "@/lib/hri/behavior-engine";
import { classifyWai, LeanBackDetector, POSE, shoulderWidth, WaiDetector } from "@/lib/hri/signals";
import { describeDistance, type PassportInput } from "@/lib/hri/passport";
import { AutoCalibrator, type AutoEvent, type AutoEvidence, type AutoResult, type AutoStage, type PauseReason } from "@/lib/hri/auto-calibration";
import type { PoseFrame } from "@/lib/hri/camera";
import { CameraSession } from "@/lib/hri/camera-session";
import { createPassportAction } from "./actions";
import IdentityCard from "./IdentityCard";
import { identityCopy } from "./identity-copy";
import type { ClientIdentity } from "./identity-actions";
import PassportCardVisual from "./PassportCardVisual";
import VoiceAnswerBox from "./VoiceAnswer";
import { copy, type Lang } from "./copy";

export type LabStats = {
  comfortWithPassport: number | null;
  comfortWithout: number | null;
  ratings: number;
  passports: number;
  sessions: number;
  meetings: number;
  avgDistance: number | null;
  softGazeShare: number | null;
  voiceShare: number | null;
  slowedShare: number | null;
  tooCloseTotal: number;
  cameraShare: number | null;
  distances: number[];
};
export type LabRobot = { id: string; name: string; type: string; org: string | null };

type Phase = "intro" | "greet" | "approach" | "care" | "gaze" | "voice" | "confirm" | "auto" | "review" | "saving" | "done";
type InputMode = "buttons" | "camera" | "voice" | "auto";
type SessionSummary = Record<string, string | number | boolean | null>;
const REVIEW_SECONDS = 10;
type LogEvent = { t: number; src: "robot" | "human"; type: string; [key: string]: unknown };

// Distances the robot steps through while approaching (higher = closer to the person).
const STEPS = [-2.2, -1.3, -0.4, 0.5, 1.3];
// What each choice on the review screen sets the distance to, when the person changes the band.
const DISTANCE_CHOICES = { close: 1.3, medium: -0.4, far: -1.3 } as const;
const REVIEW_SLOWER_SPEED = 0.5;
// The care questions are asked one at a time when answering by voice or text.
const CARE_QUESTIONS = ["anxiety", "communication", "reach"] as const;

export default function LivingLabClient({ lang, stats, robots, initialIdentity, identityRequired = true }: {
  lang: Lang; stats: LabStats | null; robots: LabRobot[]; initialIdentity: ClientIdentity;
  // False only when HRI_IDENTITY_REQUIRED=false (event-day fallback): verifying is then optional.
  identityRequired?: boolean;
}) {
  const t = copy[lang];
  const idT = identityCopy[lang];
  // Verified Living Lab participant (masked email). Required before the robot starts (decision 1).
  const [identity, setIdentity] = useState<ClientIdentity>(initialIdentity);
  const identityOk = Boolean(identity) || !identityRequired;
  const robotRef = useRef<RobotBehavior | null>(null);
  const [ready, setReady] = useState(false);
  const [phase, setPhase] = useState<Phase>("intro");
  const [speech, setSpeech] = useState<string>(t.introSpeech);
  const [status, setStatus] = useState<string>(t.statusIdle);
  const [inputMode, setInputMode] = useState<InputMode>("buttons");
  const [cameraState, setCameraState] = useState<"off" | "loading" | "on" | "error">("off");
  const [cameraInfo, setCameraInfo] = useState("");
  const [step, setStep] = useState(0);
  const [speed, setSpeed] = useState(1);
  const [comfort, setComfort] = useState<number | null>(null);
  const [gaze, setGaze] = useState<"direct" | "soft">("direct");
  const [voice, setVoice] = useState(false);
  const [anxiety, setAnxiety] = useState<"low" | "medium" | "high">("low");
  const [accessible, setAccessible] = useState(false);
  const [noReach, setNoReach] = useState(false);
  const [greeting, setGreeting] = useState<"wai" | "wave" | "none">("wai");
  const [careQuestion, setCareQuestion] = useState(0);
  const [log, setLog] = useState<LogEvent[]>([]);
  const [consent, setConsent] = useState(false);
  const [passportCode, setPassportCode] = useState<string | null>(null);
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [editToken, setEditToken] = useState<string | null>(null);
  const [keyCopied, setKeyCopied] = useState(false);
  const [qr, setQr] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Auto mode
  const [autoStage, setAutoStage] = useState<AutoStage>("baseline");
  const [autoPaused, setAutoPaused] = useState<PauseReason | null>(null);
  const [autoPerson, setAutoPerson] = useState(false);
  const [autoWai, setAutoWai] = useState<boolean | null>(null);
  const [autoLeans, setAutoLeans] = useState(0);
  const [autoResult, setAutoResult] = useState<{ result: AutoResult; evidence: AutoEvidence } | null>(null);
  const [autoNotice, setAutoNotice] = useState<string | null>(null);
  const [countdown, setCountdown] = useState<number | null>(null);
  const autoRef = useRef<AutoCalibrator | null>(null);

  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const stepRef = useRef(step);
  stepRef.current = step;
  const counters = useRef({ tooClose: 0, tooFast: 0, leanBack: 0 });
  const timers = useRef<number[]>([]);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const camera = useRef(new CameraSession());
  const logRef = useRef<HTMLDivElement | null>(null);
  const voiceRef = useRef(voice);
  voiceRef.current = voice;

  const later = (ms: number, fn: () => void) => timers.current.push(window.setTimeout(fn, ms));
  const clearTimers = () => { timers.current.forEach((id) => window.clearTimeout(id)); timers.current = []; };
  useEffect(() => () => { clearTimers(); camera.current.stop(); window.speechSynthesis?.cancel(); }, []);
  useEffect(() => { logRef.current?.scrollTo({ top: logRef.current.scrollHeight }); }, [log]);

  const record = useCallback((e: LogEvent) => setLog((prev) => [...prev.slice(-299), e]), []);
  const human = (type: string, detail: Record<string, unknown> = {}) =>
    record({ t: +(robotRef.current?.time ?? 0).toFixed(3), src: "human", type, ...detail });
  const onRobotEvent = useCallback((e: RobotEvent) => record({ ...e, src: "robot" }), [record]);

  const say = (text: string) => {
    setSpeech(text);
    if (voiceRef.current && "speechSynthesis" in window) {
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = lang === "th" ? "th-TH" : "en-US";
      u.rate = speed < 1 ? 0.85 : 1;
      window.speechSynthesis.speak(u);
    }
  };

  const onReady = useCallback((robot: RobotBehavior) => {
    robotRef.current = robot;
    robot.bothArms("relaxed");
    robot.setDistance(STEPS[0]);
    robot.lookAt(0, 0.35);
    robot.expression("neutral");
    robot.setGlow(0.45, "teal");
    robot.snap();
    setReady(true);
  }, []);

  // ---------------- phases ----------------
  function begin(answerByVoice = false) {
    const robot = robotRef.current;
    if (!robot || !consent || !identityOk) return;
    clearTimers();
    counters.current = { tooClose: 0, tooFast: 0, leanBack: 0 };
    setLog([]); setStep(0); setSpeed(1); setComfort(null); setGreeting("wai"); setCareQuestion(0);
    setPassportCode(null); setAccessToken(null); setEditToken(null); setKeyCopied(false); setQr(null); setError(null);
    robot.setSpeed(1); robot.setDistance(STEPS[0]); robot.bothArms("relaxed"); robot.expression("neutral"); robot.lookAt(0, 0.35); robot.setGlow(0.45, "teal");
    // A voice conversation needs the robot to talk from the start; the person decides later whether it keeps talking.
    if (answerByVoice) { voiceRef.current = true; setVoice(true); }
    // After an Auto session the mode must fall back to what is actually on: camera or buttons.
    const mode: InputMode = answerByVoice ? "voice" : cameraState === "on" ? "camera" : "buttons";
    setInputMode(mode);
    setAutoNotice(null);
    human("session_start", { inputMode: mode });
    setPhase("greet");
    // The robot waits quietly with lowered eyes: it does not wave at or stare at the visitor.
    say(answerByVoice ? t.voiceInput.prompts.greet : t.waitSpeech);
    setStatus(mode === "camera" ? t.statusWaitCamera : t.statusWaitButton);
  }

  function receiveWai(source: "button" | "camera") {
    const robot = robotRef.current;
    if (!robot || phaseRef.current !== "greet") return;
    human("wai", { source });
    setPhase("approach");
    robot.lookAt(0, 0.2);
    robot.bothArms("wai");
    robot.expression("calm");
    say(t.waiSpeech);
    setStatus(t.statusWaiReturned);
    later(500, () => robot.bow(0.36, 1.7));
    later(2800, () => {
      robot.bothArms("relaxed");
      robot.expression("happy");
      robot.lookAt(0, 0);
      robot.setGlow(0.7, "teal");
      say(t.askApproach);
      setStatus(t.statusApproach(1, STEPS.length - 1));
    });
  }

  function approachNext() {
    const robot = robotRef.current;
    if (!robot || phaseRef.current !== "approach") return;
    const next = stepRef.current + 1;
    if (next >= STEPS.length) return finishDistance(STEPS[STEPS.length - 1], "closest_step");
    human("continue", { step: next });
    say(t.announceStep);
    later(1100 / robot.state.speed, () => {
      if (phaseRef.current !== "approach") return;
      robot.setDistance(STEPS[next]);
      robot.moveArm("R", next >= STEPS.length - 1 ? "offer" : "relaxed");
      setStep(next);
      setStatus(t.statusApproach(next, STEPS.length - 1));
      later(1500, () => { if (phaseRef.current === "approach") say(next >= STEPS.length - 1 ? t.closestAsk : t.askApproach); });
    });
  }

  function tooClose(source: "button" | "camera") {
    const robot = robotRef.current;
    if (!robot || phaseRef.current !== "approach") return;
    clearTimers();
    counters.current.tooClose++;
    if (source === "camera") counters.current.leanBack++;
    human("too_close", { source, distance: +robot.state.distance.toFixed(2) });
    const back = Math.max(-2.4, robot.state.distanceTarget - 0.8);
    robot.setDistance(back);
    robot.moveArm("R", "handOnChest");
    robot.moveArm("L", "relaxed");
    robot.expression("sorry");
    robot.lean("back");
    say(source === "camera" ? t.sorryLean : t.sorry);
    later(1700, () => { robot.lean("upright"); robot.moveArm("R", "relaxed"); });
    later(2600, () => finishDistance(back, "too_close"));
  }

  function tooFast() {
    const robot = robotRef.current;
    if (!robot || phaseRef.current !== "approach") return;
    counters.current.tooFast++;
    const s = Math.max(0.35, robot.state.speed * 0.5);
    robot.setSpeed(s);
    setSpeed(s);
    robot.nod(1);
    robot.expression("neutral");
    human("too_fast", { speed: s });
    say(t.slower);
  }

  function comfortable() {
    const robot = robotRef.current;
    if (!robot || phaseRef.current !== "approach") return;
    human("comfortable", { distance: +robot.state.distance.toFixed(2) });
    finishDistance(robot.state.distanceTarget, "comfortable");
  }

  function finishDistance(distance: number, reason: string) {
    const robot = robotRef.current;
    if (!robot) return;
    setComfort(distance);
    robot.moveArm("R", "relaxed");
    robot.nod(2);
    robot.expression("happy");
    robot.setGlow(0.9, "teal");
    human("distance_set", { distance: +distance.toFixed(2), reason });
    setPhase("care");
    later(900, () => {
      robot.lookAt(0, 0);
      say(t.askCare);
      setStatus(t.statusCare);
    });
  }

  // Care needs: shown to the robot immediately so the person sees the effect of each answer.
  function chooseAnxiety(level: "low" | "medium" | "high") {
    const robot = robotRef.current;
    setAnxiety(level);
    human("anxiety", { level });
    if (!robot) return;
    if (level === "high") { robot.setSpeed(Math.min(robot.state.speed, 0.5)); robot.setGlow(0.35, "blue"); robot.expression("calm"); say(t.anxietyHigh); }
    else if (level === "medium") { robot.setSpeed(Math.min(robot.state.speed, 0.75)); robot.setGlow(0.5, "blue"); robot.expression("neutral"); say(t.anxietyMedium); }
    else { robot.setGlow(0.8, "teal"); robot.expression("happy"); say(t.anxietyLow); }
    setSpeed(robot.state.speed);
  }
  function chooseAccessible(on: boolean) {
    setAccessible(on);
    human("communication", { accessible: on });
    say(on ? t.accessibleOn : t.accessibleOff);
  }
  function chooseReach(avoid: boolean) {
    const robot = robotRef.current;
    setNoReach(avoid);
    human("reach", { noReach: avoid });
    if (!robot) return;
    if (avoid) { robot.moveArm("R", "relaxed"); say(t.reachNo); }
    else { robot.moveArm("R", "offer"); later(1500, () => robot.moveArm("R", "relaxed")); say(t.reachYes); }
  }
  function careDone() {
    human("care_needs_set", { anxiety, accessible, noReach });
    setPhase("gaze");
    say(t.askGaze);
    setStatus(t.statusGaze);
  }
  // A delayed call must log the answers as they are by then, not as they were when it was scheduled.
  const careDoneRef = useRef(careDone);
  careDoneRef.current = careDone;

  function applyGaze(choice: "direct" | "soft") {
    const robot = robotRef.current;
    if (!robot) return;
    setGaze(choice);
    human("gaze_preference", { gaze: choice });
    if (choice === "soft") { robot.lookAt(0.25, 0.35); say(t.gazeSoft); } else { robot.lookAt(0, 0); robot.nod(1); say(t.gazeDirect); }
  }

  function chooseGaze(choice: "direct" | "soft") {
    if (!robotRef.current) return;
    applyGaze(choice);
    setPhase("voice");
    later(1800, () => { say(t.askVoice); setStatus(t.statusVoice); });
  }

  function chooseVoice(on: boolean) {
    const robot = robotRef.current;
    if (!robot) return;
    setVoice(on);
    voiceRef.current = on;
    human("voice_preference", { voice: on });
    say(on ? t.voiceOn : t.voiceOff);
    robot.bothArms("wai");
    later(1600, () => robot.bothArms("relaxed"));
    setPhase("confirm");
    setStatus(t.statusConfirm);
    later(2200, () => { if (phaseRef.current === "confirm") say(t.confirmSpeech); });
  }

  // ---------------- answering by voice or text ----------------
  function answerApproach(answer: "continue" | "comfortable" | "too_close" | "too_fast") {
    if (answer === "continue") approachNext();
    else if (answer === "comfortable") comfortable();
    else if (answer === "too_close") tooClose("button");
    else tooFast();
  }

  // After the robot has responded to an answer, it asks the next care question, then moves on.
  function afterCareAnswer() {
    const next = careQuestion + 1;
    if (next >= CARE_QUESTIONS.length) {
      later(1800, () => { if (phaseRef.current === "care") careDoneRef.current(); });
      return;
    }
    setCareQuestion(next);
    later(1800, () => { if (phaseRef.current === "care") say(t.voiceInput.prompts[CARE_QUESTIONS[next]]); });
  }

  // ---------------- review before saving ----------------
  function reviewDistance(choice: keyof typeof DISTANCE_CHOICES) {
    const distance = DISTANCE_CHOICES[choice];
    setComfort(distance);
    robotRef.current?.setDistance(distance);
    human("distance_set", { distance, reason: "review" });
  }

  function reviewSpeed(next: number) {
    setSpeed(next);
    robotRef.current?.setSpeed(next);
    human("speed_set", { speed: next });
  }

  async function saveReviewed() {
    const robot = robotRef.current;
    if (!robot || phaseRef.current !== "confirm") return;
    const distance = comfort ?? robot.state.distanceTarget;
    await savePassport(
      {
        greeting, comfortDistance: distance, speed, gaze, voice, language: lang,
        anxiety, captions: accessible ? "large" : "normal", speechPace: accessible ? "slow" : "normal", noReach
      },
      {
        tooClose: counters.current.tooClose,
        tooFast: counters.current.tooFast,
        leanBack: counters.current.leanBack,
        finalDistance: +distance.toFixed(2),
        finalSpeed: +speed.toFixed(2),
        durationSeconds: +robot.time.toFixed(1)
      },
      inputMode
    );
  }

  // Shared by the button/camera flow and Auto mode: create the passport, keep the edit key, show the QR.
  async function savePassport(passport: PassportInput, summary: SessionSummary, mode: InputMode) {
    setPhase("saving");
    setStatus(t.statusSaving);
    try {
      const result = await createPassportAction(
        passport,
        { protocol: "wai_first_calibration", inputMode: mode, events: log.slice(-250), summary },
        consent
      );
      if (!result.ok) {
        if (result.error === "identity_required") {
          // The session ended (or was signed out elsewhere) during calibration: ask to verify again.
          setIdentity(null);
          setError(idT.errors.identity_required);
        } else {
          setError(result.error === "rate_limited" ? t.saveRateLimited(Math.ceil(result.retryAfterSeconds / 60)) : t.saveFailed);
        }
        setPhase(mode === "auto" ? "review" : "confirm");
        return;
      }
      const { code, accessToken, editToken } = result;
      // The edit token is the owner's key to the card page. Keep it in this browser so the card
      // unlocks here without asking again; the key is also shown once below for other devices.
      try { window.localStorage.setItem(`hri-passport-edit:${accessToken}`, editToken); } catch { /* private mode */ }
      const url = `${window.location.origin}/living-lab/passport/${accessToken}`;
      setPassportCode(code);
      setAccessToken(accessToken);
      setEditToken(editToken);
      setQr(await QRCode.toDataURL(url, { margin: 1, width: 220, color: { dark: "#07150f", light: "#ffffff" } }));
      setPhase("done");
      setStatus(t.statusDone);
      say(t.doneSpeech(code));
      human("passport_created", { code });
    } catch {
      setError(t.saveFailed);
      setPhase(mode === "auto" ? "review" : "confirm");
    }
  }

  // Consent is what lets calibration (and the optional camera) start. Revoking it before Start
  // also turns the camera off: nothing is sensed without consent.
  function changeConsent(on: boolean) {
    setConsent(on);
    if (!on && (cameraState === "on" || cameraState === "loading")) {
      stopCam(); setInputMode("buttons"); human("camera_off");
    }
  }

  // "Again" may hand the screen to the next visitor, so nothing of this visitor's carries over:
  // they must give their own consent and answer the care questions for themselves.
  function startOver() {
    setCountdown(null);
    changeConsent(false);
    setAnxiety("low"); setAccessible(false); setNoReach(false); setGreeting("wai");
    setPhase("intro");
    setStatus(t.statusIdle);
    setSpeech(t.introSpeech);
  }

  async function copyEditKey() {
    if (!editToken) return;
    try {
      await navigator.clipboard.writeText(editToken);
      setKeyCopied(true);
      window.setTimeout(() => setKeyCopied(false), 2000);
    } catch {
      setKeyCopied(false);
    }
  }

  // ---------------- camera (optional) ----------------
  function stopCam() {
    camera.current.stop();
    setCameraState("off");
  }

  async function toggleCamera() {
    if (!consent) return;
    if (cameraState === "on" || cameraState === "loading") {
      stopCam(); setInputMode("buttons"); human("camera_off");
      return;
    }
    if ((await startCamera()) === "started") {
      setInputMode("camera");
      human("camera_on");
    }
  }

  // One camera pipeline for both modes: frames go to the Auto calibrator while it runs, otherwise to
  // the optional wai / lean-back helpers of the button flow.
  // "cancelled" means stopCam() ran while the camera was loading: whoever stopped it has already reset the UI.
  async function startCamera(): Promise<"started" | "cancelled" | "failed"> {
    const video = videoRef.current;
    if (!video) return "failed";
    setCameraState("loading");
    try {
      const wai = new WaiDetector();
      const lean = new LeanBackDetector();
      const onFrame = (frame: PoseFrame) => {
        const { tMs, landmarks, fps, people } = frame;
        setCameraInfo(`${fps.toFixed(0)} fps · ${landmarks ? t.personSeen : t.noPerson}`);
        const robot = robotRef.current;
        const nose = landmarks?.[POSE.nose];
        // The robot looks toward the visitor (image is not mirrored: image-right is the visitor's left).
        const lookAtVisitor = () => { if (robot && nose) robot.lookAt(-(nose.x - 0.5) * 2, (nose.y - 0.45) * 1.4); };

        const auto = autoRef.current;
        if (auto) {
          // While waiting for the wai the robot keeps its eyes lowered; afterwards it follows the person.
          if (auto.stage !== "baseline" && auto.stage !== "greet" && auto.stage !== "returning_wai") lookAtVisitor();
          setAutoPerson(!!landmarks && people === 1);
          for (const event of auto.update({ tMs, landmarks, people, luma: frame.luma })) applyAutoEvent(event);
          return;
        }

        if (!landmarks) return;
        if (phaseRef.current === "approach" || phaseRef.current === "done") lookAtVisitor();
        if (phaseRef.current === "greet") {
          const s = wai.update(tMs, classifyWai(landmarks));
          if (s.state === "rising") setStatus(`${t.waiDetecting} ${Math.round(s.progress * 100)}%`);
          if (s.state === "fired") receiveWai("camera");
        }
        if (phaseRef.current === "approach" && lean.update(tMs, shoulderWidth(landmarks))) tooClose("camera");
      };
      const live = await camera.current.start(async (isCancelled) => {
        const { startPoseCamera } = await import("@/lib/hri/camera");
        return startPoseCamera(video, onFrame, isCancelled);
      });
      if (!live) return "cancelled";
      setCameraState("on");
      return "started";
    } catch (e) {
      setCameraState("error");
      setCameraInfo(e instanceof Error ? e.message : String(e));
      return "failed";
    }
  }

  // ---------------- Auto mode: one tap, then the camera does the rest ----------------
  async function startAuto() {
    const robot = robotRef.current;
    if (!robot || !consent || !identityOk) return;
    clearTimers();
    counters.current = { tooClose: 0, tooFast: 0, leanBack: 0 };
    setLog([]); setStep(0); setSpeed(1); setComfort(null);
    setPassportCode(null); setAccessToken(null); setEditToken(null); setKeyCopied(false); setQr(null); setError(null);
    setAutoNotice(null); setAutoResult(null); setCountdown(null); setAutoLeans(0); setAutoWai(null); setAutoPaused(null);
    setAutoStage("baseline"); setAutoPerson(false);
    // Safe defaults for what the camera does not measure. Anxiety is never guessed.
    setGaze("direct"); setAnxiety("low"); setAccessible(false); setNoReach(true); setGreeting("wai");
    // Auto mode talks (and shows the text), so the person can follow without reading the screen.
    voiceRef.current = true; setVoice(true);
    robot.setSpeed(1); robot.setDistance(STEPS[0]); robot.bothArms("relaxed"); robot.expression("neutral"); robot.lookAt(0, 0.35); robot.setGlow(0.45, "teal");
    setInputMode("auto");
    autoRef.current = new AutoCalibrator(lang);
    setPhase("auto");
    human("session_start", { inputMode: "auto" });
    if (cameraState !== "on" && (await startCamera()) === "failed") {
      autoRef.current = null;
      setPhase("intro");
      setAutoNotice(t.cameraError);
    }
  }

  function stopAuto() {
    autoRef.current = null;
    stopCam();
    clearTimers();
    window.speechSynthesis?.cancel();
    const robot = robotRef.current;
    if (robot) { robot.setSpeed(1); robot.setDistance(STEPS[0]); robot.bothArms("relaxed"); robot.expression("neutral"); robot.lookAt(0, 0.35); }
    human("auto_stopped");
    setInputMode("buttons");
    setPhase("intro");
    setStatus(t.statusIdle);
    setSpeech(t.introSpeech);
  }

  function applyAutoEvent(e: AutoEvent) {
    const robot = robotRef.current;
    if (!robot) return;
    switch (e.type) {
      case "stage":
        setAutoStage(e.stage);
        if (e.stage !== "complete" && e.stage !== "aborted") setStatus(t.autoStages[e.stage]);
        if (e.stage === "baseline") say(t.autoBaselineSpeech);
        if (e.stage === "greet") { robot.lookAt(0, 0.35); say(t.waitSpeech); }
        break;
      case "paused":
        setAutoPaused(e.reason);
        setStatus(t.autoPause[e.reason]);
        say(t.autoPause[e.reason]);
        human("auto_paused", { reason: e.reason });
        break;
      case "resumed":
        setAutoPaused(null);
        say(t.autoResumed);
        human("auto_resumed");
        break;
      case "wai_progress":
        setStatus(`${t.waiDetecting} ${Math.round(e.progress * 100)}%`);
        break;
      case "wai_received":
      case "wai_timeout": {
        const seen = e.type === "wai_received";
        setAutoWai(seen);
        human(seen ? "wai" : "wai_timeout", { source: "auto" });
        robot.lookAt(0, 0.2); robot.bothArms("wai"); robot.expression("calm");
        say(seen ? t.waiSpeech : t.autoNoWai);
        later(500, () => robot.bow(0.36, 1.7));
        later(2600, () => { robot.bothArms("relaxed"); robot.expression("happy"); robot.setGlow(0.7, "teal"); });
        break;
      }
      case "step":
        robot.setSpeed(e.speed);
        robot.setDistance(e.distance);
        setSpeed(e.speed);
        setStep(Math.min(e.index, STEPS.length - 1));
        if (e.index === 1) say(t.autoStep);
        human("auto_step", { index: e.index, distance: e.distance });
        break;
      case "too_fast":
        counters.current.tooFast++; counters.current.leanBack++;
        setAutoLeans((n) => n + 1);
        robot.setSpeed(e.speed); robot.setDistance(e.retreatTo); robot.expression("sorry"); robot.nod(1);
        setSpeed(e.speed);
        say(t.autoTooFast);
        human("too_fast", { source: "auto", speed: e.speed });
        break;
      case "too_close":
        counters.current.tooClose++; counters.current.leanBack++;
        setAutoLeans((n) => n + 1);
        robot.setDistance(e.backTo); robot.moveArm("R", "handOnChest"); robot.expression("sorry"); robot.lean("back");
        say(t.sorryLean);
        later(1700, () => { robot.lean("upright"); robot.moveArm("R", "relaxed"); });
        human("too_close", { source: "auto", distance: e.backTo });
        break;
      case "lean_in":
        robot.expression("happy");
        say(t.autoLeanIn);
        human("lean_in", { source: "auto" });
        break;
      case "distance_set":
        setComfort(e.distance); setSpeed(e.speed);
        robot.setSpeed(e.speed); robot.setDistance(e.distance); robot.nod(1); robot.setGlow(0.9, "teal");
        human("distance_set", { source: "auto", distance: e.distance, reason: e.reason });
        break;
      case "gaze_check":
        robot.lookAt(0, 0);
        say(t.autoGazeCheck);
        break;
      case "complete":
        autoRef.current = null;
        stopCam(); // sensing ends as soon as it is no longer needed
        setGaze(e.result.gaze);
        setAutoResult({ result: e.result, evidence: e.evidence });
        setPhase("review");
        setStatus(t.reviewTitle);
        setCountdown(REVIEW_SECONDS);
        robot.expression("happy"); robot.bothArms("wai");
        later(1600, () => robot.bothArms("relaxed"));
        say(t.reviewTitle);
        human("auto_complete", { ...e.evidence });
        break;
      case "aborted":
        autoRef.current = null;
        stopCam();
        robot.setSpeed(1); robot.setDistance(STEPS[0]); robot.expression("neutral"); robot.lookAt(0, 0.35);
        setAutoNotice(t.autoAborted[e.reason]);
        setInputMode("buttons");
        setPhase("intro");
        setStatus(t.statusIdle);
        say(t.autoAborted[e.reason]);
        human("auto_aborted", { reason: e.reason });
        break;
    }
  }

  async function saveAuto() {
    if (!autoResult || phaseRef.current !== "review") return;
    setCountdown(null);
    const { result, evidence } = autoResult;
    await savePassport(
      result,
      {
        ...evidence,
        tooClose: counters.current.tooClose,
        tooFast: counters.current.tooFast,
        leanBack: counters.current.leanBack,
        finalDistance: result.comfortDistance,
        finalSpeed: result.speed
      },
      "auto"
    );
  }

  // The review screen saves by itself after a visible countdown, so Auto mode needs no second tap.
  useEffect(() => {
    if (phase !== "review" || countdown === null) return;
    if (countdown <= 0) { void saveAuto(); return; }
    const id = window.setTimeout(() => setCountdown((c) => (c === null ? null : c - 1)), 1000);
    return () => window.clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, countdown]);

  const pct = (v: number | null) => (v === null ? "–" : `${Math.round(v * 100)}%`);

  return (
    <main className="ll">
      <style dangerouslySetInnerHTML={{ __html: styles }} />
      <header className="ll-head">
        <div>
          <p className="ll-eyebrow"><HeartHandshake size={14} aria-hidden="true" /> {t.eyebrow}</p>
          <h1>{t.title}</h1>
          <p className="ll-sub">{t.subtitle}</p>
        </div>
        <div className="ll-head-actions">
          <Link className="button" href="/living-lab/robot">{t.robotConsole}</Link>
          <Link className="button" href="/living-lab/meet">{t.haveCode}</Link>
        </div>
      </header>

      <section className="ll-grid">
        <div className="ll-stage-card">
          <div className="ll-bubble" aria-live="polite">{speech}</div>
          <div className="ll-stage">
            <RobotStage framing="fullBody" onReady={onReady} onEvent={onRobotEvent} className="ll-canvas" ariaLabel={t.robotLabel} />
          </div>
          <div className="ll-chip" role="status">{status}</div>
          <div className={`ll-cam ${cameraState === "on" ? "is-on" : ""}`}>
            <video ref={videoRef} playsInline muted aria-label={t.cameraPreview} />
            {cameraState !== "off" && <span>{cameraState === "loading" ? t.cameraLoading : cameraInfo}</span>}
          </div>
        </div>

        <div className="ll-side">
        <div className="ll-panel">
          {phase === "intro" && (
            <div className="ll-step">
              <h2>{t.introTitle}</h2>
              <ol className="ll-list">{t.introSteps.map((s) => <li key={s}>{s}</li>)}</ol>
              <p className="ll-note">{t.privacy}</p>
              <label className="ll-consent">
                <input type="checkbox" checked={consent} onChange={(e) => changeConsent(e.target.checked)} />
                <span>{t.consentLabel}</span>
              </label>
              {!consent && <p className="ll-consent-hint">{t.consentHint}</p>}
              {!identityOk && <p className="ll-consent-hint">{idT.required}</p>}
              {autoNotice && <p className="ll-error" role="alert">{autoNotice}</p>}
              <div className="ll-auto-offer">
                <button className="ll-btn big primary" onClick={() => begin(true)} disabled={!ready || !consent || !identityOk}>
                  <Mic size={20} aria-hidden="true" /> {t.voiceInput.start}
                </button>
                <p className="ll-note">{t.voiceInput.startHint}</p>
              </div>
              <div className="ll-row">
                <button className="ll-btn primary" onClick={() => begin()} disabled={!ready || !consent || !identityOk}><Play size={18} aria-hidden="true" /> {ready ? t.start : t.loadingRobot}</button>
                <button className="ll-btn" onClick={toggleCamera} disabled={!consent || cameraState === "loading"}>
                  {cameraState === "on" ? <CameraOff size={18} aria-hidden="true" /> : <Camera size={18} aria-hidden="true" />} {cameraState === "on" ? t.cameraOff : t.cameraOn}
                </button>
              </div>
              <div className="ll-auto-offer">
                <button className="ll-btn big auto" onClick={startAuto} disabled={!ready || !consent || !identityOk || cameraState === "loading"}>
                  <ScanFace size={20} aria-hidden="true" /> {t.autoStart}
                </button>
                <p className="ll-note">{t.autoHint}</p>
              </div>
              {cameraState === "error" && <p className="ll-error">{t.cameraError}: {cameraInfo}</p>}
            </div>
          )}

          {phase === "greet" && (
            <div className="ll-step">
              <h2>{t.greetTitle}</h2>
              <p>{t.greetHelp}</p>
              {inputMode === "voice" && <VoiceAnswerBox key="greet" lang={lang} question="greet" onAnswer={() => receiveWai("button")} />}
              <button className="ll-btn primary big" onClick={() => receiveWai("button")}>🙏 {t.waiButton}</button>
            </div>
          )}

          {phase === "approach" && (
            <div className="ll-step">
              <h2>{t.approachTitle}</h2>
              <p>{t.approachHelp}{inputMode === "camera" ? ` ${t.leanHint}` : ""}</p>
              <div className="ll-meter" aria-label={t.distanceLabel}>
                {STEPS.slice(1).map((_, i) => <span key={i} className={i < step ? "on" : ""} />)}
              </div>
              {inputMode === "voice" && <VoiceAnswerBox key="approach" lang={lang} question="approach" onAnswer={answerApproach} />}
              <div className="ll-choices">
                <button className="ll-btn primary big" onClick={approachNext}><Play size={18} aria-hidden="true" /> {t.continue}</button>
                <button className="ll-btn big good" onClick={comfortable}><HeartHandshake size={18} aria-hidden="true" /> {t.comfortable}</button>
                <button className="ll-btn big warn" onClick={() => tooClose("button")}><Hand size={18} aria-hidden="true" /> {t.tooClose}</button>
                <button className="ll-btn big" onClick={tooFast}><Snail size={18} aria-hidden="true" /> {t.tooFast} {speed < 1 ? `(×${speed.toFixed(2)})` : ""}</button>
              </div>
            </div>
          )}

          {phase === "care" && (
            <div className="ll-step">
              <h2>{t.careTitle}</h2>
              {inputMode === "voice" && CARE_QUESTIONS[careQuestion] === "anxiety" && (
                <VoiceAnswerBox key="anxiety" lang={lang} question="anxiety" onAnswer={(answer) => { chooseAnxiety(answer); afterCareAnswer(); }} />
              )}
              {inputMode === "voice" && CARE_QUESTIONS[careQuestion] === "communication" && (
                <VoiceAnswerBox key="communication" lang={lang} question="communication" onAnswer={(answer) => { chooseAccessible(answer === "accessible"); afterCareAnswer(); }} />
              )}
              {inputMode === "voice" && CARE_QUESTIONS[careQuestion] === "reach" && (
                <VoiceAnswerBox key="reach" lang={lang} question="reach" onAnswer={(answer) => { chooseReach(answer === "avoid"); afterCareAnswer(); }} />
              )}
              <p className="ll-q">{t.qAnxiety}</p>
              <div className="ll-seg" role="group" aria-label={t.qAnxiety}>
                {(["low", "medium", "high"] as const).map((lvl) => (
                  <button key={lvl} className={`ll-btn ${anxiety === lvl ? "sel" : ""}`} aria-pressed={anxiety === lvl} onClick={() => chooseAnxiety(lvl)}>{t.anxietyLabels[lvl]}</button>
                ))}
              </div>
              <p className="ll-q">{t.qComm}</p>
              <div className="ll-seg" role="group" aria-label={t.qComm}>
                <button className={`ll-btn ${!accessible ? "sel" : ""}`} aria-pressed={!accessible} onClick={() => chooseAccessible(false)}>{t.commNormal}</button>
                <button className={`ll-btn ${accessible ? "sel" : ""}`} aria-pressed={accessible} onClick={() => chooseAccessible(true)}>{t.commAccessible}</button>
              </div>
              <p className="ll-q">{t.qReach}</p>
              <div className="ll-seg" role="group" aria-label={t.qReach}>
                <button className={`ll-btn ${!noReach ? "sel" : ""}`} aria-pressed={!noReach} onClick={() => chooseReach(false)}>{t.reachOk}</button>
                <button className={`ll-btn ${noReach ? "sel" : ""}`} aria-pressed={noReach} onClick={() => chooseReach(true)}>{t.reachAvoid}</button>
              </div>
              <button className="ll-btn primary big" style={{ width: "100%", marginTop: 12 }} onClick={careDone}><Play size={18} aria-hidden="true" /> {t.next}</button>
            </div>
          )}

          {phase === "gaze" && (
            <div className="ll-step">
              <h2>{t.gazeTitle}</h2>
              {inputMode === "voice" && <VoiceAnswerBox key="gaze" lang={lang} question="gaze" onAnswer={chooseGaze} />}
              <div className="ll-choices">
                <button className="ll-btn big" onClick={() => chooseGaze("direct")}>{t.gazeDirectBtn}</button>
                <button className="ll-btn big" onClick={() => chooseGaze("soft")}>{t.gazeSoftBtn}</button>
              </div>
            </div>
          )}

          {phase === "auto" && (
            <div className="ll-step">
              <h2>{t.autoTitle}</h2>
              <p>{t.autoSimNote}</p>
              <p className="ll-auto-stage" aria-live="polite">{autoPaused ? t.autoPause[autoPaused] : t.autoStages[autoStage]}</p>
              <div className="ll-meter" aria-label={t.distanceLabel}>
                {STEPS.slice(1).map((_, i) => <span key={i} className={i < step ? "on" : ""} />)}
              </div>
              <div className="ll-auto-signals">
                <span className={autoPerson ? "ok" : "warn"}>{autoPerson ? t.autoSignalPerson : t.autoSignalNoPerson}</span>
                <span>{t.autoSignalWai}: {autoWai === null ? "…" : autoWai ? "✓" : "–"}</span>
                <span>{t.autoSignalLean}: {autoLeans}</span>
              </div>
              <button className="ll-btn" onClick={stopAuto}>{t.autoStop}</button>
            </div>
          )}

          {(phase === "review" || (phase === "saving" && inputMode === "auto")) && autoResult && (
            <div className="ll-step">
              <h2>{t.reviewTitle}</h2>
              <ul className="ll-facts">
                <li>{t.factDistance}: {describeDistance(autoResult.result.comfortDistance)[lang]}</li>
                <li>{t.factSpeed}: {autoResult.result.speed < 1 ? t.slow : t.normal}</li>
                <li>{t.factGaze}: {autoResult.result.gaze === "soft" ? t.soft : t.direct}</li>
                <li>{t.factVoice}: {t.on}</li>
              </ul>
              <p className="ll-q">{t.reviewEvidence}</p>
              <ul className="ll-list">
                <li>{autoResult.evidence.waiDetected ? t.reviewWaiYes : t.reviewWaiNo}</li>
                <li>{t.reviewLeans(autoResult.evidence.leanBacks)}</li>
                {autoResult.evidence.leanIn && <li>{t.reviewLeanIn}</li>}
                <li>{t.reviewGaze(autoResult.evidence.avertShare)}</li>
              </ul>
              <p className="ll-note">{t.reviewDefaults}</p>
              {phase === "saving" ? (
                <p className="ll-countdown" role="status">{t.statusSaving}</p>
              ) : countdown !== null ? (
                <p className="ll-countdown" role="timer">{t.reviewSaving(countdown)}</p>
              ) : (
                <p className="ll-note">{t.reviewHeld}</p>
              )}
              <div className="ll-row">
                <button className="ll-btn primary" onClick={saveAuto} disabled={phase === "saving"}>{t.reviewSaveNow}</button>
                {countdown !== null && phase === "review" && <button className="ll-btn" onClick={() => setCountdown(null)}>{t.reviewStop}</button>}
                <button className="ll-btn" disabled={phase === "saving"} onClick={startOver}>
                  <Pause size={18} aria-hidden="true" /> {t.again}
                </button>
              </div>
              {error && <p className="ll-error">{error}</p>}
            </div>
          )}

          {phase === "voice" && (
            <div className="ll-step">
              <h2>{t.voiceTitle}</h2>
              {inputMode === "voice" && <VoiceAnswerBox key="voice" lang={lang} question="voice" onAnswer={(answer) => chooseVoice(answer === "on")} />}
              <div className="ll-choices">
                <button className="ll-btn big" onClick={() => chooseVoice(true)}><Volume2 size={18} aria-hidden="true" /> {t.voiceYes}</button>
                <button className="ll-btn big" onClick={() => chooseVoice(false)}><VolumeX size={18} aria-hidden="true" /> {t.voiceNo}</button>
              </div>
            </div>
          )}

          {(phase === "confirm" || (phase === "saving" && inputMode !== "auto")) && (
            <div className="ll-step" data-testid="confirm-step">
              <h2>{t.confirmTitle}</h2>
              <p className="ll-note">{t.confirmHint}</p>
              <fieldset className="ll-review" disabled={phase === "saving"}>
                <p className="ll-q">{t.factGreeting}</p>
                <div className="ll-seg" role="group" aria-label={t.factGreeting}>
                  {(["wai", "wave", "none"] as const).map((g) => (
                    <button key={g} className={`ll-btn ${greeting === g ? "sel" : ""}`} aria-pressed={greeting === g} onClick={() => setGreeting(g)}>{t.greetingLabels[g]}</button>
                  ))}
                </div>
                <p className="ll-q">{t.factDistance}</p>
                <div className="ll-seg" role="group" aria-label={t.factDistance}>
                  {(["close", "medium", "far"] as const).map((band) => {
                    const selected = describeDistance(comfort ?? robotRef.current?.state.distanceTarget ?? 0).en === band;
                    return <button key={band} className={`ll-btn ${selected ? "sel" : ""}`} aria-pressed={selected} onClick={() => { if (!selected) reviewDistance(band); }}>{t.distanceLabels[band]}</button>;
                  })}
                </div>
                <p className="ll-q">{t.factSpeed}</p>
                <div className="ll-seg" role="group" aria-label={t.factSpeed}>
                  <button className={`ll-btn ${speed >= 1 ? "sel" : ""}`} aria-pressed={speed >= 1} onClick={() => reviewSpeed(1)}>{t.normal}</button>
                  <button className={`ll-btn ${speed < 1 ? "sel" : ""}`} aria-pressed={speed < 1} onClick={() => { if (speed >= 1) reviewSpeed(REVIEW_SLOWER_SPEED); }}>{t.slow}</button>
                </div>
                <p className="ll-q">{t.factGaze}</p>
                <div className="ll-seg" role="group" aria-label={t.factGaze}>
                  <button className={`ll-btn ${gaze === "direct" ? "sel" : ""}`} aria-pressed={gaze === "direct"} onClick={() => applyGaze("direct")}>{t.direct}</button>
                  <button className={`ll-btn ${gaze === "soft" ? "sel" : ""}`} aria-pressed={gaze === "soft"} onClick={() => applyGaze("soft")}>{t.soft}</button>
                </div>
                <p className="ll-q">{t.factVoice}</p>
                <div className="ll-seg" role="group" aria-label={t.factVoice}>
                  <button className={`ll-btn ${voice ? "sel" : ""}`} aria-pressed={voice} onClick={() => { setVoice(true); voiceRef.current = true; }}>{t.voiceYes}</button>
                  <button className={`ll-btn ${!voice ? "sel" : ""}`} aria-pressed={!voice} onClick={() => { setVoice(false); voiceRef.current = false; window.speechSynthesis?.cancel(); }}>{t.voiceNo}</button>
                </div>
                <p className="ll-q">{t.factAnxiety}</p>
                <div className="ll-seg" role="group" aria-label={t.factAnxiety}>
                  {(["low", "medium", "high"] as const).map((lvl) => (
                    <button key={lvl} className={`ll-btn ${anxiety === lvl ? "sel" : ""}`} aria-pressed={anxiety === lvl} onClick={() => chooseAnxiety(lvl)}>{t.anxietyLabels[lvl]}</button>
                  ))}
                </div>
                <p className="ll-q">{t.factComm}</p>
                <div className="ll-seg" role="group" aria-label={t.factComm}>
                  <button className={`ll-btn ${!accessible ? "sel" : ""}`} aria-pressed={!accessible} onClick={() => chooseAccessible(false)}>{t.commNormal}</button>
                  <button className={`ll-btn ${accessible ? "sel" : ""}`} aria-pressed={accessible} onClick={() => chooseAccessible(true)}>{t.commAccessible}</button>
                </div>
                <p className="ll-q">{t.factReach}</p>
                <div className="ll-seg" role="group" aria-label={t.factReach}>
                  <button className={`ll-btn ${!noReach ? "sel" : ""}`} aria-pressed={!noReach} onClick={() => chooseReach(false)}>{t.reachOk}</button>
                  <button className={`ll-btn ${noReach ? "sel" : ""}`} aria-pressed={noReach} onClick={() => chooseReach(true)}>{t.reachAvoid}</button>
                </div>
              </fieldset>
              {inputMode === "voice" && phase === "confirm" && <VoiceAnswerBox key="confirm" lang={lang} question="confirm" onAnswer={() => { void saveReviewed(); }} />}
              {phase === "saving" && <p className="ll-countdown" role="status">{t.statusSaving}</p>}
              <div className="ll-row">
                <button className="ll-btn primary" onClick={saveReviewed} disabled={phase === "saving"}>{t.confirmSave}</button>
                <button className="ll-btn" disabled={phase === "saving"} onClick={startOver}><Pause size={18} aria-hidden="true" /> {t.again}</button>
              </div>
              {error && <p className="ll-error" role="alert">{error}</p>}
            </div>
          )}

          {phase === "done" && passportCode && accessToken && editToken && (
            <div className="ll-step">
              <h2>{t.passportTitle}</h2>
              <PassportCardVisual
                issued
                heading={t.cardHeading}
                motto={t.cardMotto}
                code={passportCode}
                codeLabel={t.codeLabel}
                codeClassName="ll-code"
                qr={qr}
                qrAlt={t.qrAlt}
                statusLabel={t.cardActive}
                active
                language={lang}
                version={1}
                meta={t.cardVersion(1)}
                prefs={[
                  { key: "distance", label: t.factDistance, value: describeDistance(comfort ?? 0)[lang] },
                  { key: "speed", label: t.factSpeed, value: speed < 1 ? t.slow : t.normal },
                  { key: "gaze", label: t.factGaze, value: gaze === "soft" ? t.soft : t.direct },
                  { key: "language", label: t.factLanguage, value: lang === "th" ? t.langThai : t.langEnglish },
                  { key: "speech", label: t.factSpeech, value: accessible ? t.slow : t.normal }
                ]}
              />
              <p className="ll-q">{t.moreTitle}</p>
              <ul className="ll-facts ll-more">
                <li><span>{t.factGreeting}</span><strong>{t.greetingLabels[greeting]}</strong></li>
                <li><span>{t.factVoice}</span><strong>{voice ? t.on : t.off}</strong></li>
                <li><span>{t.factAnxiety}</span><strong>{inputMode === "auto" ? t.factNotAsked : t.anxietyLabels[anxiety]}</strong></li>
                <li><span>{t.factComm}</span><strong>{accessible ? t.commAccessible : t.commNormal}</strong></li>
                <li><span>{t.factReach}</span><strong>{noReach ? t.reachAvoid : t.reachOk}</strong></li>
              </ul>
              {identity && <p className="ll-owner"><BadgeCheck size={16} aria-hidden="true" /> {idT.savedUnder(identity.email)}</p>}
              <p className="ll-note">{t.scanHint}</p>
              <div className="ll-editkey">
                <p><strong>{t.editKeyTitle}</strong></p>
                <div className="ll-editkey-row">
                  <code>{editToken}</code>
                  <button type="button" className="ll-btn" onClick={copyEditKey}>{keyCopied ? t.copied : t.copyKey}</button>
                </div>
                <p className="ll-note">{t.editKeyHint}</p>
              </div>
              <div className="ll-row">
                <Link className="ll-btn primary" href={`/living-lab/passport/${accessToken}`}>{t.cardLink}</Link>
                <Link className="ll-btn" href={`/living-lab/meet/${passportCode}`}>🏥 {t.meetNow}</Link>
                <Link className="ll-btn" href="/living-lab/robot">{t.consoleLink}</Link>
                <button className="ll-btn" onClick={startOver}><Pause size={18} aria-hidden="true" /> {t.again}</button>
              </div>
            </div>
          )}

          <details className="ll-log-wrap">
            <summary>{t.logTitle} ({log.length})</summary>
            <div className="ll-log" ref={logRef} role="log">
              {log.map((e, i) => <div key={i}><b className={e.src}>{e.src}</b> {e.t.toFixed(1)}s · {e.type}</div>)}
            </div>
          </details>
        </div>
        <IdentityCard lang={lang} identity={identity} onChange={setIdentity} locked={phase !== "intro" && phase !== "done"} required={identityRequired} />
        </div>
      </section>

      <section className="ll-findings">
        <h2>{t.findingsTitle}</h2>
        <p className="ll-sub">{t.findingsSub}</p>
        {stats ? (
          <div className="ll-stats">
            <div className="ll-hero"><strong>{stats.comfortWithPassport === null ? "–" : stats.comfortWithPassport.toFixed(1)}<small>/5</small></strong><span>{t.statComfortWith}</span></div>
            <div className="ll-hero muted"><strong>{stats.comfortWithout === null ? "–" : stats.comfortWithout.toFixed(1)}<small>/5</small></strong><span>{t.statComfortWithout}</span></div>
            <div><strong>{stats.ratings}</strong><span>{t.statRatings}</span></div>
            <div><strong>{stats.passports}</strong><span>{t.statPassports}</span></div>
            <div><strong>{stats.meetings}</strong><span>{t.statMeetings}</span></div>
            <div><strong>{stats.avgDistance === null ? "–" : describeDistance(stats.avgDistance)[lang]}</strong><span>{t.statDistance}</span></div>
            <div><strong>{pct(stats.softGazeShare)}</strong><span>{t.statSoftGaze}</span></div>
            <div><strong>{pct(stats.slowedShare)}</strong><span>{t.statSlowed}</span></div>
            <div><strong>{stats.tooCloseTotal}</strong><span>{t.statTooClose}</span></div>
          </div>
        ) : (
          <p className="ll-error">{t.dbOffline}</p>
        )}
        {robots.length > 0 && (
          <>
            <h3>{t.robotsTitle}</h3>
            <p className="ll-sub">{t.robotsSub}</p>
            <ul className="ll-robots">
              {robots.slice(0, 12).map((r) => (
                <li key={r.id}>
                  <strong>{r.name}</strong>
                  <span>{r.type.replace(/_/g, " ")}{r.org ? ` · ${r.org}` : ""}</span>
                  <Link href={`/living-lab/meet?robot=${r.id}`}>{t.meetThisRobot}</Link>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>
    </main>
  );
}

const styles = `
.ll { display: grid; gap: 18px; }
.ll-head { display: flex; justify-content: space-between; gap: 16px; align-items: flex-start; flex-wrap: wrap; border-bottom: 1px solid var(--border); padding-bottom: 14px; }
.ll-head h1 { margin: 4px 0 0; font-size: clamp(26px, 2.4vw, 36px); font-weight: 900; color: #07150f; }
.ll-eyebrow { margin: 0; font-size: 12px; font-weight: 750; letter-spacing: 1.2px; text-transform: uppercase; color: var(--warning); display: inline-flex; gap: 6px; align-items: center; }
.ll-sub { margin: 6px 0 0; color: var(--text-secondary); font-size: 14px; max-width: 720px; line-height: 1.5; }
.ll-grid { display: grid; grid-template-columns: minmax(0, 1.1fr) minmax(320px, 1fr); gap: 16px; align-items: start; }
@media (max-width: 960px) { .ll-grid { grid-template-columns: 1fr; } }
.ll-stage-card { position: relative; background: linear-gradient(180deg, #ffffff, #efe9df); border: 1px solid var(--border); border-radius: 14px; overflow: hidden; height: 600px; }
@media (max-width: 960px) { .ll-stage-card { height: 480px; } }
.ll-stage { position: absolute; inset: 0; }
.ll-canvas { width: 100%; height: 100%; }
.ll-bubble { position: absolute; z-index: 2; left: 14px; right: 14px; top: 14px; background: #fff; border: 1px solid var(--border); border-radius: 12px; padding: 12px 14px; font-size: 17px; line-height: 1.45; box-shadow: 0 8px 20px rgba(0,0,0,.06); min-height: 50px; }
.ll-chip { position: absolute; z-index: 2; left: 14px; bottom: 14px; background: rgba(7,21,15,.85); color: #fff; padding: 7px 13px; border-radius: 999px; font-size: 13px; font-weight: 650; }
.ll-cam { position: absolute; z-index: 2; right: 12px; bottom: 12px; width: 150px; display: none; border-radius: 10px; overflow: hidden; border: 2px solid #fff; background: #000; }
.ll-cam.is-on { display: block; }
.ll-cam video { width: 100%; display: block; transform: scaleX(-1); }
.ll-cam span { position: absolute; left: 0; right: 0; bottom: 0; font-size: 11px; color: #fff; background: rgba(0,0,0,.55); padding: 2px 6px; }
.ll-side { display: grid; gap: 16px; align-content: start; min-width: 0; }
.ll-owner { display: inline-flex; align-items: center; gap: 6px; font-size: 13.5px; font-weight: 700; color: var(--accent-strong); margin: 0 0 8px !important; }
.ll-id { background: var(--surface); border: 1px solid var(--border); border-radius: 14px; padding: 18px; display: grid; gap: 10px; }
.ll-id h2 { margin: 0; font-size: 18px; display: inline-flex; align-items: center; gap: 8px; color: #07150f; }
.ll-id h2 svg { color: var(--accent); }
.ll-id p { margin: 0; }
.ll-id-form { display: grid; gap: 6px; }
.ll-id-form label { font-size: 13px; font-weight: 700; }
.ll-id-inline { display: flex; gap: 8px; flex-wrap: wrap; }
.ll-id-inline input { flex: 1 1 200px; min-width: 0; min-height: 48px; padding: 10px 12px; border: 1px solid var(--border); border-radius: 10px; font: inherit; font-size: 16px; background: #fff; color: #07150f; }
.ll-id-inline input:focus-visible { outline: 3px solid #19c37d; outline-offset: 1px; border-color: var(--accent); }
.ll-id-inline .ll-btn { flex: 0 0 auto; }
.ll-id-code { font: 700 22px ui-monospace, monospace !important; letter-spacing: 8px; text-align: center; }
.ll-id-sent { font-size: 13.5px; line-height: 1.5; background: #f4faf6; border: 1px solid #bcd9c6; border-radius: 10px; padding: 10px 12px; }
.ll-id-links { display: flex; gap: 16px; flex-wrap: wrap; }
.ll-id-link { background: none !important; border: none !important; box-shadow: none !important; padding: 4px 0 !important; min-height: 0 !important; color: var(--accent) !important; font: inherit; font-size: 13.5px; font-weight: 700; text-decoration: underline; cursor: pointer; }
.ll-id-link:disabled { color: var(--text-secondary) !important; text-decoration: none; cursor: default; }
.ll-id-privacy { font-size: 12.5px; color: var(--text-secondary); border-top: 1px solid var(--border); padding-top: 10px; }
.ll-id.is-verified { background: #f4faf6; border-color: #9cc9aa; padding: 12px 14px; }
.ll-id-row { display: flex; align-items: center; gap: 10px; }
.ll-id-check { color: var(--accent); flex: none; }
.ll-id-who { display: grid; min-width: 0; flex: 1; }
.ll-id-who span { font-size: 12px; color: var(--text-secondary); }
.ll-id-who strong { font-size: 15px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ll-id-switch { min-height: 40px !important; padding: 6px 12px !important; font-size: 13.5px; }
.ll-panel { background: var(--surface); border: 1px solid var(--border); border-radius: 14px; padding: 18px; display: grid; gap: 14px; }
.ll-step h2 { margin: 0 0 8px; font-size: 20px; }
.ll-step p { margin: 0 0 12px; line-height: 1.5; }
.ll-list { margin: 0 0 12px; padding-left: 20px; line-height: 1.7; }
.ll-note { font-size: 13px; color: var(--text-secondary); }
.ll-consent { display: flex; gap: 10px; align-items: flex-start; background: #f4faf6; border: 1px solid #bcd9c6; border-radius: 10px; padding: 12px; margin: 0 0 4px; font-size: 13.5px; line-height: 1.5; cursor: pointer; }
.ll-consent input { margin-top: 3px; width: 18px; height: 18px; accent-color: var(--accent); flex: none; }
.ll-consent-hint { margin: 0 0 10px; font-size: 12.5px; font-weight: 700; color: var(--warning); }
.ll-editkey { border: 1px dashed var(--border); border-radius: 10px; padding: 12px; margin: 0 0 12px; background: #fffdf8; }
.ll-editkey p { margin: 0 0 6px; }
.ll-editkey-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-bottom: 6px; }
.ll-editkey code { flex: 1 1 220px; word-break: break-all; font: 12.5px ui-monospace, monospace; background: #0b1511; color: #d9ffe9; border-radius: 8px; padding: 9px 10px; }
.ll-row, .ll-choices { display: flex; gap: 10px; flex-wrap: wrap; }
.ll-choices { display: grid; grid-template-columns: 1fr 1fr; }
.ll-btn { display: inline-flex; align-items: center; justify-content: center; gap: 8px; min-height: 48px; padding: 10px 16px; border-radius: 10px; border: 1px solid var(--border); background: #fff; color: #07150f; font: inherit; font-weight: 700; cursor: pointer; text-decoration: none; }
.ll-btn.big { min-height: 60px; font-size: 17px; }
.ll-btn.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
.ll-btn.good { background: #e8f5ec; border-color: #9cc9aa; }
.ll-btn.warn { background: #fdf1e7; border-color: #e3b48c; }
.ll-btn:disabled { opacity: .55; cursor: not-allowed; }
.ll-btn:focus-visible { outline: 3px solid #19c37d; outline-offset: 2px; }
.ll-meter { display: flex; gap: 6px; margin-bottom: 14px; }
.ll-meter span { flex: 1; height: 10px; border-radius: 6px; background: var(--surface-muted); }
.ll-meter span.on { background: var(--accent); }
.ll-facts { margin: 0; padding-left: 18px; line-height: 1.6; font-size: 14px; }
/* "Also on your passport": label/value rows under the passport card (the card itself is PassportCardVisual). */
.ll-more { list-style: none; padding: 0; display: grid; gap: 0; margin: 0 0 12px; }
.ll-more li { display: flex; justify-content: space-between; gap: 12px; padding: 7px 0; border-bottom: 1px solid var(--border); font-size: 13.5px; }
.ll-more li:last-child { border-bottom: none; }
.ll-more span { color: var(--text-secondary); }
.ll-more strong { text-align: right; }
.ll-error { color: var(--danger); font-size: 14px; }
.ll-q { margin: 12px 0 6px !important; font-weight: 700; }
.ll-voice { background: #f4faf6; border: 1px solid #bcd9c6; border-radius: 10px; padding: 12px; margin: 10px 0; display: grid; gap: 8px; }
.ll-voice .ll-q, .ll-voice .ll-note { margin: 0; }
.ll-heard { margin: 0; font-size: 14px; font-weight: 700; overflow-wrap: anywhere; }
.ll-type { display: grid; gap: 4px; font-size: 13.5px; }
.ll-type-row { display: flex; gap: 8px; }
.ll-type-row input { flex: 1 1 auto; min-width: 0; min-height: 44px; padding: 0 10px; border: 1px solid #9db8a8; border-radius: 8px; font: inherit; background: #fff; color: #07150f; }
.ll-review { border: 0; margin: 0; padding: 0; min-width: 0; }
.ll-seg { display: flex; gap: 8px; flex-wrap: wrap; }
.ll-seg .ll-btn { flex: 1 1 120px; min-height: 48px; }
.ll-btn.sel { background: #e8f5ec; border-color: var(--accent); box-shadow: inset 0 0 0 2px var(--accent); }
.ll-hero { background: #f2faf5; border-color: #9cc9aa !important; }
.ll-hero.muted { background: #faf7f2; border-color: var(--border) !important; }
.ll-hero small { font-size: 14px; font-weight: 700; color: var(--text-secondary); margin-left: 2px; }
.ll-log-wrap summary { cursor: pointer; font-weight: 700; font-size: 14px; }
.ll-log { margin-top: 8px; max-height: 160px; overflow: auto; background: #0b1511; color: #cfe; border-radius: 8px; padding: 8px; font: 12px ui-monospace, monospace; }
.ll-log b.robot { color: #7fd6ff; } .ll-log b.human { color: #ffd27f; }
.ll-findings { background: var(--surface); border: 1px solid var(--border); border-radius: 14px; padding: 18px; }
.ll-findings h2 { margin: 0; font-size: 20px; } .ll-findings h3 { margin: 18px 0 0; font-size: 16px; }
.ll-stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 10px; margin-top: 12px; }
.ll-stats div { border: 1px solid var(--border); border-radius: 10px; padding: 12px; display: grid; gap: 4px; }
.ll-stats strong { font-size: 24px; font-weight: 900; } .ll-stats span { font-size: 12px; color: var(--text-secondary); }
.ll-robots { list-style: none; padding: 0; margin: 10px 0 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 10px; }
.ll-robots li { border: 1px solid var(--border); border-radius: 10px; padding: 10px 12px; display: grid; gap: 3px; }
.ll-robots span { font-size: 12px; color: var(--text-secondary); text-transform: capitalize; }
.ll-robots a { font-size: 13px; font-weight: 700; color: var(--accent); }
.ll-head-actions { display: flex; gap: 8px; flex-wrap: wrap; }
@media (max-width: 560px) {
  .ll-stage-card { height: 380px; }
  .ll-choices { grid-template-columns: 1fr; }
  .ll-head-actions { width: 100%; }
  .ll-head-actions .button { flex: 1 1 auto; }
}
.ll-auto-offer { display: grid; gap: 6px; margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--border); }
.ll-btn.auto { background: #0b1a15; border-color: #0b1a15; color: #fff; width: 100%; }
.ll-btn.auto:disabled { background: #6f7d77; border-color: #6f7d77; }
.ll-auto-stage { font-size: 17px; font-weight: 700; margin: 4px 0 10px; min-height: 1.5em; }
.ll-auto-signals { display: flex; flex-wrap: wrap; gap: 8px; margin: 10px 0 14px; font-size: 13px; }
.ll-auto-signals span { padding: 4px 10px; border-radius: 999px; background: #f4f0e8; border: 1px solid var(--border); }
.ll-auto-signals .ok { background: #e8f5ec; border-color: #9cc9aa; }
.ll-auto-signals .warn { background: #fdf1e7; border-color: #e3b48c; }
.ll-countdown { font-weight: 700; color: var(--accent-strong); margin: 4px 0 10px; }
@media (prefers-reduced-motion: reduce) {
  .ll-btn, .ll-consent input { transition: none; }
}
`;
