# Living Lab Identity: ระบุตัวตนเจ้าของข้อมูลด้วยการยืนยันอีเมล (EmailJS)

สถานะ: **Implemented ในโค้ด (เฟส I-1 ถึง I-4) แต่ migration ยังไม่ได้ apply ลง database ใดๆ** ดู §13 · เขียน 2026-11-07 · ขอบเขต: เฉพาะฟีเจอร์เสริม `/living-lab` เท่านั้น

---

## 1. ปัญหา

ตอนนี้ HRI Passport และ HriSession ทุกแถวเป็น **anonymous** สิ่งเดียวที่ผูกข้อมูลกับคนคือ
`editToken` ที่อยู่ใน `localStorage` ของเบราว์เซอร์เครื่องที่สร้าง ผลคือ

- ไม่รู้ว่า passport / comfort rating / session log เป็นของใคร
- เปลี่ยนเครื่อง ล้าง browser หรือทำ edit key หาย = เสียสิทธิ์เจ้าของถาวร
- คนเดียวสร้างหลาย passport ได้โดยไม่มีอะไรเชื่อมกัน ทำให้ข้อมูลวิจัยนับคนซ้ำ

**เป้าหมาย:** ทุก passport ใหม่ใน Living Lab ผูกกับ **Participant** หนึ่งคน ที่พิสูจน์แล้วว่าเป็นเจ้าของอีเมลนั้นจริง
(ผ่านรหัส OTP 6 หลักที่ส่งทาง EmailJS) โดยไม่กระทบส่วนอื่นของเว็บ และไม่ทำให้ robot API เปิดเผยข้อมูลส่วนตัวเพิ่ม

**นอกขอบเขต:** ระบบ admin (`lib/admin-session.ts`), หน้าอื่นนอก `/living-lab`, รหัสผ่าน, social login

---

## 2. ข้อตัดสินใจสำคัญที่สุด: EmailJS ต้องถูกเรียกจาก **server** ไม่ใช่ browser

EmailJS ออกแบบมาให้เรียกจาก browser (`@emailjs/browser`) แต่ถ้าใช้แบบนั้นกับ OTP ระบบจะไม่ปลอดภัยเลย:

| ถ้าส่งจาก browser | ผลเสีย |
|---|---|
| browser ต้องรู้ OTP ก่อนส่ง | ผู้ใช้ (หรือใครก็ได้ที่เปิด DevTools) ยืนยันอีเมลของคนอื่นได้ทันที → การยืนยันไม่มีความหมาย |
| public key + template อยู่ในโค้ดฝั่ง client | ใครก็เอาไปยิงอีเมลสแปมผ่าน quota ของเราได้ |

**ดังนั้น:** server สร้าง OTP → เก็บเฉพาะ hash → เรียก EmailJS REST API
(`POST https://api.emailjs.com/api/v1.0/email/send`) จาก server action พร้อม **private key** (`accessToken`)
โดย browser ไม่เคยเห็นรหัสหรือ key ใดๆ

ต้องเปิด **Account → Security → "Allow EmailJS API for non-browser applications"** ใน dashboard EmailJS
และแนะนำให้เปิด "Use Private Key" ด้วย

---

## 3. Dependency และ seam (ตาม DEEPENING.md)

| Dependency | หมวด | การจัดการ |
|---|---|---|
| สร้าง OTP, hash, เทียบ, หมดอายุ, นับครั้ง, normalize อีเมล, sign session | 1. In-process | อยู่ใน implementation ล้วน ไม่มี seam |
| Postgres (Prisma) | 2. Local-substitutable | ทำตามแพทเทิร์นเดิมของ `getPassportResponse(token, caller, deps)` ใน `lib/hri/passport-api.ts`: inject `store` ที่เล็กที่สุด มี 2 adapter (Prisma + in-memory สำหรับ unit test) |
| Rate limit (`HriRateLimit`) | 2. Local-substitutable | ใช้ `consume`/`peek` แบบเดียวกับ `PassportApiDeps` |
| **EmailJS** | **4. True external** | **port `OtpMailer`** + 2 adapter: `emailJsMailer` (production) และ `memoryMailer` (test) → เป็น seam จริงเพราะมี 2 adapter |
| เวลา | In-process แต่ต้องควบคุมใน test | inject `now()` (มีอยู่แล้วใน `PassportApiDeps`) |

---

## 4. Design It Twice: 3 interface ที่ต่างกันจริง

