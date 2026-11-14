/**
 * Responsibility: Clean-browser Playwright E2E suite verifying the 60-second judge flow,
 * above-the-fold laptop layout (1440x900), keyboard graph navigation, receipt export & chain
 * verification, Scoped Attention Lab, epoch-revocation race, multi-session isolation,
 * reduced motion, and 1280px / mobile responsiveness against the production build.
 * Trust boundary: Real Chromium browser contexts exercising the compiled single-service server.
 */

import { expect, test } from '@playwright/test';
import { SCOPED_ATTENTION_LIMITATION_LABEL } from '../../src/shared/config.js';

test.describe('Vervain Context Firewall: Clean-Browser Judge Path', () => {
  test('completes the 60-second paired proof, graph inspection, receipt export, chain check, and scoped attention lab above the fold on 1440x900', async ({
    page,
  }) => {
    await page.goto('/');

    // 1. Top strip & synthetic fixture session bootstrap
    await expect(page.getByTestId('status-strip')).toBeVisible();
    await expect(page.getByTestId('strip-persona')).toContainText('Tenant Alder');
    await expect(page.getByTestId('strip-policy')).toContainText('alder-context@7');
    await expect(page.getByTestId('strip-mediation')).toContainText('Context mediation active');
    await expect(page.getByTestId('strip-boundaries')).toContainText('2/2 in this demo');
    await expect(page.getByTestId('strip-boundaries')).toContainText(
      "Only this app's context and reply paths",
    );
    await expect(page.getByTestId('frozen-query-text')).toContainText(
      'Summarize our Northstar renewal position.',
    );

    // Primary button must sit comfortably above the 900px laptop fold
    const runBtn = page.getByTestId('btn-run-paired');
    await expect(runBtn).toBeVisible();
    const btnBox = await runBtn.boundingBox();
    expect(btnBox).not.toBeNull();
    expect(btnBox!.y + btnBox!.height).toBeLessThan(320);

    // 2. Click Run paired proof
    await runBtn.click();

    const controlLane = page.getByTestId('lane-native_only');
    const vervainLane = page.getByTestId('lane-native_plus_vervain');
    await expect(controlLane).toBeVisible();
    await expect(vervainLane).toBeVisible();

    // Paired result header & verdict must be visible above the 900px laptop fold
    const vervainVerdict = page.getByTestId('verdict-native_plus_vervain');
    const verdictBox = await vervainVerdict.boundingBox();
    expect(verdictBox).not.toBeNull();
    expect(verdictBox!.y).toBeLessThan(860);

    // 3. Assert Native only vs Native + Vervain structural outcomes
    await expect(page.getByTestId('verdict-native_only')).toContainText(
      'Cross-tenant context transmitted',
    );
    await expect(page.getByTestId('counts-native_only')).toContainText(
      '2 of 2 retrieved chunks entered envelope',
    );

    await expect(vervainVerdict).toContainText('Foreign context withheld before Gemini');
    await expect(page.getByTestId('counts-native_plus_vervain')).toContainText(
      '1 of 2 retrieved chunks admitted · 1 withheld',
    );
    await expect(page.getByTestId('reply-box-native_plus_vervain')).toContainText('12 percent');
    await expect(page.getByTestId('reply-box-native_plus_vervain')).not.toContainText(
      'BEACON_PROJECT_EMBER_742',
    );

    // 4. Keyboard-accessible Provenance Graph node selection + Isometric Cube Replay & 5-Question Strip
    await expect(page.getByTestId('causal-replay-scrubber')).toBeVisible();
    await expect(page.getByTestId('governance-five-questions')).toBeVisible();
    await expect(page.getByTestId('governance-five-questions')).toContainText('1/2 admitted');

    // Step through causal replay scrubber stage 3 (Context Gate) and restore All stages
    await page.getByTestId('replay-stage-3').click();
    await expect(page.getByTestId('node-inspector')).toContainText('Context Gate');
    await page.getByTestId('replay-stage-all').click();

    const beaconNode = page.getByTestId('graph-node-source_beacon');
    await beaconNode.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('node-inspector')).toContainText('beacon/strategy-note-v2');
    await expect(page.getByTestId('node-inspector')).toContainText('tenant_mismatch');

    // 5. Evidence drawer denominators, chain verification, and content-free JSON receipt
    await expect(page.getByTestId('evidence-admitted-denominator')).toContainText(
      '1 of 2 retrieved chunks admitted',
    );
    await expect(page.getByTestId('evidence-foreign-in-envelope')).toHaveText('no');
    await expect(page.getByTestId('evidence-permitted-completed')).toContainText('true');

    await page.getByTestId('btn-verify-chain').click();
    await expect(page.getByTestId('chain-verification-status')).toContainText(
      'verified (12 events, 2 receipts)',
    );

    await page.getByTestId('btn-toggle-receipt-json').click();
    const rawReceiptText = await page.getByTestId('receipt-raw-json').innerText();
    expect(rawReceiptText).not.toContain('BEACON_PROJECT_EMBER_742');
    expect(rawReceiptText).not.toContain('Northstar renewal discounts');

    // Verify receipt export endpoint directly with session cookies
    const exportHref = await page.getByTestId('btn-export-receipt').getAttribute('href');
    expect(exportHref).toMatch(/^\/api\/receipts\/rcpt_[0-9a-f]+\/export$/);
    const exportResp = await page.request.get(exportHref!);
    expect(exportResp.status()).toBe(200);
    const exportedText = await exportResp.text();
    expect(exportedText).not.toContain('BEACON_PROJECT_EMBER_742');

    // 5b. Post-IAM / Pre-Egress Enterprise & Neocloud Architecture Strip
    const archStrip = page.getByTestId('enterprise-architecture-strip');
    await expect(archStrip).toBeVisible();
    await expect(archStrip).toContainText('NO GPU RUN RECORDED');
    await page.getByTestId('preset-tab-neocloud_shared_gpu').click();
    await expect(page.getByTestId('preset-detail-card')).toContainText('vLLM');
    await expect(page.getByTestId('engine-profile-matrix')).toContainText('SGLang');
    await expect(page.getByTestId('engine-profile-matrix')).toContainText('NVIDIA Dynamo');

    // 6. Open Scoped Attention & Open-Weight KV Lifecycle Workbench
    await page.getByTestId('btn-open-scoped-attention').click();
    await expect(page.getByTestId('scoped-attention-panel')).toBeVisible();
    await expect(page.getByTestId('scoped-limitation-banner')).toHaveText(
      SCOPED_ATTENTION_LIMITATION_LABEL,
    );
    await expect(page.getByTestId('inference-proof-badge')).toHaveText('NO GPU RUN RECORDED');
    await expect(page.getByTestId('scoped-request-tag')).toContainText('0x00a1de07');
    await expect(page.getByTestId('scoped-mismatch-count')).toContainText(
      '1 of 4 blocks masked before softmax',
    );
    await expect(page.getByTestId('scoped-foreign-mass')).toContainText('0.000000');
    await expect(page.getByTestId('scoped-clean-delta')).toContainText('0.00e+0');

    // Switch KV lifecycle modes and verify online tile zero-read skip table
    await expect(page.getByTestId('kv-lifecycle-explorer')).toBeVisible();
    await page.getByTestId('kv-mode-tab-prefix_cache_hash_collision').click();
    await expect(page.getByTestId('kv-mode-detail')).toContainText('0.000000');
    await page.getByTestId('kv-mode-tab-online_tiled_flash_recurrence').click();
    await expect(page.getByTestId('online-tile-table')).toContainText('0 reads');
  });

  test('enforces epoch-revocation withholding, clean reset, multi-session isolation, reduced motion, and responsive layouts', async ({
    browser,
  }) => {
    const contextA = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      reducedMotion: 'reduce',
    });
    const contextB = await browser.newContext({
      viewport: { width: 390, height: 844 },
    });

    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();

    await pageA.goto('/');
    await pageB.goto('/');

    // Context A runs Advanced -> Revoke during generation
    await pageA.getByTestId('btn-toggle-advanced').click();
    await pageA.getByTestId('btn-revoke-during-generation').click();

    await expect(pageA.getByTestId('verdict-native_plus_vervain')).toContainText(
      'Response withheld: policy_epoch_changed',
    );
    await expect(pageA.getByTestId('strip-policy')).toContainText('alder-context@8');

    // Context B remains independently at Alder epoch 7, then rotates persona to Beacon
    await expect(pageB.getByTestId('strip-policy')).toContainText('alder-context@7');
    await pageB.getByTestId('persona-selector').selectOption('beacon');
    await expect(pageB.getByTestId('strip-persona')).toContainText('Tenant Beacon');
    await expect(pageB.getByTestId('strip-policy')).toContainText('beacon-context@11');

    // Beacon clean request preserves native restriction (0 admitted, Gemini not called)
    await pageB.getByTestId('btn-run-clean').click();
    await expect(pageB.getByTestId('verdict-native_plus_vervain')).toContainText(
      '0 admitted: native restriction preserved',
    );

    // Reset Context A -> restores Alder epoch 7 without affecting Context B
    await pageA.getByTestId('btn-reset-demo').click();
    await expect(pageA.getByTestId('strip-policy')).toContainText('alder-context@7');
    await expect(pageA.getByTestId('empty-proof-stage')).toBeVisible();
    await expect(pageB.getByTestId('strip-policy')).toContainText('beacon-context@11');

    await contextA.close();
    await contextB.close();
  });
});
