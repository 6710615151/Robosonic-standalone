import type { Lang } from "./copy";

export const identityCopy: Record<Lang, {
  title: string;
  why: string;
  optional: string;
  emailLabel: string;
  emailPlaceholder: string;
  send: string;
  sending: string;
  codeLabel: string;
  codeSentTo: (email: string) => string;
  verify: string;
  verifying: string;
  resend: string;
  resendIn: (s: number) => string;
  changeEmail: string;
  signedInAs: string;
  notYou: string;
  locked: string;
  required: string;
  savedUnder: (email: string) => string;
  privacy: string;
  errors: Record<"invalid_email" | "rate_limited" | "send_failed" | "wrong_code" | "expired" | "too_many_attempts" | "unavailable" | "identity_required", string>;
  waitSeconds: (s: number) => string;
}> = {
  en: {
    title: "Who is this passport for?",
    why: "Verify your email so your passport and comfort ratings are saved as yours, and you can find them again on any device.",
    optional: "Optional today: you can start without it. Verify your email if you want this passport saved as yours.",
    emailLabel: "Email",
    emailPlaceholder: "you@example.com",
    send: "Send code",
    sending: "Sending…",
    codeLabel: "6-digit code",
    codeSentTo: (email) => `We sent a code to ${email}. It works for 10 minutes. Check your spam folder if it is not there.`,
    verify: "Verify",
    verifying: "Checking…",
    resend: "Send a new code",
    resendIn: (s) => `New code in ${s} s`,
    changeEmail: "Use another email",
    signedInAs: "Saving as",
    notYou: "Not you?",
    locked: "You can switch person after this session.",
    required: "Verify your email below before the robot starts.",
    savedUnder: (email) => `Saved to ${email}`,
    privacy: "Your email only identifies who owns this data. Robots never see it, and we never send marketing.",
    errors: {
      invalid_email: "Please enter a valid email address.",
      rate_limited: "Too many tries. Please wait a moment and try again.",
      send_failed: "We could not send the email right now. Please try again in a minute.",
      wrong_code: "That code is not right. Please check the email and try again.",
      expired: "This code has expired or was already used. Send a new code.",
      too_many_attempts: "Too many wrong codes. Send a new code.",
      unavailable: "Email verification is not available right now. Please ask the Living Lab team.",
      identity_required: "Please verify your email before saving your passport."
    },
    waitSeconds: (s) => `(wait ${s} s)`
  },
  th: {
    title: "Passport นี้เป็นของใคร",
    why: "ยืนยันอีเมลเพื่อให้ passport และคะแนนความสบายใจถูกบันทึกเป็นของคุณ และกลับมาดูได้จากทุกอุปกรณ์",
    optional: "วันนี้ไม่บังคับ เริ่มได้เลยโดยไม่ต้องยืนยัน ถ้าต้องการให้ passport นี้เป็นของคุณ ให้ยืนยันอีเมล",
    emailLabel: "อีเมล",
    emailPlaceholder: "you@example.com",
    send: "ส่งรหัส",
    sending: "กำลังส่ง…",
    codeLabel: "รหัส 6 หลัก",
    codeSentTo: (email) => `ส่งรหัสไปที่ ${email} แล้ว ใช้ได้ 10 นาที ถ้าไม่เจอให้ดูในโฟลเดอร์สแปม`,
    verify: "ยืนยัน",
    verifying: "กำลังตรวจ…",
    resend: "ส่งรหัสใหม่",
    resendIn: (s) => `ส่งใหม่ได้ใน ${s} วิ`,
    changeEmail: "ใช้อีเมลอื่น",
    signedInAs: "บันทึกในชื่อ",
    notYou: "ไม่ใช่คุณ?",
    locked: "เปลี่ยนคนได้หลังจบรอบนี้",
    required: "ยืนยันอีเมลด้านล่างก่อนเริ่ม",
    savedUnder: (email) => `บันทึกเป็นของ ${email}`,
    privacy: "อีเมลใช้ระบุเจ้าของข้อมูลเท่านั้น หุ่นยนต์มองไม่เห็นอีเมลของคุณ และเราไม่ส่งโฆษณา",
    errors: {
      invalid_email: "กรุณากรอกอีเมลให้ถูกต้อง",
      rate_limited: "ลองบ่อยเกินไป กรุณารอสักครู่แล้วลองใหม่",
      send_failed: "ส่งอีเมลไม่สำเร็จในตอนนี้ กรุณาลองใหม่อีกครั้งในอีกสักครู่",
      wrong_code: "รหัสไม่ถูกต้อง กรุณาตรวจอีเมลแล้วลองใหม่",
      expired: "รหัสหมดอายุหรือถูกใช้ไปแล้ว กรุณาขอรหัสใหม่",
      too_many_attempts: "ใส่รหัสผิดหลายครั้งเกินไป กรุณาขอรหัสใหม่",
      unavailable: "ระบบยืนยันอีเมลใช้งานไม่ได้ในขณะนี้ กรุณาติดต่อทีม Living Lab",
      identity_required: "กรุณายืนยันอีเมลก่อนบันทึก passport"
    },
    waitSeconds: (s) => `(รอ ${s} วิ)`
  }
};
