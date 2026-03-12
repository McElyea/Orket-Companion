import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AVATAR_PREFS_STORAGE_KEY } from "./avatar_prefs";
import { App } from "./App";

interface RecordedCall {
  path: string;
  query: string;
  method: string;
  body: unknown;
}

interface FetchMockOptions {
  emptyOllamaCatalog?: boolean;
  failLmstudioCatalog?: boolean;
  ttsAvailable?: boolean;
  avatarControlFeedEvents?: Array<Record<string, unknown>>;
}

interface MockBufferSource {
  buffer: AudioBuffer | null;
  onended: (() => void) | null;
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
}

function installAudioContextMock(options: {
  initialState?: "running" | "suspended";
  eventLog?: string[];
} = {}): {
  sources: MockBufferSource[];
  resume: ReturnType<typeof vi.fn>;
} {
  const sources: MockBufferSource[] = [];
  let currentState = options.initialState ?? "running";
  const resume = vi.fn(async () => {
    options.eventLog?.push("audio.resume");
    currentState = "running";
  });
  const context = {
    get state() {
      return currentState;
    },
    currentTime: 0,
    destination: {},
    createBuffer: (channels: number, frameCount: number, sampleRate: number) => {
      const channelData = Array.from({ length: channels }, () => new Float32Array(frameCount));
      return {
        duration: frameCount / Math.max(sampleRate, 1),
        numberOfChannels: channels,
        getChannelData: (channel: number) => channelData[channel] || new Float32Array(frameCount),
      } as unknown as AudioBuffer;
    },
    createBufferSource: () => {
      const source: MockBufferSource = {
        buffer: null,
        onended: null,
        connect: vi.fn(),
        disconnect: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
      };
      sources.push(source);
      return source as unknown as AudioBufferSourceNode;
    },
    resume,
    close: vi.fn(async () => undefined),
  } as unknown as AudioContext;

  vi.stubGlobal("AudioContext", vi.fn(() => context));
  vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  return { sources, resume };
}

const DEFAULT_CONFIG = {
  mode: {
    role_id: "general_assistant",
    relationship_style: "platonic",
    custom_style: null,
  },
  memory: {
    session_memory_enabled: true,
    profile_memory_enabled: true,
    episodic_memory_enabled: false,
  },
  voice: {
    enabled: false,
    silence_delay_sec: 1.5,
    silence_delay_min_sec: 0.2,
    silence_delay_max_sec: 10,
    adaptive_cadence_enabled: false,
    adaptive_cadence_min_sec: 0.4,
    adaptive_cadence_max_sec: 4,
  },
};

function parseBody(body: BodyInit | null | undefined): unknown {
  if (typeof body !== "string") {
    return undefined;
  }
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return body;
  }
}

