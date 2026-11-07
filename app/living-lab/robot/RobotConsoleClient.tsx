"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { Play, Radio, Volume2, VolumeX } from "lucide-react";
import RobotStage from "@/app/components/robot/RobotStage";
import { adapt, DEFAULT_PLAN, type BehaviourPlan } from "@/lib/hri/adapt";
import type { RobotBehavior } from "@/lib/hri/behavior-engine";
import { PROFILE_SCHEMA, type PublicProfile } from "@/lib/hri/public-profile";
import { ROBOT_PROFILES, type RobotCapabilities, type RobotProfile } from "@/lib/hri/robot-profiles";
import { buildDefaultSpeech, buildSpokenSummary } from "@/lib/hri/spoken-summary";
import { robotCopy, type RobotLang } from "./copy";
import styles from "./robot.module.css";

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

// Accept either a raw token or a passport card link (?t=... is not used; the token is the last path segment).
function readToken(raw: string): string | null {
  const value = raw.trim();
  if (TOKEN_RE.test(value)) return value;
  try {
    const url = new URL(value);
    const last = url.pathname.split("/").filter(Boolean).pop() ?? "";
    if (TOKEN_RE.test(last)) return last;
  } catch {
    // Not a URL and not a token.
  }
  return null;
}

// What this robot says, shown as a caption too. The default robot has no passport to talk about.
function spokenText(key: string, plan: BehaviourPlan) {
  return key === "default" ? buildDefaultSpeech(plan.language) : buildSpokenSummary(plan);
}

function speak(text: string, lang: RobotLang, rate: number) {
  const synth = window.speechSynthesis;
  if (!synth) return null;
  synth.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = lang === "th" ? "th-TH" : "en-US";
  utterance.rate = Math.min(1.5, Math.max(0.6, rate));
  synth.speak(utterance);
  return utterance;
}

// Play the plan as a short script: settle, greet, then show how the robot would hand something over.
function perform(robot: RobotBehavior, plan: BehaviourPlan, caps: RobotCapabilities): number[] {
  robot.clearGestures();
  robot.bothArms("relaxed");
  robot.lean("upright");
  robot.expression(plan.demeanor === "calm" ? "calm" : "happy");
  robot.setGlow(plan.demeanor === "calm" ? 0.45 : 0.7, plan.demeanor === "calm" ? "blue" : "teal");
  if (caps.mobile) {
    robot.setDistance(plan.distance.sceneUnits);
    robot.setSpeed(Math.max(plan.movement.multiplier, 0.25));
  } else {
    robot.setSpeed(1);
  }
  if (caps.head) {
    if (plan.eyeContact === "soft") robot.lookAt(0.3, 0.35);
    else if (plan.eyeContact === "direct") robot.lookAt(0, 0.1);
    else robot.lookAt(0, 0.2);
  } else {
    robot.lookAt(0, 0.15);
  }

  const timers: number[] = [];
  if (caps.arms && plan.greeting === "wai") {
    robot.bothArms("wai");
    timers.push(window.setTimeout(() => robot.bow(0.34, 1.6), 450));
    timers.push(window.setTimeout(() => robot.bothArms("relaxed"), 2400));
  } else if (caps.arms && plan.greeting === "wave") {
    robot.wave("R", 2.4);
  }
  timers.push(
    window.setTimeout(() => {
      if (!caps.arms) return;
      if (plan.handover === "hand_to_person") {
        robot.moveArm("R", "offer");
        timers.push(window.setTimeout(() => robot.moveArm("R", "relaxed"), 2200));
      } else {
        robot.lean("forward");
        timers.push(window.setTimeout(() => robot.lean("upright"), 1200));
      }
    }, 3200)
  );
  return timers;
}

