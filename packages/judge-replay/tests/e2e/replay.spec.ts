import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";

const screenshotDir = process.env.QA_SCREENSHOT_DIR ?? "";
if (screenshotDir) {
  mkdirSync(screenshotDir, { recursive: true });
}

test.describe("Vervain Judge Replay Browser E2E, Accessibility & Responsive Gates", () => {
  let browserErrors: string[] = [];

  test.beforeEach(async ({ page }) => {
    browserErrors = [];
    page.on("pageerror", (err) => {
      browserErrors.push(`pageerror: ${err.message}`);
    });
    page.on("console", (msg) => {
      if (msg.type() === "error" || msg.type() === "warning") {
        browserErrors.push(`console.${msg.type()}: ${msg.text()}`);
      }
    });
  });

  test.afterEach(async () => {
    expect(browserErrors).toEqual([]);
  });

  test("renders desktop 1440px & 1920px presentation views, toggles Native/Vervain, opens receipt, and passes WCAG AA contrast", async ({
    page
  }) => {
    await page.setViewportSize({ width: 1440, height: 980 });
    await page.goto("/");

    await expect(page.getByTestId("source-status-badge")).toContainText("LOCAL TEST");
    await expect(page.getByTestId("no-gpu-badge")).toContainText("NO GPU RUN RECORDED");
    await expect(page.getByTestId("aperture-mismatch-cut")).toBeVisible();

    if (screenshotDir) {
      await page.screenshot({
        path: resolve(screenshotDir, "01-desktop-1440-vervain-poster.png"),
        fullPage: true,
        animations: "disabled"
      });
    }

    // Verify computed WCAG AA contrast (>= 4.5:1) across key text elements
    const contrastReport = await page.evaluate(() => {
      function parseRgb(str: string): [number, number, number, number] {
        const m = str.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
        if (!m) return [0, 0, 0, 1];
        return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] !== undefined ? Number(m[4]) : 1];
      }
      function luminance([r, g, b]: [number, number, number]): number {
        const chan = [r, g, b].map((v) => {
          const s = v / 255;
          return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
        });
        return 0.2126 * chan[0]! + 0.7152 * chan[1]! + 0.0722 * chan[2]!;
      }
      function effectiveBg(el: Element | null): [number, number, number] {
        let cur: Element | null = el;
        while (cur) {
          const bg = getComputedStyle(cur).backgroundColor;
          const [r, g, b, a] = parseRgb(bg);
          if (a >= 0.95) return [r, g, b];
          cur = cur.parentElement;
        }
        return [11, 11, 14];
      }
      function ratio(fg: [number, number, number], bg: [number, number, number]): number {
        const l1 = luminance(fg);
        const l2 = luminance(bg);
        return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
      }

      const selectors = [
        ".vr-primary-heading",
        ".vr-technical-line",
        ".vr-outcome-line",
        ".vr-limit-line",
        "[data-testid='source-status-badge']",
        "[data-testid='no-gpu-badge']",
        ".vr-active-step-text",
        ".vr-meta-key"
      ];

      return selectors.map((sel) => {
        const el = document.querySelector(sel);
        if (!el) return { sel, cr: 0, fontSizePx: 0 };
        const style = getComputedStyle(el);
        const [r, g, b] = parseRgb(style.color);
        const bg = effectiveBg(el);
        return {
          sel,
          cr: Number(ratio([r, g, b], bg).toFixed(2)),
          fontSizePx: parseFloat(style.fontSize)
        };
      });
    });

    for (const entry of contrastReport) {
      expect(entry.cr, `Contrast failed for ${entry.sel}`).toBeGreaterThanOrEqual(4.5);
    }

    // Limitations font size must NOT be tiny text (>= 14px)
    const limitEntry = contrastReport.find((c) => c.sel === ".vr-limit-line");
    expect(limitEntry?.fontSizePx ?? 0).toBeGreaterThanOrEqual(14);

    // Switch to Native only and capture screenshot
    await page.getByTestId("mode-native-only-btn").click();
    await expect(page.getByTestId("foreign-path-unmediated-segment")).toBeVisible();
    if (screenshotDir) {
      await page.screenshot({
        path: resolve(screenshotDir, "02-desktop-1440-native-baseline.png"),
        fullPage: true,
        animations: "disabled"
      });
    }

    // Switch back to Vervain and open exact receipt drawer
    await page.getByTestId("mode-vervain-btn").click();
    await page.getByTestId("open-exact-receipt-btn").click();
    await expect(page.getByTestId("receipt-drawer")).toBeVisible();
    if (screenshotDir) {
      await page.screenshot({
        path: resolve(screenshotDir, "03-desktop-1440-receipt-drawer.png")
      });
    }
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("receipt-drawer")).toBeHidden();

    // Check 1920x1080 large presentation viewport
    await page.setViewportSize({ width: 1920, height: 1080 });
    const wideOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth
    );
    expect(wideOverflow).toBe(true);
  });

  test("operates cleanly at 360px narrow screen width with zero horizontal overflow", async ({
    page
  }) => {
    await page.setViewportSize({ width: 360, height: 840 });
    await page.goto("/");

    const overflowCheck = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth
    }));
    expect(overflowCheck.scrollWidth).toBeLessThanOrEqual(overflowCheck.innerWidth);

    await expect(page.getByTestId("control-demo-btn")).toBeVisible();
    await expect(page.getByTestId("open-exact-receipt-btn")).toBeVisible();

    if (screenshotDir) {
      await page.screenshot({
        path: resolve(screenshotDir, "04-mobile-360-vervain.png"),
        fullPage: true
      });
    }
  });

  test("respects prefers-reduced-motion: reduce and full keyboard focus restoration", async ({
    page
  }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/");

    const carrierTransition = await page
      .getByTestId("alder-lineage-carrier")
      .evaluate((el) => getComputedStyle(el).transitionDuration);
    expect(carrierTransition).toBe("0s");

    // Keyboard timeline scrubbing
    const step7 = page.getByTestId("timeline-step-7");
    await step7.focus();
    await page.keyboard.press("ArrowLeft");
    await expect(page.getByTestId("timeline-step-6")).toBeFocused();
    await expect(page.getByTestId("active-step-detail")).toContainText("Step 6 (scope checked)");

    // Keyboard open receipt and Escape focus restoration
    const receiptBtn = page.getByTestId("open-exact-receipt-btn");
    await receiptBtn.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("receipt-drawer")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("receipt-drawer")).toBeHidden();
    await expect(receiptBtn).toBeFocused();
  });

  test("handles safe deep-link aliases, rejects unsafe query parameters, and renders verifier-failed/incomplete/unsupported states", async ({
    page
  }) => {
    await page.setViewportSize({ width: 1440, height: 960 });

    await page.goto("/?run=verifier-failed");
    await expect(page.getByTestId("state-verifier-failed")).toBeVisible();
    await expect(page.getByTestId("outcome-claim-line")).toHaveCount(0);
    await expect(page.getByTestId("outcome-withheld-line")).toBeVisible();
    if (screenshotDir) {
      await page.screenshot({
        path: resolve(screenshotDir, "05-desktop-1440-verifier-failed.png"),
        fullPage: true,
        animations: "disabled"
      });
    }

    await page.goto("/?run=awaiting-h200");
    await expect(page.getByTestId("state-incomplete")).toBeVisible();
    await expect(page.getByTestId("source-status-badge")).toContainText("INCOMPLETE");

    await page.goto("/?run=unsupported-backend");
    await expect(page.getByTestId("state-unsupported")).toBeVisible();
    await expect(page.getByTestId("source-status-badge")).toContainText("UNSUPPORTED");

    // Unsafe query parameters are rejected and fallback to default run cleanly
    await page.goto("/?run=https://attacker.invalid/x.json&tenant=alder&prompt=override");
    await expect(page.getByTestId("rejected-deeplink-notice")).toContainText("tenant");
    await expect(page.getByTestId("source-status-badge")).toContainText("LOCAL TEST");
  });
});
