import { chromium } from "playwright";

function parseArgs(argv) {
  const args = {
    baseUrl: "http://127.0.0.1:3000",
    message: "phase b ui interruption probe",
    timeoutSec: 90,
    headless: true,
    rafSampleSec: 2,
    speakingRafSampleSec: 5,
    avatarMode: "",
    provider: "",
    model: "",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index] || "");
    if (token === "--base-url" && argv[index + 1]) {
      args.baseUrl = String(argv[index + 1]);
      index += 1;
      continue;
    }
    if (token === "--message" && argv[index + 1]) {
      args.message = String(argv[index + 1]);
      index += 1;
      continue;
    }
    if (token === "--timeout-sec" && argv[index + 1]) {
      const parsed = Number(argv[index + 1]);
      if (Number.isFinite(parsed) && parsed > 0) {
        args.timeoutSec = parsed;
      }
      index += 1;
      continue;
    }
    if (token === "--headed") {
      args.headless = false;
      continue;
    }
    if (token === "--raf-sample-sec" && argv[index + 1]) {
      const parsed = Number(argv[index + 1]);
      if (Number.isFinite(parsed) && parsed > 0) {
        args.rafSampleSec = parsed;
      }
      index += 1;
      continue;
    }
    if (token === "--speaking-raf-sample-sec" && argv[index + 1]) {
      const parsed = Number(argv[index + 1]);
      if (Number.isFinite(parsed) && parsed > 0) {
        args.speakingRafSampleSec = parsed;
      }
      index += 1;
      continue;
    }
    if (token === "--avatar-mode" && argv[index + 1]) {
      const candidate = String(argv[index + 1] || "").trim().toLowerCase();
      if (candidate === "off" || candidate === "fallback" || candidate === "avatar") {
        args.avatarMode = candidate;
      }
      index += 1;
      continue;
    }
    if (token === "--provider" && argv[index + 1]) {
      args.provider = String(argv[index + 1] || "").trim();
      index += 1;
      continue;
    }
    if (token === "--model" && argv[index + 1]) {
      args.model = String(argv[index + 1] || "").trim();
      index += 1;
      continue;
    }
  }
  return args;
}