### A. Minimal: 3 entry points (แนะนำ)

```ts
// lib/hri/identity.ts  (framework-free, server-only)
export function createIdentity(deps: IdentityDeps): {
  requestCode(email: string, caller: string): Promise<RequestResult>;
  verifyCode(email: string, code: string, caller: string): Promise<VerifyResult>;
  readSession(token: string | undefined): Promise<Participant | null>;
};
```

### B. Flexible: channel-agnostic

`createChallenge(channel, address)`, `attempt(challengeId, code)`, `issueSession()`, `revokeSession()`,
`listChallenges()` พร้อม `VerificationChannel` interface สำหรับ email/SMS/LINE

### C. Optimised for the most common caller

ไม่มี module identity แยก: `createPassportAction(passport, session, consent, { email, code })`
ยืนยันอีเมลและบันทึก passport ในการเรียกครั้งเดียว

### เปรียบเทียบ

| | A. Minimal | B. Flexible | C. Common caller |
|---|---|---|---|
| Depth | สูง: 3 entry point ซ่อนทุกกฎ (expiry, attempts, cooldown, enumeration, signing) | ต่ำ: caller ต้องรู้ลำดับ challenge → attempt → issue เอง = shallow | สูงสำหรับ caller เดียว แต่ไม่มีใครใช้ซ้ำได้ |
| Locality | กฎความปลอดภัยทั้งหมดอยู่ไฟล์เดียว | กระจายไปตาม caller | ปนอยู่ใน `actions.ts` ที่ยาวอยู่แล้ว |
| Seam | `OtpMailer` มี 2 adapter = จริง | `VerificationChannel` มี adapter เดียว (email) = **hypothetical seam** | ไม่มี seam ทดสอบยาก |
| อนาคต (My passports, claim) | ใช้ `readSession` ได้ทันที | ได้ | ต้องรื้อ |

**คำแนะนำ: A** และยืมจุดเด่นของ C มา: `createPassportAction` **ไม่รับพารามิเตอร์ identity เพิ่ม**
แต่อ่าน participant จาก cookie เอง caller ฝั่ง UI จึงแทบไม่ต้องเปลี่ยน ส่วน B ปฏิเสธ เพราะ SMS/LINE ยังไม่มีจริง
ถ้าวันหนึ่งมี ค่อยเพิ่ม adapter ตัวที่สองที่ seam `OtpMailer` (ซึ่งจะกลายเป็น `CodeSender`)

---

## 5. Interface ของ module ที่แนะนำ (ครบทุกอย่างที่ caller ต้องรู้)

```ts
// lib/hri/identity.ts
export type Participant = { id: string; email: string };

export type RequestResult =
  | { ok: true; resendInSeconds: number }
  | { ok: false; error: "invalid_email" | "rate_limited" | "send_failed"; retryAfterSeconds?: number };

export type VerifyResult =
  | { ok: true; participant: Participant; sessionToken: string; maxAgeSeconds: number }
  | { ok: false; error: "wrong_code" | "expired" | "too_many_attempts" | "rate_limited" };

// The only external seam. Two adapters: emailJsMailer (prod) and memoryMailer (tests).
export type OtpMailer = {
  send(message: { toEmail: string; code: string; expiresInMinutes: number; language: "th" | "en" }): Promise<void>;
};

export type IdentityDeps = {
  mailer: OtpMailer;
  store: IdentityStore;           // Prisma adapter in prod, in-memory in unit tests
  consume: RateFn; peek: RateFn;  // same shape as PassportApiDeps
  now: () => Date;
  secret: string;                 // HRI_IDENTITY_SECRET
};
```

**Invariants / error modes ที่เป็นส่วนหนึ่งของ interface:**

1. `requestCode` คืน `ok: true` สำหรับทุกอีเมลที่รูปแบบถูกต้อง ไม่ว่าเคยลงทะเบียนหรือไม่ (ไม่เปิดเผยว่าใครเป็นสมาชิก)
2. ขอรหัสใหม่ = รหัสเก่าของอีเมลนั้นใช้ไม่ได้ทันที มีรหัสที่ใช้ได้ได้ทีละ 1 ตัวต่ออีเมล
3. รหัสใช้ได้ **ครั้งเดียว**, หมดอายุ **10 นาที**, ผิดได้ **5 ครั้ง** แล้ว challenge นั้นตาย (`too_many_attempts`)
4. `verifyCode` สำเร็จครั้งแรก = สร้าง Participant (sign-up และ sign-in คือ flow เดียวกัน)
5. `sendFailed` ไม่ทิ้ง challenge ที่ใช้ได้ไว้ (ลบ/mark consumed) และไม่หัก cooldown ของผู้ใช้
6. `readSession` ไม่ throw: token ปลอม หมดอายุ หรือ participant ถูกลบ → `null`
7. อีเมลถูก normalize (trim + lowercase) ก่อนทุกอย่าง caller ไม่ต้องทำเอง

