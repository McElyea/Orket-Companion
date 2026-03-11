import { chromium } from "playwright";

function parseArgs(argv) {
  const args = {
    baseUrl: "http://127.0.0.1:3000",
    message: "phase b ui interruption probe",
    timeoutSec: 90,
    headless: true,
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
  }
  return args;
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
    request_counts: requestCounts,
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
      await page.waitForTimeout(1200);
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