function jsonResponse(payload: unknown, status: number = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function installFetchMock(options: FetchMockOptions = {}, eventLog?: string[]): RecordedCall[] {
  const calls: RecordedCall[] = [];
  const avatarControlFeedEvents = [...(options.avatarControlFeedEvents || [])];
  let avatarControlFeedSeq = 0;
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const requestUrl =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    const url = new URL(requestUrl, "http://localhost");
    const method = String(init?.method ?? "GET").toUpperCase();
    const body = parseBody(init?.body);

    calls.push({ path: url.pathname, query: url.search, method, body });
    eventLog?.push(`${method} ${url.pathname}`);

    if (method === "GET" && url.pathname === "/api/status") {
      return jsonResponse({
        ok: true,
        model_available: true,
        stt_available: true,
        tts_available: Boolean(options.ttsAvailable),
        text_only_degraded: false,
        voice_state: "stop",
        voice_silence_delay_sec: 1.5,
        active_sessions: 1,
      });
    }

    if (method === "GET" && url.pathname === "/api/config") {
      const sessionId = url.searchParams.get("session_id") ?? "local-session-1";
      return jsonResponse({
        ok: true,
        session_id: sessionId,
        config: DEFAULT_CONFIG,
      });
    }

    if (method === "PATCH" && url.pathname === "/api/config") {
      const parsed = asRecord(body) ?? {};
      return jsonResponse({
        ok: true,
        session_id: String(parsed.session_id ?? "local-session-1"),
        scope: String(parsed.scope ?? "next_turn"),
        config: DEFAULT_CONFIG,
      });
    }

    if (method === "GET" && url.pathname === "/api/history") {
      const sessionId = url.searchParams.get("session_id") ?? "local-session-1";
      return jsonResponse({
        ok: true,
        session_id: sessionId,
        history: [],
      });
    }

    if (method === "GET" && url.pathname === "/api/models") {
      const provider = url.searchParams.get("provider") ?? "ollama";
      if (provider === "lmstudio") {
        if (options.failLmstudioCatalog) {
          return jsonResponse({ detail: "lmstudio unavailable in mock" }, 503);
        }
        return jsonResponse({
          ok: true,
          requested_provider: "lmstudio",
          canonical_provider: "openai_compat",
          base_url: "http://127.0.0.1:1234/v1",
          models: ["qwen3-14b", "qwen3-4b"],
          default_model: "qwen3-14b",
        });
      }
      return jsonResponse({
        ok: true,
        requested_provider: "ollama",
        canonical_provider: "ollama",
        base_url: "http://127.0.0.1:11434",
        models: options.emptyOllamaCatalog ? [] : ["Command-R:35B", "qwen2.5-coder:7b"],
        default_model: "Command-R:35B",
      });
    }

    if (method === "GET" && url.pathname === "/api/voice/state") {
      return jsonResponse({ ok: true, state: "stop", silence_delay_sec: 1.5 });
    }

    if (method === "GET" && url.pathname === "/api/voice/voices") {
      if (options.ttsAvailable) {
        return jsonResponse({
          ok: true,
          tts_available: true,
          default_voice_id: "en_US-calm",
          voices: [
            {
              voice_id: "en_US-calm",
              display_name: "English Calm",
              language: "en-US",
              tags: ["piper"],
            },
          ],
        });
      }
      return jsonResponse({ ok: true, tts_available: false, default_voice_id: "", voices: [] });
    }

    if (method === "POST" && url.pathname === "/api/voice/control") {
      const parsed = asRecord(body) ?? {};
      return jsonResponse({
        ok: true,
        state: String(parsed.command ?? "stop"),
        error_code: null,
        error_message: "",
      });
    }

    if (method === "POST" && url.pathname === "/api/voice/synthesize") {
      if (!options.ttsAvailable) {
        return jsonResponse({
          ok: false,
          voice_id: "null",
          sample_rate: 22050,
          channels: 1,
          format: "pcm_s16le",
          audio_b64: "",
          error_code: "tts_unavailable",
          error_message: "No TTS backend configured.",
        });
      }
      return jsonResponse({
        ok: true,
        voice_id: "en_US-calm",
        sample_rate: 22050,
        channels: 1,
        format: "pcm_s16le",
        audio_b64: "AAABAA==",
        error_code: null,
        error_message: "",
      });
    }

    if (method === "POST" && url.pathname === "/api/chat") {
      const parsed = asRecord(body) ?? {};
      return jsonResponse({
        ok: true,
        session_id: String(parsed.session_id ?? "local-session-1"),
        turn_id: "turn.000001",
        message: "mock companion reply",
        model: "mock-model",
        latency_ms: 5,
        text_only_degraded: false,
      });
    }

    if (method === "GET" && url.pathname === "/api/avatar/control-events") {
      const afterSeq = Number(url.searchParams.get("after_seq") ?? "0");
      const limit = Math.max(1, Number(url.searchParams.get("limit") ?? "50"));
      const sessionId = url.searchParams.get("session_id") ?? "companion-main";
      const delivered: Array<Record<string, unknown>> = [];
      while (avatarControlFeedEvents.length > 0 && delivered.length < limit) {
        avatarControlFeedSeq += 1;
        const next = avatarControlFeedEvents.shift() || {};
        delivered.push({
          seq: avatarControlFeedSeq,
          ...next,
        });
      }
      return jsonResponse({
        ok: true,
        session_id: sessionId,
        events: delivered.filter((event) => Number((event as { seq?: unknown }).seq || 0) > afterSeq),
        latest_seq: avatarControlFeedSeq,
      });
    }

    if (method === "POST" && url.pathname === "/api/session/clear-memory") {
      const parsed = asRecord(body) ?? {};
      return jsonResponse({
        ok: true,
        session_id: String(parsed.session_id ?? "local-session-1"),
        deleted_records: 0,
        deleted_episodic_records: 0,
      });
    }

    return jsonResponse({ detail: "mock route not configured" }, 404);
  });

  vi.stubGlobal("fetch", fetchMock);
  return calls;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe("Companion App", () => {
  it("Layer: contract. shows voice controls and sends explicit voice commands.", async () => {
    const calls = installFetchMock();
    const user = userEvent.setup();

    render(<App />);

    await screen.findByText(/synced with host/i);
    await user.click(screen.getByRole("button", { name: /start/i }));

    await waitFor(() => {
      expect(
        calls.some((call) => {
          const payload = asRecord(call.body);
          return call.path === "/api/voice/control" && payload?.command === "start";
        }),
      ).toBe(true);
    });
  });

  it("Layer: contract. sends TTS synthesize request for the latest assistant reply.", async () => {
    const calls = installFetchMock({ ttsAvailable: true });
    const user = userEvent.setup();

    render(<App />);
    await screen.findByText(/synced with host/i);

    const composer = screen.getByPlaceholderText("Type your message and press Send");
    await user.type(composer, "hello tts");
    await user.keyboard("{Enter}");

    await waitFor(() => {
      expect(calls.some((call) => call.path === "/api/chat")).toBe(true);
    });

    await user.click(screen.getByRole("button", { name: /speak last reply/i }));

    await waitFor(() => {
      const synthCall = [...calls].reverse().find((call) => call.path === "/api/voice/synthesize");
      const payload = asRecord(synthCall?.body);
      expect(payload?.text).toBe("mock companion reply");
    });
  });

  it("Layer: integration. interrupts active playback before starting a new TTS playback.", async () => {
    const calls = installFetchMock({ ttsAvailable: true });
    const audioHarness = installAudioContextMock();
    const user = userEvent.setup();

    render(<App />);
    await screen.findByText(/synced with host/i);

    const composer = screen.getByPlaceholderText("Type your message and press Send");
    await user.type(composer, "first playback");
    await user.keyboard("{Enter}");

    await waitFor(() => {
      expect(calls.some((call) => call.path === "/api/chat")).toBe(true);
    });

    const speakButton = screen.getByRole("button", { name: /speak last reply/i });
    await user.click(speakButton);

    await waitFor(() => {
      expect(audioHarness.sources.length).toBe(1);
    });

    await user.click(speakButton);
    await waitFor(() => {
      expect(audioHarness.sources.length).toBe(2);
      expect(audioHarness.sources[0].stop).toHaveBeenCalledTimes(1);
      expect(audioHarness.sources[0].disconnect).toHaveBeenCalledTimes(1);
      expect(calls.filter((call) => call.path === "/api/voice/synthesize").length).toBeGreaterThanOrEqual(2);
    });
  });

  it("Layer: integration. auto-speak replies triggers synthesis automatically when enabled.", async () => {
    const eventLog: string[] = [];
    const calls = installFetchMock({ ttsAvailable: true }, eventLog);
    const audioHarness = installAudioContextMock({ initialState: "suspended", eventLog });
    const user = userEvent.setup();

    render(<App />);
    await screen.findByText(/synced with host/i);

    await user.click(screen.getByRole("switch", { name: "Auto-speak replies" }));

    const composer = screen.getByPlaceholderText("Type your message and press Send");
    await user.type(composer, "auto speak this");
    await user.keyboard("{Enter}");

    await waitFor(() => {
      expect(calls.some((call) => call.path === "/api/voice/synthesize")).toBe(true);
      expect(audioHarness.resume).toHaveBeenCalledTimes(1);
      expect(audioHarness.sources.length).toBe(1);
    });
    expect(eventLog.indexOf("audio.resume")).toBeGreaterThanOrEqual(0);
    expect(eventLog.indexOf("audio.resume")).toBeLessThan(eventLog.indexOf("POST /api/chat"));
    expect((screen.getByRole("button", { name: /stop playback/i }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("Layer: contract. auto-speak toggle shows explicit state and can be toggled from its label row.", async () => {
    installFetchMock({ ttsAvailable: true });
    const user = userEvent.setup();

    render(<App />);
    await screen.findByText(/synced with host/i);

    const toggle = screen.getByRole("switch", { name: "Auto-speak replies" });
    const toggleButton = screen.getByRole("button", { name: "Auto-speak replies: Off" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(toggleButton.textContent).toContain("Auto-speak replies");

    await user.click(toggleButton);

    await waitFor(() => {
      expect(toggle.getAttribute("aria-checked")).toBe("true");
    });
    expect(screen.getByRole("button", { name: "Auto-speak replies: On" })).toBeTruthy();
  });

  it("Layer: contract. preserves explicit text submit semantics even after voice control changes.", async () => {
    const calls = installFetchMock();
    const user = userEvent.setup();

    render(<App />);

    await screen.findByText(/synced with host/i);

    const slider = screen.getByRole("slider");
    fireEvent.change(slider, { target: { value: "3.2" } });
    await user.click(screen.getByRole("button", { name: /start/i }));

    const composer = screen.getByPlaceholderText("Type your message and press Send");
    await user.type(composer, "send explicitly");
    await user.click(screen.getByRole("button", { name: /^send$/i }));

    await waitFor(() => {
      expect(calls.some((call) => call.path === "/api/chat")).toBe(true);
    });

    const chatCall = [...calls].reverse().find((call) => call.path === "/api/chat");
    const chatPayload = asRecord(chatCall?.body);
    expect(chatPayload?.message).toBe("send explicitly");
    expect(chatPayload?.provider).toBe("ollama");
    expect(chatPayload?.model).toBe("Command-R:35B");
    expect(chatPayload).not.toHaveProperty("silence_delay_sec");
  });

  it("Layer: integration. Apply to Chat mode settings are included in config patch before chat.", async () => {
    const calls = installFetchMock();
    const user = userEvent.setup();

    render(<App />);
    await screen.findByText(/synced with host/i);

    await user.selectOptions(screen.getByLabelText("Companion Role"), "girlfriend");
    await user.selectOptions(screen.getByLabelText("Relationship Style"), "romantic");

    const composer = screen.getByPlaceholderText("Type your message and press Send");
    await user.type(composer, "apply mode now");
    await user.keyboard("{Enter}");

    await waitFor(() => {
      const patchCall = [...calls].reverse().find((call) => call.path === "/api/config" && call.method === "PATCH");
      const patchPayload = asRecord(patchCall?.body);
      const patchRoot = asRecord(patchPayload?.patch);
      const mode = asRecord(patchRoot?.mode);
      expect(mode?.role_id).toBe("girlfriend");
      expect(mode?.relationship_style).toBe("romantic");
    });
  });

  it("Layer: contract. chat side setting controls and persists panel layout order.", async () => {
    installFetchMock();
    const user = userEvent.setup();

    render(<App />);

    await screen.findByText(/synced with host/i);
    const initialOrder = screen.getAllByRole("heading", { level: 2 }).map((item) => item.textContent);
    expect(initialOrder).toEqual(["Presence", "Chat"]);

    const chatSide = screen.getByLabelText("Chat Side");
    await user.selectOptions(chatSide, "left");
    const swappedOrder = screen.getAllByRole("heading", { level: 2 }).map((item) => item.textContent);
    expect(swappedOrder).toEqual(["Chat", "Presence"]);
    expect((chatSide as HTMLSelectElement).value).toBe("left");

    cleanup();
    render(<App />);
    await screen.findByText(/synced with host/i);
    const persistedOrder = screen.getAllByRole("heading", { level: 2 }).map((item) => item.textContent);
    expect(persistedOrder).toEqual(["Chat", "Presence"]);
    expect((screen.getByLabelText("Chat Side") as HTMLSelectElement).value).toBe("left");
  });

  it("Layer: contract. shows listening wave indicator while voice capture is active.", async () => {
    installFetchMock();
    const user = userEvent.setup();

    render(<App />);
    await screen.findByText(/synced with host/i);

    const indicator = screen.getByTestId("voice-pickup-wave");
    expect(indicator.getAttribute("data-active")).toBe("false");

    await user.click(screen.getByRole("button", { name: /start/i }));
    await waitFor(() => {
      expect(indicator.getAttribute("data-active")).toBe("true");
    });

    await user.click(screen.getByRole("button", { name: /^stop$/i }));
    await waitFor(() => {
      expect(indicator.getAttribute("data-active")).toBe("false");
    });
  });

  it("Layer: contract. derives deterministic avatar lifecycle state from voice/runtime signals.", async () => {
    installFetchMock();
    const user = userEvent.setup();

    render(<App />);
    await screen.findByText(/synced with host/i);
    expect(screen.getByText("idle")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: /start/i }));
    await waitFor(() => {
      expect(screen.getByText("listening")).toBeTruthy();
    });

    await user.click(screen.getByRole("button", { name: /^stop$/i }));
    await waitFor(() => {
      expect(screen.getByText("idle")).toBeTruthy();
    });
  });

  it("Layer: contract. reduced motion keeps voice pickup wave inactive even when voice capture starts.", async () => {
    installFetchMock();
    const user = userEvent.setup();

    render(<App />);
    await screen.findByText(/synced with host/i);

    await user.selectOptions(screen.getByLabelText("Motion Profile"), "reduced");
    expect(screen.getByText("Reduced motion is enabled.")).toBeTruthy();

    const indicator = screen.getByTestId("voice-pickup-wave");
    expect(indicator.getAttribute("data-active")).toBe("false");

    await user.click(screen.getByRole("button", { name: /start/i }));
    await waitFor(() => {
      expect(indicator.getAttribute("data-active")).toBe("false");
    });
  });

  it("Layer: contract. persists reduced-motion avatar preference across reload.", async () => {
    installFetchMock();
    const user = userEvent.setup();

    render(<App />);
    await screen.findByText(/synced with host/i);
    await user.selectOptions(screen.getByLabelText("Motion Profile"), "reduced");
    expect((screen.getByLabelText("Motion Profile") as HTMLSelectElement).value).toBe("reduced");

    cleanup();
    render(<App />);
    await screen.findByText(/synced with host/i);
    expect((screen.getByLabelText("Motion Profile") as HTMLSelectElement).value).toBe("reduced");
    expect(screen.getByText("Reduced motion is enabled.")).toBeTruthy();
  });

  it("Layer: contract. supports keyboard traversal to chat composer controls without a left rail.", async () => {
    installFetchMock();
    const user = userEvent.setup();

    render(<App />);

    await screen.findByText(/synced with host/i);

    const chatInput = screen.getByPlaceholderText("Type your message and press Send");

    let reachedComposer = false;
    for (let index = 0; index < 24; index += 1) {
      await user.tab();
      if (document.activeElement === chatInput) {
        reachedComposer = true;
        break;
      }
    }

    expect(reachedComposer).toBe(true);
  });

  it("Layer: contract. keeps presence panel rendered with resilient fallback avatar.", async () => {
    installFetchMock();

    render(<App />);

    await screen.findByText(/synced with host/i);
    expect(screen.queryByAltText("Companion avatar")).toBeNull();
    expect(screen.getByTestId("presence-avatar-fallback")).toBeTruthy();
  });

  it("Layer: integration. emits required avatar observability events during normal UI transitions.", async () => {
    installFetchMock();
    const user = userEvent.setup();
    const diagnosticsWindow = window as unknown as {
      __COMPANION_AVATAR_EVENTS__?: Array<{ type: string; payload?: Record<string, unknown> }>;
    };
    diagnosticsWindow.__COMPANION_AVATAR_EVENTS__ = [];

    render(<App />);
    await screen.findByText(/synced with host/i);

    await user.click(screen.getByRole("button", { name: /start/i }));
    await waitFor(() => {
      const eventTypes = (diagnosticsWindow.__COMPANION_AVATAR_EVENTS__ || []).map((event) => event.type);
      expect(eventTypes).toContain("avatar.renderer_selected");
      expect(eventTypes).toContain("avatar.state_changed");
      expect(eventTypes).toContain("avatar.fallback_activated");
    });
  });

  it("Layer: contract. fails closed on unsupported external avatar control-event versions.", async () => {
    installFetchMock();

    render(<App />);
    await screen.findByText(/synced with host/i);

    window.dispatchEvent(
      new CustomEvent("companion:avatar-control-event", {
        detail: {
          type: "avatar.expression",
          version: "avatar_event_v2",
          session_id: "session-1",
          ts: "2026-03-11T00:00:00.000Z",
          idempotency_key: "dup-1",
          payload: { expression: "smile" },
        },
      }),
    );

    await waitFor(() => {
      expect(screen.queryByTestId("avatar-expression-cue")).toBeNull();
    });
    expect(screen.getByText("idle")).toBeTruthy();
  });

  it("Layer: integration. applies supported external expression and gesture events as additive avatar cues.", async () => {
    installFetchMock();

    render(<App />);
    await screen.findByText(/synced with host/i);
    expect(screen.getByText("idle")).toBeTruthy();

    window.dispatchEvent(
      new CustomEvent("companion:avatar-control-event", {
        detail: {
          type: "avatar.expression",
          version: "avatar_event_v1",
          session_id: "session-1",
          ts: "2026-03-11T00:00:00.000Z",
          idempotency_key: "expression-1",
          payload: { expression: "smile" },
        },
      }),
    );

    await waitFor(() => {
      expect(screen.getByTestId("avatar-expression-cue").textContent).toContain("Expression cue: smile");
    });
    expect(screen.getByText("idle")).toBeTruthy();

    window.dispatchEvent(
      new CustomEvent("companion:avatar-control-event", {
        detail: {
          type: "avatar.gesture",
          version: "avatar_event_v1",
          session_id: "session-1",
          ts: "2026-03-11T00:00:01.000Z",
          idempotency_key: "gesture-1",
          payload: { gesture: "wave" },
        },
      }),
    );

    await waitFor(() => {
      expect(screen.getByTestId("avatar-gesture-cue").textContent).toContain("Gesture cue: wave");
    });
    expect(screen.getByText("idle")).toBeTruthy();
  });

  it("Layer: integration. ingests gateway avatar control-event feed and applies additive cues.", async () => {
    installFetchMock({
      avatarControlFeedEvents: [
        {
          type: "avatar.expression",
          version: "avatar_event_v1",
          session_id: "companion-main",
          ts: "2026-03-11T00:00:10.000Z",
          idempotency_key: "feed-expression-1",
          payload: { expression: "grin" },
        },
        {
          type: "avatar.gesture",
          version: "avatar_event_v1",
          session_id: "companion-main",
          ts: "2026-03-11T00:00:11.000Z",
          idempotency_key: "feed-gesture-1",
          payload: { gesture: "wave" },
        },
      ],
    });

    render(<App />);
    await screen.findByText(/synced with host/i);

    await waitFor(() => {
      expect(screen.getByTestId("avatar-expression-cue").textContent).toContain("Expression cue: grin");
    });
    await waitFor(() => {
      expect(screen.getByTestId("avatar-gesture-cue").textContent).toContain("Gesture cue: wave");
    });
    expect(screen.getByText("idle")).toBeTruthy();
  });

  it("Layer: contract. restores avatar_prefs_v1 from storage and renders local avatar asset when enabled.", async () => {
    window.localStorage.setItem(
      AVATAR_PREFS_STORAGE_KEY,
      JSON.stringify({
        version: "avatar_prefs_v1",
        mode: "avatar",
        renderer: "vrm",
        asset_ref: "assets/local-avatar.png",
        motion_profile: "default",
        fallback_policy: "always_safe",
      }),
    );
    installFetchMock();

    render(<App />);

    await screen.findByText(/synced with host/i);
    const avatarImage = screen.getByAltText("Companion avatar") as HTMLImageElement;
    expect(avatarImage.getAttribute("src")).toBe("/static/assets/local-avatar.png");
    expect((screen.getByLabelText("Avatar Mode") as HTMLSelectElement).value).toBe("avatar");
    expect((screen.getByLabelText("Avatar Renderer") as HTMLSelectElement).value).toBe("vrm");
  });

  it("Layer: contract. fails closed to fallback for disallowed remote avatar asset refs.", async () => {
    installFetchMock();
    const user = userEvent.setup();

    render(<App />);
    await screen.findByText(/synced with host/i);

    await user.selectOptions(screen.getByLabelText("Avatar Mode"), "avatar");
    await user.selectOptions(screen.getByLabelText("Avatar Renderer"), "vrm");
    await user.clear(screen.getByLabelText("Avatar Asset Ref (local)"));
    await user.type(screen.getByLabelText("Avatar Asset Ref (local)"), "https://example.com/avatar.png");

    expect(screen.queryByAltText("Companion avatar")).toBeNull();
    expect(screen.getByText("Remote avatar assets are disabled for this lane.")).toBeTruthy();
    expect(screen.getByTestId("presence-avatar-fallback")).toBeTruthy();
  });

  it("Layer: contract. fails closed to fallback for unsupported local avatar asset types.", async () => {
    installFetchMock();
    const user = userEvent.setup();

    render(<App />);
    await screen.findByText(/synced with host/i);

    await user.selectOptions(screen.getByLabelText("Avatar Mode"), "avatar");
    await user.selectOptions(screen.getByLabelText("Avatar Renderer"), "vrm");
    await user.clear(screen.getByLabelText("Avatar Asset Ref (local)"));
    await user.type(screen.getByLabelText("Avatar Asset Ref (local)"), "assets/avatar.exe");

    expect(screen.queryByAltText("Companion avatar")).toBeNull();
    expect(
      screen.getByText("Unsupported avatar asset type; allowed formats include images and VRM/GLTF."),
    ).toBeTruthy();
    expect(screen.getByTestId("presence-avatar-fallback")).toBeTruthy();
  });

  it("Layer: contract. falls back quietly when persisted avatar prefs are invalid.", async () => {
    window.localStorage.setItem(
      AVATAR_PREFS_STORAGE_KEY,
      JSON.stringify({
        version: "avatar_prefs_v1",
        mode: "avatar",
        renderer: "vrm",
        asset_ref: "assets/local-avatar.png",
        motion_profile: "default",
        fallback_policy: "unsafe_policy",
      }),
    );
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    installFetchMock();

    render(<App />);
    await screen.findByText(/synced with host/i);

    expect(screen.queryByAltText("Companion avatar")).toBeNull();
    expect(screen.getByTestId("presence-avatar-fallback")).toBeTruthy();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("Layer: contract. repopulates model catalog from lmstudio when provider is switched.", async () => {
    installFetchMock();
    const user = userEvent.setup();

    render(<App />);

    await screen.findByText(/synced with host/i);
    const providerSelect = screen.getByLabelText("Provider");
    const modelSelect = screen.getByLabelText("Model");

    expect(screen.getByRole("option", { name: "Command-R:35B" })).toBeTruthy();
    await user.selectOptions(providerSelect, "lmstudio");

    await waitFor(() => {
      expect(screen.getByRole("option", { name: "qwen3-14b" })).toBeTruthy();
    });
    expect(screen.queryByRole("option", { name: "Command-R:35B" })).toBeNull();
    expect((modelSelect as HTMLSelectElement).value).toBe("qwen3-14b");
  });

  it("Layer: contract. sends chat on Enter, keeps Shift+Enter newline, and preserves composer focus.", async () => {
    const calls = installFetchMock();
    const user = userEvent.setup();

    render(<App />);
    await screen.findByText(/synced with host/i);

    const composer = screen.getByPlaceholderText("Type your message and press Send");
    await user.click(composer);
    await user.type(composer, "line one");
    await user.keyboard("{Shift>}{Enter}{/Shift}");
    await user.type(composer, "line two");
    expect((composer as HTMLTextAreaElement).value).toContain("\n");

    await user.keyboard("{Enter}");
    await waitFor(() => {
      expect(calls.some((call) => call.path === "/api/chat")).toBe(true);
    });
    await waitFor(() => {
      expect(document.activeElement).toBe(composer);
    });
  });

  it("Layer: contract. falls back to default Ollama model when catalog is empty.", async () => {
    installFetchMock({ emptyOllamaCatalog: true });
    render(<App />);

    await screen.findByText(/synced with host/i);
    expect(screen.getByRole("option", { name: "Command-R:35B" })).toBeTruthy();
  });

  it("Layer: contract. keeps chat anchored to the latest message when user is already at the bottom.", async () => {
    installFetchMock();
    const user = userEvent.setup();

    render(<App />);
    await screen.findByText(/synced with host/i);

    const list = screen.getByTestId("chat-message-list") as HTMLDivElement;
    let scrollTopValue = 700;
    Object.defineProperty(list, "clientHeight", { configurable: true, get: () => 300 });
    Object.defineProperty(list, "scrollHeight", { configurable: true, get: () => 1000 });
    Object.defineProperty(list, "scrollTop", {
      configurable: true,
      get: () => scrollTopValue,
      set: (next: number) => {
        scrollTopValue = Number(next);
      },
    });

    fireEvent.scroll(list);

    const composer = screen.getByPlaceholderText("Type your message and press Send");
    await user.type(composer, "keep me pinned");
    await user.keyboard("{Enter}");

    await waitFor(() => {
      expect(scrollTopValue).toBe(1000);
    });
  });

  it("Layer: contract. preserves a user-selected model and sends it on chat requests.", async () => {
    const calls = installFetchMock();
    const user = userEvent.setup();

    render(<App />);
    await screen.findByText(/synced with host/i);

    const modelSelect = screen.getByLabelText("Model");
    await user.selectOptions(modelSelect, "qwen2.5-coder:7b");
    expect((modelSelect as HTMLSelectElement).value).toBe("qwen2.5-coder:7b");

    const composer = screen.getByPlaceholderText("Type your message and press Send");
    await user.type(composer, "use selected model");
    await user.keyboard("{Enter}");

    await waitFor(() => {
      const chatCall = [...calls].reverse().find((call) => call.path === "/api/chat");
      const payload = asRecord(chatCall?.body);
      expect(payload?.model).toBe("qwen2.5-coder:7b");
    });
  });

  it("Layer: integration. preloads model catalogs for all providers on startup.", async () => {
    const calls = installFetchMock();
    render(<App />);

    await screen.findByText(/synced with host/i);
    await waitFor(() => {
      expect(calls.some((call) => call.path === "/api/models" && call.query.includes("provider=ollama"))).toBe(true);
      expect(calls.some((call) => call.path === "/api/models" && call.query.includes("provider=lmstudio"))).toBe(true);
      expect(calls.some((call) => call.path === "/api/models" && call.query.includes("provider=openai_compat"))).toBe(
        true,
      );
    });
  });

  it("Layer: contract. uses cached model catalog immediately when provider model API is slow or failing.", async () => {
    const now = Date.now();
    window.localStorage.setItem(
      "companion:model-catalog:v1",
      JSON.stringify({
        lmstudio: { models: ["cached-lm-model"], defaultModel: "cached-lm-model", updatedAt: now },
        ollama: { models: ["Command-R:35B"], defaultModel: "Command-R:35B", updatedAt: now },
      }),
    );
    installFetchMock({ failLmstudioCatalog: true });
    const user = userEvent.setup();

    render(<App />);
    await screen.findByText(/synced with host/i);

    const providerSelect = screen.getByLabelText("Provider");
    await user.selectOptions(providerSelect, "lmstudio");

    await waitFor(() => {
      expect(screen.getByRole("option", { name: "cached-lm-model" })).toBeTruthy();
    });
    expect((screen.getByLabelText("Model") as HTMLSelectElement).value).toBe("cached-lm-model");
  });
});