**สิ่งที่ implementation ซ่อนไว้หลัง interface:**

- OTP 6 หลักจาก `crypto.randomInt` (ไม่ใช่ `Math.random`)
- เก็บ `HMAC-SHA256(secret, email + ":" + code)` ไม่ใช่ SHA-256 เปล่า เพราะรหัส 6 หลักมีแค่ 1 ล้านแบบ
  ถ้า DB หลุด SHA-256 เปล่า brute-force ได้ในเสี้ยววินาที
- เทียบแบบ constant-time (`timingSafeEqual`)
- rate limit: ส่งต่ออีเมล 3 ครั้ง/10 นาที + cooldown 60 วินาที, ส่งต่อ IP 10 ครั้ง/ชม., verify ต่อ IP 30 ครั้ง/10 นาที
  key ของ rate limit ใช้ `hash(email)` ไม่ใช่อีเมลดิบ
- session token แบบ stateless signed (`participantId.expiresAt.sessionVersion.HMAC`) แบบเดียวกับ `admin-session.ts`
  แต่ใช้ secret แยก (`HRI_IDENTITY_SECRET`) อายุ **14 วัน** (`SESSION_MAX_AGE_SECONDS = 14 * 24 * 60 * 60`) `sessionVersion` บน Participant ใช้ "ออกจากระบบทุกเครื่อง"

---

## 6. Data model (migration แบบ additive เท่านั้น, ทำบน Neon `dev` ก่อน)

```prisma
model HriParticipant {
  id             String        @id @default(cuid())
  email          String        @unique          // normalized lowercase
  verifiedAt     DateTime
  sessionVersion Int           @default(1)       // bump = sign out everywhere
  passports      HriPassport[]
  createdAt      DateTime      @default(now())
}

model HriEmailChallenge {
  id         String    @id @default(cuid())
  email      String                              // normalized
  codeHash   String                              // HMAC, never the code
  attempts   Int       @default(0)
  expiresAt  DateTime
  consumedAt DateTime?
  createdAt  DateTime  @default(now())
  @@index([email, createdAt])
}

model HriPassport {
  // ...existing fields unchanged...
  participantId String?
  participant   HriParticipant? @relation(fields: [participantId], references: [id], onDelete: SetNull)
  @@index([participantId])
}
```

- `participantId` เป็น **nullable**: passport เก่าทั้งหมดยังอยู่และทำงานเหมือนเดิม (ไม่ลบ ไม่แก้ข้อมูลเดิม)
  passport **ใหม่**ต้องมี `participantId` เสมอ (บังคับที่ `createPassportAction` ไม่ใช่ที่ schema เพราะแถวเก่าเป็น null)
- ลบ participant → `onDelete: SetNull`: passport ยังอยู่แต่ไม่ผูกกับใคร (ตัดสินแล้ว ดูข้อ 12)
- ความเป็นเจ้าของของ `HriSession` ได้มาจาก `passport.participantId` อยู่แล้ว จึงไม่ต้องเพิ่มคอลัมน์ใน `HriSession`
- `HriEmailChallenge` ที่หมดอายุเกิน 1 วันลบทิ้งแบบสุ่ม 1% เหมือน `HriRateLimit`

---

## 7. Callers: ส่วนที่ใช้ module (แต่ละตัวบางมาก)

**`app/living-lab/identity-actions.ts`** (ใหม่, `"use server"`) เป็นแค่ adapter ระหว่าง Next กับ module:

```ts
export async function requestEmailCodeAction(email: string, language: "th" | "en") {
  return identity().requestCode(email, await currentClientId());
}
export async function verifyEmailCodeAction(email: string, code: string) {
  const result = await identity().verifyCode(email, code, await currentClientId());
  if (result.ok) (await cookies()).set(PARTICIPANT_COOKIE, result.sessionToken, {
    httpOnly: true, secure: true, sameSite: "lax", path: "/living-lab", maxAge: result.maxAgeSeconds
  });
  return result.ok ? { ok: true, email: maskEmail(result.participant.email) } : result;
}
export async function signOutParticipantAction() { /* delete cookie */ }
```