async function sampleRaf(page, sampleSec) {
  const sampleMs = Math.max(250, Math.floor(Number(sampleSec || 0) * 1000));
  return page.evaluate(async ({ sampleMs: windowMs }) => {
    const start = performance.now();
    let frames = 0;
    await new Promise((resolve) => {
      const tick = (ts) => {
        frames += 1;
        if (ts - start >= windowMs) {
          resolve();
          return;
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    const durationMs = Math.max(1, performance.now() - start);
    return {
      duration_ms: Math.round(durationMs * 100) / 100,
      frames,
      fps: Math.round((frames / (durationMs / 1000)) * 100) / 100,
    };
  }, { sampleMs });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const timeoutMs = Math.max(1000, Math.floor(args.timeoutSec * 1000));
  const requestCounts = {
    chat: 0,
    voiceSynthesize: 0,
    voiceControl: 0,
  };

  const browser = await chromium.launch({ headless: args.headless });
  const page = await browser.newPage();
  page.on("request", (request) => {
    let pathname = "";
    try {
      pathname = new URL(request.url()).pathname;
    } catch {
      pathname = String(request.url() || "");
    }
    if (pathname.endsWith("/api/chat")) {
      requestCounts.chat += 1;
    } else if (pathname.endsWith("/api/voice/synthesize")) {
      requestCounts.voiceSynthesize += 1;
    } else if (pathname.endsWith("/api/voice/control")) {
      requestCounts.voiceControl += 1;
    }
  });

  const summary = {
    ok: true,
    base_url: args.baseUrl,
    headless: args.headless,
    timeout_sec: args.timeoutSec,
    raf_sample_sec: args.rafSampleSec,
    speaking_raf_sample_sec: args.speakingRafSampleSec,
    avatar_mode: args.avatarMode || null,
    provider: args.provider || null,
    model: args.model || null,
    request_counts: requestCounts,
    performance_metrics: null,
    checks: {
      synced_notice: false,
      chat_request: false,
      speak_button_enabled: false,
      speak_started: false,
      stop_playback_observed: false,
      stop_playback_cleared: false,
    },
  };

  try {
    await page.goto(args.baseUrl, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    await page.getByText("Synced with host.", { exact: false }).waitFor({ timeout: timeoutMs });
    summary.checks.synced_notice = true;
    summary.performance_metrics = {
      synced_notice_ms: await page.evaluate(() => Math.round(performance.now() * 100) / 100),
    };
    if (args.provider) {
      await page.selectOption("#provider-id", args.provider, { timeout: timeoutMs });
      await page.waitForTimeout(350);
    }
    if (args.model) {
      await page.waitForFunction(
        (modelId) => {
          const select = document.querySelector("#model-id");
          if (!(select instanceof HTMLSelectElement)) {
            return false;
          }
          return Array.from(select.options).some((option) => option.value === modelId);
        },
        args.model,
        { timeout: timeoutMs },
      );
      await page.selectOption("#model-id", args.model, { timeout: timeoutMs });
      await page.waitForTimeout(350);
    }
    if (args.avatarMode) {
      await page.selectOption("#avatar-mode", args.avatarMode, { timeout: timeoutMs });
      await page.waitForTimeout(350);
    }
    summary.performance_metrics = {
      ...(summary.performance_metrics || {}),
      ...(await page.evaluate(async () => {
      const navigation =
        (performance.getEntriesByType("navigation")[0] &&
          performance.getEntriesByType("navigation")[0].toJSON()) ||
        null;
      return {
        navigation_ms: navigation
          ? {
              response_end: Math.round(Number(navigation.responseEnd || 0) * 100) / 100,
              dom_content_loaded_end: Math.round(Number(navigation.domContentLoadedEventEnd || 0) * 100) / 100,
              load_event_end: Math.round(Number(navigation.loadEventEnd || 0) * 100) / 100,
            }
          : null,
      };
      })),
    };
    summary.performance_metrics.raf_sample = await sampleRaf(page, args.rafSampleSec);

    const speakButton = page.getByRole("button", { name: "Speak Last Reply" });
    const composer = page.getByPlaceholder("Type your message and press Send");
    await speakButton.waitFor({ timeout: timeoutMs });

    if (await speakButton.isDisabled()) {
      const priorChatCount = requestCounts.chat;
      await composer.click({ timeout: timeoutMs });
      await composer.fill(args.message, { timeout: timeoutMs });
      await Promise.all([
        page.waitForResponse(
          (response) => response.request().method() === "POST" && response.url().includes("/api/chat"),
          { timeout: timeoutMs },
        ),
        composer.press("Enter", { timeout: timeoutMs }),
      ]);
      summary.checks.chat_request = requestCounts.chat > priorChatCount;
      try {
        await page.waitForFunction(
          () => {
            const candidate = Array.from(document.querySelectorAll("button")).find(
              (button) => button.textContent?.trim() === "Speak Last Reply",
            );
            return !!candidate && !candidate.hasAttribute("disabled");
          },
          undefined,
          { timeout: Math.max(2000, Math.floor(timeoutMs * 0.6)) },
        );
      } catch {
        // Preserve later explicit failure if speak remains disabled.
      }
    } else {
      summary.checks.chat_request = requestCounts.chat > 0;
    }

    summary.checks.speak_button_enabled = !(await speakButton.isDisabled());
    if (!summary.checks.speak_button_enabled) {
      throw new Error("Speak Last Reply button remained disabled; no assistant reply available for playback.");
    }

    await speakButton.click({ timeout: timeoutMs });

    const stopButton = page.getByRole("button", { name: "Stop Playback" });
    await page.waitForFunction(
      () => {
        const candidate = Array.from(document.querySelectorAll("button")).find(
          (button) => button.textContent?.trim() === "Stop Playback",
        );
        return !!candidate && !candidate.hasAttribute("disabled");
      },
      undefined,
      { timeout: timeoutMs },
    );
    summary.checks.speak_started = true;
    summary.checks.stop_playback_observed = true;
    summary.performance_metrics.speaking_raf_sample = await sampleRaf(page, args.speakingRafSampleSec);

    if (!(await stopButton.isDisabled())) {
      await stopButton.click({ timeout: timeoutMs });
      await page.waitForFunction(
        () => {
          const candidate = Array.from(document.querySelectorAll("button")).find(
            (button) => button.textContent?.trim() === "Stop Playback",
          );
          return !!candidate && candidate.hasAttribute("disabled");
        },
        undefined,
        { timeout: timeoutMs },
      );
    }
    summary.checks.stop_playback_cleared = true;
  } catch (error) {
    summary.ok = false;
    summary.error = error instanceof Error ? error.message : String(error);
  } finally {
    await browser.close();
  }

  console.log(JSON.stringify(summary));
  process.exit(summary.ok ? 0 : 1);
}

await main();
