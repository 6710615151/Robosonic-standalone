// The robot console speaking a passport, in a real browser. The API response is stubbed with a real
// public profile, so this needs no database and saves nothing. What it records is the text and rate
// handed to the browser's speech engine: how it sounds still needs a person on the demo machine.
//
//   pnpm build && pnpm start &
//   PLAYWRIGHT_EXTERNAL_SERVER=1 pnpm exec playwright test tests-node/hri-spoken-summary.spec.ts
import { test, expect, type Page } from "@playwright/test";
import { toPublicProfile, type PassportProfileSource } from "../lib/hri/public-profile";

test.use({ viewport: { width: 1440, height: 1000 } });
test.describe.configure({ timeout: 90_000 });

const TOKEN = "a".repeat(43);

async function readPassport(page: Page, overrides: Partial<PassportProfileSource>) {
  const source: PassportProfileSource = {
    comfortDistance: -1.3, speed: 1, gaze: "soft", language: "th", speechPace: "slow", greeting: "wai",
    voice: true, captions: "large", noReach: true, anxiety: "high", status: "active", version: 1,
    updatedAt: new Date("2026-11-07T00:00:00Z"), expiresAt: null,
    ...overrides
  };
  await page.addInitScript(() => {
    const spoken: { text: string; rate: number; lang: string }[] = [];
    (window as unknown as { __spoken: typeof spoken }).__spoken = spoken;
    window.speechSynthesis.speak = (u: SpeechSynthesisUtterance) => { spoken.push({ text: u.text, rate: u.rate, lang: u.lang }); };
  });
  await page.route("**/api/hri/passport/**", (route) => route.fulfill({ json: toPublicProfile(source) }));
  await page.goto("/living-lab/robot");
  await expect(page.locator("canvas")).toHaveCount(3, { timeout: 45_000 });
  await page.getByLabel("Passport access token").fill(TOKEN);
  await page.getByRole("button", { name: "Read passport" }).click();
  await expect(page.getByTestId("robot-card-a")).toContainText("Passport v1");
}

const spoken = (page: Page) =>
  page.evaluate(() => (window as unknown as { __spoken: { text: string; rate: number; lang: string }[] }).__spoken);

test("two robots describe the same passport differently, and speak what the caption shows", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await readPassport(page, {});

  const captionA = page.getByTestId("robot-speech-a");
  const captionB = page.getByTestId("robot-speech-b");
  await expect(captionA).toContainText("ผมจะยืนห่าง ๆ จะเคลื่อนที่ช้า ๆ พูดช้าลง จะไม่จ้องตาคุณ");
  await expect(captionA).toHaveAttribute("lang", "th");
  await expect(captionB).toContainText("ผมเป็นหุ่นแบบติดที่");
  await expect(captionB).toContainText("เท่าที่ผมทำได้ครับ");
  await expect(captionB).not.toContainText("ยืนห่าง");

  const textA = await captionA.innerText();
  await page.getByTestId("robot-card-a").getByRole("button", { name: "Speak care summary" }).click();
  const textB = await captionB.innerText();
  await page.getByTestId("robot-card-b").getByRole("button", { name: "Speak care summary" }).click();
  const said = await spoken(page);
  expect(said.map((s) => s.text)).toEqual([textA, textB]);
  expect(said[0].lang).toBe("th-TH");
  expect(said[0].rate).toBeCloseTo(0.85);

  // Nothing about the person's feelings or identity appears in the speech or on the page.
  for (const text of [textA, textB]) expect(text).not.toMatch(/กังวล|anxi|nervous/i);
  expect(errors).toEqual([]);
});

test("the default robot only says hello, at the normal speed", async ({ page }) => {
  await readPassport(page, {});
  await expect(page.getByTestId("robot-speech-default")).toHaveText("สวัสดีครับ!");
  await page.getByTestId("robot-card-default").getByRole("button", { name: "Speak care summary" }).click();
  const said = await spoken(page);
  expect(said[0].text).toBe("สวัสดีครับ!");
  expect(said[0].rate).toBe(1);
});

test("a text-only passport has no speak button, but the caption stays, in large text if asked", async ({ page }) => {
  await readPassport(page, { voice: false });
  const a = page.getByTestId("robot-card-a");
  await expect(a.getByRole("button", { name: "Speak care summary" })).toHaveCount(0);
  await expect(page.getByTestId("robot-speech-a")).toContainText("ผมจะยืนห่าง ๆ");
  await expect(page.getByTestId("robot-speech-a")).toHaveClass(/speechLarge/);
});

test("the summary follows the passport's language, not the page's", async ({ page }) => {
  await readPassport(page, { language: "en", captions: "normal" });
  await expect(page.getByTestId("robot-speech-a")).toContainText("Hello. I'll keep a wide distance");
  await expect(page.getByTestId("robot-speech-a")).toHaveAttribute("lang", "en");
  await expect(page.getByTestId("robot-speech-a")).not.toHaveClass(/speechLarge/);
});