> cookie ใช้ `path: "/living-lab"` เพื่อจำกัดขอบเขตให้อยู่ในฟีเจอร์เสริมเท่านั้นจริงๆ

**`createPassportAction`** (แก้ไม่กี่บรรทัด): อ่าน participant จาก cookie
→ ถ้าไม่มีให้คืน `{ ok: false, error: "identity_required" }` → ถ้ามีใส่ `participantId` ตอน create

**`lib/hri/identity-emailjs.ts`** (adapter production):

```ts
export const emailJsMailer = (env = process.env): OtpMailer => ({
  async send({ toEmail, code, expiresInMinutes, language }) {
    const res = await fetch("https://api.emailjs.com/api/v1.0/email/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        service_id: env.EMAILJS_SERVICE_ID,
        template_id: language === "th" ? env.EMAILJS_TEMPLATE_ID_TH : env.EMAILJS_TEMPLATE_ID_EN,
        user_id: env.EMAILJS_PUBLIC_KEY,
        accessToken: env.EMAILJS_PRIVATE_KEY,
        template_params: { to_email: toEmail, passcode: code, expires_minutes: expiresInMinutes }
      }),
      signal: AbortSignal.timeout(8000)
    });
    if (!res.ok) throw new Error(`EmailJS ${res.status}`); // module turns this into "send_failed"
  }
});
```

**Env ใหม่** (ไม่มี `NEXT_PUBLIC_` เลย = ไม่หลุดไป browser):
`EMAILJS_SERVICE_ID`, `EMAILJS_TEMPLATE_ID_TH`, `EMAILJS_TEMPLATE_ID_EN`, `EMAILJS_PUBLIC_KEY`,
`EMAILJS_PRIVATE_KEY`, `HRI_IDENTITY_SECRET` (สร้างด้วย `openssl rand -base64 32`)

**EmailJS template:** ช่อง *To Email* = `{{to_email}}`, เนื้อหาใช้ `{{passcode}}` และ `{{expires_minutes}}`
ห้ามใส่ลิงก์ที่มีรหัสใน URL

---

## 8. UX flow ใน `/living-lab`

```
intro
 ├─ [1] อีเมล ─► "ส่งรหัส" ─► [2] ช่องรหัส 6 หลัก (+ ส่งใหม่ได้ใน 60 วิ, เปลี่ยนอีเมล)
 │                              └─ ผ่าน ─► ✓ "บันทึกในชื่อ wu•••@gmail.com · ไม่ใช่คุณ?"
 ├─ [3] ☐ consent (ของเดิม, ข้อความเพิ่มเรื่องเก็บอีเมล)
 └─ Start / Camera / Auto  ← disabled จนกว่า [2] และ [3] ผ่าน
... calibration เดิมทั้งหมด ...
done ─► passport ผูกกับ participant แล้ว (edit key ยังแสดงเหมือนเดิม)
```

- ถ้ามี cookie อยู่แล้ว ข้ามขั้น [1]-[2] แสดงเฉพาะแถบ ✓
- ข้อความ TH/EN ใส่ใน `app/living-lab/copy.ts` ตามเดิม
- แสดงอีเมลแบบ mask เสมอ ห้ามแสดงอีเมลเต็มบนหน้าจอที่ใช้ร่วมกัน (เช่น จอโรงพยาบาลจำลอง)

---

## 9. Privacy (PDPA) และสิ่งที่ห้ามเปลี่ยน

- Robot API (`/api/hri/passport/[token]`) และ public card **ห้าม**ส่งอีเมลหรือ `participantId` เด็ดขาด
  เพิ่ม test ใน `test/hri-api.test.ts` ยืนยันข้อนี้
- `minimiseSummary` เพิ่ม `email` ใน `SENSITIVE_SUMMARY_KEYS` กันหลุดเข้า session log
- ข้อความ consent ต้องบอก: เก็บอีเมลเพื่อระบุเจ้าของข้อมูล, ไม่ใช้ส่งการตลาด, ลบได้
- ห้าม log อีเมลหรือรหัสลง console/Vercel logs (log แค่ `hash(email)` ถ้าจำเป็น)
- ห้ามแตะ production DB จนกว่าจะได้รับอนุมัติ (ตาม `docs/HANDOFF-HRI-PASSPORT.md` §1)

