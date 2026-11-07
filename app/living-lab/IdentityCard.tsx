"use client";

// "Who is this passport for?" card: email -> 6-digit code -> verified.
// The code is generated, stored (as a hash) and emailed by the server; this component never sees it
// except as what the person types.
import { useEffect, useRef, useState } from "react";
import { BadgeCheck, Mail, ShieldCheck } from "lucide-react";
import { requestEmailCodeAction, signOutParticipantAction, verifyEmailCodeAction, type ClientIdentity } from "./identity-actions";
import { identityCopy } from "./identity-copy";
import type { Lang } from "./copy";

type ErrorKey = keyof (typeof identityCopy)["en"]["errors"];

export default function IdentityCard({ lang, identity, onChange, locked, required = true }: {
  lang: Lang;
  identity: ClientIdentity;
  onChange: (identity: ClientIdentity) => void;
  // True while a calibration is running: switching person mid-session would save to the wrong owner.
  locked: boolean;
  // False under the HRI_IDENTITY_REQUIRED=false fallback: verifying is offered but not needed to start.
  required?: boolean;
}) {
  const t = identityCopy[lang];
  const [step, setStep] = useState<"email" | "code">("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cooldown, setCooldown] = useState(0);
  const codeRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (cooldown <= 0) return;
    const id = window.setTimeout(() => setCooldown((s) => s - 1), 1000);
    return () => window.clearTimeout(id);
  }, [cooldown]);
  useEffect(() => { if (step === "code") codeRef.current?.focus(); }, [step]);

  const showError = (key: ErrorKey, retryAfter?: number) =>
    setError(retryAfter ? `${t.errors[key]} ${t.waitSeconds(retryAfter)}` : t.errors[key]);

  async function send() {
    if (busy) return;
    setBusy(true); setError(null);
    try {
      const res = await requestEmailCodeAction(email, lang);
      if (res.ok) {
        setStep("code"); setCode(""); setCooldown(res.resendInSeconds);
      } else {
        showError(res.error, "retryAfterSeconds" in res ? res.retryAfterSeconds : undefined);
        if (res.error === "rate_limited" && "retryAfterSeconds" in res && res.retryAfterSeconds && step === "code") setCooldown(res.retryAfterSeconds);
      }
    } catch {
      showError("unavailable");
    } finally {
      setBusy(false);
    }
  }

  async function verify() {
    if (busy) return;
    setBusy(true); setError(null);
    try {
      const res = await verifyEmailCodeAction(email, code);
      if (res.ok) {
        onChange(res.identity);
        setStep("email"); setEmail(""); setCode("");
      } else {
        showError(res.error, "retryAfterSeconds" in res ? res.retryAfterSeconds : undefined);
        if (res.error === "wrong_code") { setCode(""); codeRef.current?.focus(); }
      }
    } catch {
      showError("unavailable");
    } finally {
      setBusy(false);
    }
  }

  async function signOut() {
    if (locked) return;
    await signOutParticipantAction().catch(() => undefined);
    onChange(null);
    setError(null);
  }

  if (identity) {
    return (
      <section className="ll-id is-verified" aria-label={t.title}>
        <div className="ll-id-row">
          <BadgeCheck size={22} aria-hidden="true" className="ll-id-check" />
          <div className="ll-id-who">
            <span>{t.signedInAs}</span>
            <strong>{identity.email}</strong>
          </div>
          <button type="button" className="ll-btn ll-id-switch" onClick={signOut} disabled={locked} title={locked ? t.locked : undefined}>
            {t.notYou}
          </button>
        </div>
        {locked && <p className="ll-note">{t.locked}</p>}
      </section>
    );
  }

  return (
    <section className="ll-id" aria-label={t.title}>
      <h2><ShieldCheck size={20} aria-hidden="true" /> {t.title}</h2>
      <p className="ll-note">{required ? t.why : t.optional}</p>

      {step === "email" ? (
        <form className="ll-id-form" onSubmit={(e) => { e.preventDefault(); send(); }}>
          <label htmlFor="ll-id-email">{t.emailLabel}</label>
          <div className="ll-id-inline">
            <input
              id="ll-id-email" type="email" inputMode="email" autoComplete="email" required maxLength={254}
              placeholder={t.emailPlaceholder} value={email} onChange={(e) => setEmail(e.target.value)} disabled={busy}
            />
            <button type="submit" className="ll-btn primary" disabled={busy || !email.trim()}>
              <Mail size={18} aria-hidden="true" /> {busy ? t.sending : t.send}
            </button>
          </div>
        </form>
      ) : (
        <form className="ll-id-form" onSubmit={(e) => { e.preventDefault(); verify(); }}>
          <p className="ll-id-sent">{t.codeSentTo(email.trim().toLowerCase())}</p>
          <label htmlFor="ll-id-code">{t.codeLabel}</label>
          <div className="ll-id-inline">
            <input
              id="ll-id-code" ref={codeRef} className="ll-id-code" inputMode="numeric" autoComplete="one-time-code"
              pattern="\d{6}" maxLength={6} placeholder="••••••" value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))} disabled={busy}
            />
            <button type="submit" className="ll-btn primary" disabled={busy || code.length !== 6}>
              {busy ? t.verifying : t.verify}
            </button>
          </div>
          <div className="ll-id-links">
            <button type="button" className="ll-id-link" onClick={send} disabled={busy || cooldown > 0}>
              {cooldown > 0 ? t.resendIn(cooldown) : t.resend}
            </button>
            <button type="button" className="ll-id-link" onClick={() => { setStep("email"); setCode(""); setError(null); }} disabled={busy}>
              {t.changeEmail}
            </button>
          </div>
        </form>
      )}

      {error && <p className="ll-error" role="alert">{error}</p>}
      <p className="ll-id-privacy">{t.privacy}</p>
    </section>
  );
}