export default function RobotConsoleClient({ lang }: { lang: RobotLang }) {
  const t = robotCopy[lang];
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [profile, setProfile] = useState<PublicProfile | null>(null);
  const [speaking, setSpeaking] = useState<string | null>(null);

  const profileRef = useRef<PublicProfile | null>(null);
  const robots = useRef<Record<string, RobotBehavior | null>>({});
  const timers = useRef<Record<string, number[]>>({});

  const performOn = useCallback((key: string, plan: BehaviourPlan, caps: RobotCapabilities) => {
    const robot = robots.current[key];
    if (!robot) return;
    for (const timer of timers.current[key] ?? []) window.clearTimeout(timer);
    timers.current[key] = perform(robot, plan, caps);
  }, []);

  useEffect(() => {
    return () => {
      for (const list of Object.values(timers.current)) {
        for (const timer of list) window.clearTimeout(timer);
      }
      window.speechSynthesis?.cancel();
    };
  }, []);

  useEffect(() => {
    if (!profile) return;
    performOn("a", adapt(profile, ROBOT_PROFILES[0]), ROBOT_PROFILES[0].capabilities);
    performOn("b", adapt(profile, ROBOT_PROFILES[1]), ROBOT_PROFILES[1].capabilities);
  }, [profile, performOn]);

  function ready(key: string, robot: RobotBehavior) {
    robots.current[key] = robot;
    if (key === "default") {
      performOn("default", DEFAULT_PLAN, ROBOT_PROFILES[0].capabilities);
      return;
    }
    const current = profileRef.current;
    if (!current) return;
    const robotProfile = key === "a" ? ROBOT_PROFILES[0] : ROBOT_PROFILES[1];
    performOn(key, adapt(current, robotProfile), robotProfile.capabilities);
  }

  async function readPassport(event: FormEvent) {
    event.preventDefault();
    const token = readToken(input);
    if (!token) {
      setError(t.errorBadToken);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/hri/passport/${encodeURIComponent(token)}`, {
        cache: "no-store",
        headers: { accept: "application/json" }
      });
      const body = (await response.json().catch(() => null)) as
        | (PublicProfile & { error?: string; retryAfterSeconds?: number })
        | null;
      if (!response.ok) {
        setError(
          body?.error === "rate_limited"
            ? t.errorRateLimited
            : body?.error === "invalid_token"
              ? t.errorBadToken
              : body?.error === "revoked" || body?.error === "expired"
                ? t.errorInactive
                : body?.error === "not_found"
                  ? t.errorNotFound
                  : t.errorUnavailable
        );
        return;
      }
      if (!body || body.schema !== PROFILE_SCHEMA || !body.preferences) {
        setError(t.errorUnavailable);
        return;
      }
      profileRef.current = body;
      setProfile(body);
      setSpeaking(null);
      window.speechSynthesis?.cancel();
    } catch {
      setError(t.errorUnavailable);
    } finally {
      setBusy(false);
    }
  }

  function speakPlan(key: string, plan: BehaviourPlan) {
    const utterance = speak(spokenText(key, plan), plan.language, plan.speechRate);
    if (!utterance) return;
    setSpeaking(key);
    utterance.onend = () => setSpeaking((current) => (current === key ? null : current));
    utterance.onerror = () => setSpeaking((current) => (current === key ? null : current));
  }

  function stopSpeaking() {
    window.speechSynthesis?.cancel();
    setSpeaking(null);
  }

  const plans = {
    a: profile ? adapt(profile, ROBOT_PROFILES[0]) : null,
    b: profile ? adapt(profile, ROBOT_PROFILES[1]) : null
  };

  // The nine facts shown for a plan, as display strings (also used to compare against the default robot).
  const shown = (plan: BehaviourPlan) => [
    { label: t.fact.distance, value: plan.distance.fixed ? t.value.fixed : t.value[plan.distance.band] },
    { label: t.fact.speed, value: plan.movement.mobile ? t.value[plan.movement.band] : t.value.stationary },
    { label: t.fact.eyeContact, value: plan.eyeMechanism === "screen_cue" ? t.value.none : t.value[plan.eyeContact] },
    { label: t.fact.greeting, value: plan.greeting === "none" ? t.value.noGesture : t.value[plan.greeting] },
    { label: t.fact.voice, value: plan.voice ? t.value.spoken : t.value.text },
    { label: t.fact.handover, value: plan.handover === "hand_to_person" ? t.value.hand : t.value.place },
    { label: t.fact.captions, value: t.value[plan.captions] },
    { label: t.fact.demeanor, value: t.value[plan.demeanor] },
    { label: t.fact.language, value: t.value[plan.language] }
  ];

  const card = (robot: RobotProfile | null, plan: BehaviourPlan | null, key: "a" | "b" | "default") => {
    const isDefault = robot === null;
    const defaultRobot = ROBOT_PROFILES[0];
    const caps = robot?.capabilities ?? defaultRobot.capabilities;
    const title = robot ? robot.name[lang] : t.defaultTitle;
    const subtitle = robot ? robot.short[lang] : t.defaultHint;
    const active = plan !== null;

    return (
      <article
        key={key}
        data-testid={`robot-card-${key}`}
        className={`${styles.robotCard} ${isDefault ? styles.defaultCard : ""}`}
        aria-label={title}
      >
        <div className={styles.robotHead}>
          <div>
            <h2 className={styles.robotTitle}>{title}</h2>
            <p className={styles.robotSub}>{subtitle}</p>
          </div>
          {isDefault ? (
            <span className={`${styles.badge} ${styles.badgeMuted}`}>{t.previewDefault}</span>
          ) : (
            <span className={`${styles.badge} ${active ? styles.badgeActive : styles.badgeIdle}`}>
              {active ? t.loaded(profile?.version ?? 1) : t.tokenTitle}
            </span>
          )}
        </div>

        <div className={styles.stage}>
          <RobotStage
            framing="portrait"
            className={styles.canvas}
            ariaLabel={`${title} simulation`}
            onReady={(instance) => ready(key, instance)}
          />
          <span className={styles.simTag}>
            <Radio size={12} aria-hidden /> {t.simShort}
          </span>
        </div>

        <p
          data-testid={`robot-speech-${key}`}
          lang={plan?.language}
          className={`${styles.speech} ${plan?.captions === "large" ? styles.speechLarge : ""}`}
        >
          {plan ? spokenText(key, plan) : t.noPassport}
        </p>

        {active && plan ? (
          <>
            <dl className={styles.facts}>
              {(() => {
                // Values that differ from the default robot are what the passport changed: mark them.
                const mine = shown(plan);
                const base = isDefault ? mine : shown(DEFAULT_PLAN);
                return mine.map((fact) => (
                  <Fact
                    key={fact.label}
                    label={fact.label}
                    value={fact.value}
                    changed={!isDefault && fact.value !== base.find((b) => b.label === fact.label)?.value}
                    changedLabel={t.changed}
                  />
                ));
              })()}
            </dl>

            <div>
              <h3 className={styles.subhead}>{t.adaptations}</h3>
              {plan.adaptations.length ? (
                <ul className={styles.adaptations}>
                  {plan.adaptations.map((entry) => {
                    const message = t.adaptation[entry.code];
                    return (
                      <li key={entry.code}>
                        {typeof message === "function" ? message(entry.value) : message}
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p className={styles.note}>{t.noAdaptations}</p>
              )}
            </div>

            <div className={styles.actions}>
              {plan.voice ? (
                speaking === key ? (
                  <button type="button" className={styles.btn} onClick={stopSpeaking}>
                    <VolumeX size={16} aria-hidden /> {t.stop}
                  </button>
                ) : (
                  <button type="button" className={styles.btn} onClick={() => speakPlan(key, plan)}>
                    <Volume2 size={16} aria-hidden /> {t.speak}
                  </button>
                )
              ) : null}
              <button
                type="button"
                className={styles.btn}
                onClick={() => performOn(key, plan, caps)}
              >
                <Play size={16} aria-hidden /> {t.replay}
              </button>
            </div>
          </>
        ) : (
          <p className={styles.note}>{t.noPassport}</p>
        )}
      </article>
    );
  };

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <div>
          <p className={styles.eyebrow}>{t.eyebrow}</p>
          <h1 className={styles.title}>{t.title}</h1>
          <p className={styles.subtitle}>{t.subtitle}</p>
        </div>
        <div className={styles.headerActions}>
          <span className={`${styles.badge} ${styles.badgeWarn} ${styles.simBadge}`}>
            <Radio size={13} aria-hidden /> {t.simNote}
          </span>
          <Link className={styles.btn} href="/living-lab">{t.back}</Link>
        </div>
      </header>

      <section className={styles.panel} aria-labelledby="read-passport">
        <h2 id="read-passport" className={styles.panelTitle}>{t.tokenTitle}</h2>
        <form className={styles.form} onSubmit={readPassport}>
          <label className={styles.label} htmlFor="passport-token">{t.tokenLabel}</label>
          <input
            id="passport-token"
            className={styles.input}
            value={input}
            onChange={(event) => setInput(event.target.value)}
            placeholder={t.tokenPlaceholder}
            autoComplete="off"
            spellCheck={false}
            inputMode="text"
          />
          <p className={styles.hint}>{t.tokenHelp}</p>
          <div className={styles.formActions}>
            <button type="submit" className={`${styles.btn} ${styles.primary}`} disabled={busy}>
              {busy ? t.reading : t.read}
            </button>
            {profile ? <span className={`${styles.badge} ${styles.badgeActive}`}>{t.loaded(profile.version)}</span> : null}
          </div>
        </form>
        {error ? <p className={styles.error} role="alert" data-testid="console-error">{error}</p> : null}
      </section>

      {profile && <p className={styles.legend}><span className={styles.changedTag}>{t.changed}</span> {t.legend}</p>}
      <section className={styles.grid} aria-label={t.eyebrow}>
        {card(ROBOT_PROFILES[0], plans.a, "a")}
        {card(ROBOT_PROFILES[1], plans.b, "b")}
        {card(null, DEFAULT_PLAN, "default")}
      </section>

      {profile ? (
        <details className={styles.json}>
          <summary>{t.jsonTitle}</summary>
          <p className={styles.hint}>{t.jsonHint}</p>
          <pre className={styles.pre} data-testid="console-json">{JSON.stringify(profile, null, 2)}</pre>
        </details>
      ) : null}
    </main>
  );
}

function Fact({ label, value, changed = false, changedLabel }: { label: string; value: string; changed?: boolean; changedLabel?: string }) {
  return (
    <div className={`${styles.fact} ${changed ? styles.factChanged : ""}`}>
      <dt>
        {label}
        {changed && <span className={styles.changedTag}>{changedLabel}</span>}
      </dt>
      <dd>{value}</dd>
    </div>
  );
}