---

## 10. การทดสอบ: interface คือพื้นผิวการทดสอบ

**Unit (`test/hri-identity.test.ts`)** ทั้งหมดผ่าน `createIdentity(...)` ด้วย `memoryMailer` + in-memory store + fake clock:

1. `requestCode` → `memoryMailer` ได้รหัส 6 หลัก, store เก็บแค่ hash (ไม่มีรหัสดิบ)
2. รหัสถูก → ได้ participant + session token; `readSession(token)` คืน participant เดิม
3. รหัสเดิมใช้ซ้ำ → `wrong_code`/`expired` (single-use)
4. ผิด 5 ครั้ง → `too_many_attempts` แม้ครั้งที่ 6 จะถูก
5. fake clock +11 นาที → `expired`
6. ขอรหัสใหม่ → รหัสเก่าใช้ไม่ได้
7. `" Wu@Gmail.com "` กับ `"wu@gmail.com"` คือ participant เดียวกัน
8. อีเมลใหม่กับอีเมลเก่าได้ response รูปเดียวกัน (no enumeration)
9. mailer throw → `send_failed` และไม่มี challenge ที่ใช้ได้ค้าง
10. token ถูกแก้ 1 ตัวอักษร / หมดอายุ / `sessionVersion` ถูก bump → `readSession` = `null`

**Integration (`tests-node/hri-identity.spec.ts`, Playwright, ต้อง `NEON_BRANCH=dev`)**:
seed challenge ที่รู้รหัสลง DB โดยตรง (ไม่ส่งอีเมลจริง) → verify ผ่าน UI → สร้าง passport
→ ตรวจ `participantId` ใน DB → ตรวจ robot API ไม่มีอีเมล → ลบแถวที่ seed เอง

ตาม "replace, don't layer": ไม่ต้องเขียน test แยกให้ helper ภายใน (hash, normalize) ทดสอบผ่าน interface พอ

---

## 11. แผนทำทีละเฟส (ตามกฎ "ทีละเฟส แล้วรอ")

| เฟส | งาน | ไฟล์หลัก |
|---|---|---|
| I-1 | module + unit tests (ยังไม่แตะ UI/DB จริง) | `lib/hri/identity.ts`, `lib/hri/identity-emailjs.ts`, `test/hri-identity.test.ts` |
| I-2 | migration additive บน `dev` + Prisma store adapter | `prisma/schema.prisma`, `prisma/migrations/2026xxxx_hri_identity/` |
| I-3 | server actions + cookie + `createPassportAction` ผูก participant | `app/living-lab/identity-actions.ts`, `app/living-lab/actions.ts` |
| I-4 | UI ขั้นอีเมล/OTP + copy TH/EN + integration test | `LivingLabClient.tsx`, `copy.ts`, `tests-node/hri-identity.spec.ts` |
| I-5 (ทางเลือก) | หน้า "Passport ของฉัน" `/living-lab/me`, ใช้ session แทน edit key ใน owner gate, claim passport เก่าด้วย edit key | `app/living-lab/me/`, `ownedPassport()` |

---

## 12. ข้อตัดสินใจ (ตกลงแล้ว 2026-11-07)

| # | เรื่อง | ตัดสินใจ | ผลต่อการ implement |
|---|---|---|---|
| 1 | บังคับยืนยันอีเมลไหม | **บังคับ** สำหรับ passport ใหม่ทุกใบ (ทีมอนุมัติแล้ว) มี flag `HRI_IDENTITY_REQUIRED=false` เป็นทางถอยวันงานเท่านั้น (เพิ่มตามเช็กลิสต์ก่อน merge ข้อ 5) | ปุ่ม Start / Camera / Auto ใช้ไม่ได้จนกว่าจะยืนยันอีเมลและติ๊ก consent; `createPassportAction` คืน `{ ok: false, error: "identity_required" }` ถ้าไม่มี session |
| 2 | โควตา EmailJS | **แผนฟรีไปก่อน** เอาแค่ใช้งานได้ | dev และ test ใช้ `memoryMailer` เท่านั้น ไม่เผาโควตาจริง; `send_failed` ต้องแสดงข้อความที่บอกผู้ใช้ชัดว่าส่งอีเมลไม่ได้ ให้ลองใหม่ภายหลัง |
| 3 | ลบ participant แล้ว passport เป็นอย่างไร | **passport ยังอยู่ แต่ไม่ผูกกับใคร** (`onDelete: SetNull`) | ไม่ต้องเขียนขั้นตอนลบเพิ่ม; ปุ่มลบ passport เดิม (hard delete) ยังใช้ได้ตามปกติ |
| 4 | อายุ session | **14 วัน** | cookie `maxAge` และวันหมดอายุใน token = 14 วัน; แสดงแถบ "✓ บันทึกในชื่อ … · ไม่ใช่คุณ?" ทุกครั้ง |

