// Integration tests for the robot console (/living-lab/robot): one real passport, two different
// robots, a default behaviour column and the public JSON. Writes test passports, so it refuses to
// run unless NEON_BRANCH=dev. It cleans up after itself.
//
//   set -a && source ./.env.local && set +a
//   pnpm build && pnpm start &            # or next start
//   PLAYWRIGHT_EXTERNAL_SERVER=1 pnpm exec playwright test tests-node/hri-robot-console.spec.ts
import { randomBytes, randomUUID } from "node:crypto";
import { test, expect } from "@playwright/test";
import pg from "pg";
import { issuePassportTokens } from "../lib/hri/security";

test.skip(process.env.NEON_BRANCH !== "dev", "Writes test data: only runs when NEON_BRANCH=dev.");
test.describe.configure({ mode: "serial" });

// Plain pg instead of the Prisma client: Playwright's ESM loader cannot import generated/prisma.
const db = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
const created: string[] = [];

// Every test calls from its own fake client IP so rate-limit windows never leak between tests.
const randomIp = () => `203.0.113.${Math.floor(Math.random() * 250) + 1}-${Date.now()}-${Math.random()}`;

async function seed(nickname = "integration-test") {
  const tokens = issuePassportTokens();
  const id = `itest_${randomUUID()}`;
  // Test codes start with "1", which real codes never contain.
  const code = `1${randomUUID().replace(/-/g, "").slice(0, 5).toUpperCase()}`;
  await db.query(
    `INSERT INTO "HriPassport" ("id","code","nickname","accessTokenHash","editTokenHash","comfortDistance","speed",
       "gaze","voice","language","anxiety","captions","speechPace","noReach","status","updatedAt")
     VALUES ($1,$2,$3,$4,$5,-1.3,1,'soft',true,'th','high','large','slow',false,'active', now() AT TIME ZONE 'UTC')`,
    [id, code, nickname, tokens.accessTokenHash, tokens.editTokenHash]
  );
  created.push(id);
  return { id, code, accessToken: tokens.accessToken, editToken: tokens.editToken };
}

async function waitForRobots(page: import("@playwright/test").Page) {
  await expect(page.locator("canvas")).toHaveCount(3, { timeout: 45000 });
}

test.afterAll(async () => {
  await db.query(`DELETE FROM "HriPassport" WHERE "id" = ANY($1::text[])`, [created]);
  await db.end();
});

test("one passport becomes two different plans, plus the default", async ({ browser }) => {
  // Three WebGL robots render in this page; under parallel test load this can exceed the 30 s default.
  test.setTimeout(60_000);
  const row = await seed();
  const context = await browser.newContext({
    extraHTTPHeaders: { "x-forwarded-for": randomIp() },
    viewport: { width: 1440, height: 1000 }
  });
  const page = await context.newPage();
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await page.goto("/living-lab/robot");
  await waitForRobots(page);
  // The token the visitor has not typed yet must never be in the server-rendered page.
  const initialHtml = await page.content();

  // Before a passport, the two real robots are idle and only the default column behaves.
  await expect(page.getByTestId("robot-card-a")).toContainText("No passport loaded yet");
  await expect(page.getByTestId("robot-card-default")).toContainText("close");
  await expect(page.getByTestId("robot-card-default")).toContainText("fast");
  await expect(page.getByTestId("robot-card-default")).toContainText("wave");

  await page.getByLabel("Passport access token").fill(row.accessToken);
  await page.getByRole("button", { name: "Read passport" }).click();
  await expect(page.getByTestId("robot-card-a")).toContainText("Passport v1");

  // Robot A: everything applies, including the anxiety-driven slow speed and calm demeanour.
  const a = page.getByTestId("robot-card-a");
  await expect(a).toContainText("far");
  await expect(a).toContainText("slow");
  await expect(a).toContainText("soft");
  await expect(a).toContainText("wai + bow");
  await expect(a).toContainText("hands it to you");
  await expect(a).toContainText("large");
  await expect(a).toContainText("calm");
  await expect(a).toContainText("Thai");
  await expect(a).toContainText("No compromises needed.");
  await expect(page.getByTestId("robot-speech-a")).toContainText("ผมจะยืนห่าง ๆ");
  await expect(page.getByTestId("robot-speech-a")).toContainText("จะบอกคุณก่อนทุกครั้งที่จะขยับ");
  await expect(page.getByTestId("robot-speech-a")).not.toContainText("กังวล");

  // Robot B: the same passport within a fixed base with no head and no arms.
  const b = page.getByTestId("robot-card-b");
  await expect(b).toContainText("fixed base");
  await expect(b).toContainText("stationary");
  await expect(b).toContainText("not available");
  await expect(b).toContainText("no gesture");
  await expect(b).toContainText("places it nearby");
  await expect(b).toContainText("cannot change distance");
  await expect(b).toContainText("No arms");
  await expect(page.getByTestId("robot-speech-b")).toContainText("ผมเป็นหุ่นแบบติดที่");
  await expect(page.getByTestId("robot-speech-b")).not.toContainText("ยืนห่าง");

  // The JSON is the public profile: no anxiety, code, nickname or token.
  await page.locator("details summary").click();
  const json = page.getByTestId("console-json");
  await expect(json).toContainText('"sceneUnits": -1.3');
  await expect(json).toContainText('"demeanor": "calm"');
  await expect(json).not.toContainText("anxiety");

  const visible = await page.locator("main").nth(1).innerText();
  expect(visible).not.toContain("integration-test");
  expect(visible).not.toContain(row.code);
  expect(initialHtml).not.toContain(row.accessToken);
  expect(initialHtml).not.toContain(row.code);
  expect(initialHtml).not.toContain("integration-test");
  expect(page.url()).not.toContain(row.accessToken);
  expect(pageErrors).toEqual([]);

  await context.close();
});

test("an unknown token shows a friendly error and never renders a profile", async ({ browser }) => {
  const context = await browser.newContext({ extraHTTPHeaders: { "x-forwarded-for": randomIp() } });
  const page = await context.newPage();
  await page.goto("/living-lab/robot");
  await waitForRobots(page);

  await page.getByLabel("Passport access token").fill(randomBytes(32).toString("base64url"));
  await page.getByRole("button", { name: "Read passport" }).click();
  await expect(page.getByTestId("console-error")).toContainText("No passport matches this token");
  await expect(page.getByTestId("console-json")).toHaveCount(0);
  await expect(page.getByTestId("robot-card-a")).toContainText("No passport loaded yet");

  await context.close();
});

test("the console has no horizontal overflow at phone width", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 900 } });
  const page = await context.newPage();
  await page.goto("/living-lab/robot");
  await waitForRobots(page);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  );
  expect(overflow).toBe(0);
  await context.close();
});