**ความเสี่ยงที่ยอมรับไว้ (ไม่ใช่งานที่ต้องทำตอนนี้):**

- ข้อ 1 + 2: เมื่อบังคับยืนยันแล้วใช้แผนฟรี ถ้าโควตาหมดหรือ EmailJS ล่ม จะไม่มีใครสร้าง passport ใหม่ได้
  **ทางถอยวันงาน:** ตั้ง `HRI_IDENTITY_REQUIRED=false` บน Vercel แล้ว redeploy → เริ่มได้โดยไม่ยืนยัน
  (คนที่ยืนยันแล้วยังผูกเจ้าของตามปกติ ส่วน passport ของคนที่ไม่ยืนยันจะไม่มีเจ้าของ) จบงานแล้วลบ flag ออกแล้ว redeploy
  ทางแก้ระยะยาว: อัปเกรดแผน หรือเพิ่ม adapter ตัวอื่นที่ seam `OtpMailer`
- ข้อ 3: หลังลบ participant passport ยังเก็บ `nickname` และ `anxiety` อยู่ ซึ่งอาจโยงกลับถึงตัวบุคคลได้
  ข้อความ consent ต้องบอกตามจริงว่าการลบบัญชีไม่ได้ลบ passport และผู้ใช้ลบ passport เองได้จากหน้าการ์ด
- ข้อ 4: บนเครื่องที่ใช้ร่วมกันในงาน คนถัดไปอาจสร้าง passport ในชื่อคนก่อนได้ถ้าไม่กด "ไม่ใช่คุณ?"

---

## 13. สถานะการ implement (2026-11-08)

| ส่วน | ไฟล์ |
|---|---|
| Module (deep) | `lib/hri/identity.ts`: `createIdentity(deps)` → `requestCode` / `verifyCode` / `readSession` |
| Adapter EmailJS | `lib/hri/identity-emailjs.ts` (server-only, ใช้ private key) |
| Adapter Postgres | `lib/hri/identity-store.ts` |
| Wiring + cookie | `lib/hri/identity-server.ts` (`hri_participant`, path `/living-lab`, 14 วัน) |
| Server actions | `app/living-lab/identity-actions.ts` |
| UI | `app/living-lab/IdentityCard.tsx` + `identity-copy.ts` (การ์ดใต้แผง How it works) |
| ผูก passport | `createPassportAction` ต้องมี participant ไม่งั้นคืน `{ ok: false, error: "identity_required" }` |
| Schema + migration | `prisma/migrations/20261108000000_hri_living_lab_identity/` (additive) |
| Tests | `test/hri-identity.test.ts` (14 ข้อ); Playwright (`hri-e2e`, `hri-auto-mode`, `hri-voice-flow`) ใช้ `tests-node/identity-helper.ts` sign in โดยไม่ส่งอีเมลจริง |

**ยังไม่ได้ทำ / ต้องทำก่อนใช้งานจริง:**
1. Apply migration ลง Neon `dev` แล้วรัน Playwright specs (`hri-e2e`, `hri-auto-mode`, `hri-voice-flow`) ด้วย `NEON_BRANCH=dev`
   (`hri-voice-flow` เคยรันได้โดยไม่มี database ตอนนี้ต้องใช้ `dev` เพราะต้อง sign in ก่อนเริ่ม)
2. ตั้ง env บน Vercel: `HRI_IDENTITY_SECRET` และ `EMAILJS_*` (ดู `.env.example`)
3. สร้าง template ใน EmailJS (TH/EN) และเปิด "Allow EmailJS API for non-browser applications"
4. Migration ลง production ต้องได้รับอนุมัติก่อน (ถ้า deploy โค้ดก่อน migrate หน้า Living Lab จะสร้าง passport ไม่ได้)

**Local dev ไม่มี EmailJS keys:** รหัสจะพิมพ์ใน terminal ของ server (`[living-lab identity] ... Code for ...`) ใช้เฉพาะ `NODE_ENV !== "production"`
