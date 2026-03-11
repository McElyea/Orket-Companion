import * as Accordion from "@radix-ui/react-accordion";
import * as Switch from "@radix-ui/react-switch";
import {
  AudioLines,
  Brain,
  ChevronDown,
  Mic,
  MicOff,
  RotateCcw,
  Save,
  SendHorizonal,
  UserRound,
  Waves,
} from "lucide-react";
import { FormEvent, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import {
  loadAvatarPrefsFromStorage,
  persistAvatarPrefs,
} from "./avatar_prefs";
import {
  createAvatarControlEventDeduper,
  parseAvatarControlEventEnvelope,
} from "./avatar_control_events";
import { deriveAvatarPrimaryState } from "./avatar_lifecycle";
import { createAvatarRenderer, resolveAvatarRenderDecision } from "./avatar_renderer";
import { CompanionApiClient } from "./api/client";
import type {
  AvatarPrefsV1,
  CompanionConfig,
  CompanionConfigScope,
  CompanionProvider,
  HistoryRow,
  StatusResponse,
  VoiceCommand,
  VoiceInfo,
  VoiceStateResponse,
} from "./types";
import styles from "./styles/App.module.scss";

type FontPersonality = "girly" | "manly" | "neutral" | "weird" | "elegant" | "playful" | "techno";
type ChatSide = "left" | "right";

type PresenceMood = "neutral" | "warm" | "focused" | "curious";

const PROVIDER_OPTIONS: Array<{ value: CompanionProvider; label: string }> = [
  { value: "ollama", label: "Ollama" },
  { value: "lmstudio", label: "LM Studio" },
  { value: "openai_compat", label: "OpenAI-Compatible" },
];

const DEFAULT_PROVIDER: CompanionProvider = "ollama";
const DEFAULT_MODEL = "Command-R:35B";
const MODEL_CACHE_STORAGE_KEY = "companion:model-catalog:v1";
const UI_PREFERENCES_STORAGE_KEY = "companion:ui-preferences:v1";
const MODEL_CACHE_TTL_MS = 30 * 60 * 1000;

interface ModelCatalogCacheEntry {
  models: string[];
  defaultModel: string;
  updatedAt: number;
}

type ModelCatalogCache = Record<CompanionProvider, ModelCatalogCacheEntry>;

interface UiPreferences {
  chatSide: ChatSide;
  autoSpeakReplies: boolean;
}

function createDefaultModelCatalogCache(): ModelCatalogCache {
  return {
    ollama: {
      models: [DEFAULT_MODEL],
      defaultModel: DEFAULT_MODEL,
      updatedAt: 0,
    },
    lmstudio: {
      models: [],
      defaultModel: "",
      updatedAt: 0,
    },
    openai_compat: {
      models: [],
      defaultModel: "",
      updatedAt: 0,
    },
  };
}

function normalizeModelCatalogEntries(entries: Array<string | null | undefined>): string[] {
  return [...new Set(entries.map((entry) => String(entry || "").trim()).filter((entry) => entry.length > 0))];
}

function chooseCatalogModel(
  targetProvider: CompanionProvider,
  models: string[],
  previousSelection: string,
  defaultModel: string,
): string {
  if (previousSelection && models.includes(previousSelection)) {
    return previousSelection;
  }
  if (targetProvider === "ollama" && models.includes(DEFAULT_MODEL)) {
    return DEFAULT_MODEL;
  }
  if (defaultModel && models.includes(defaultModel)) {
    return defaultModel;
  }
  if (models.length > 0) {
    return models[0];
  }
  if (targetProvider === "ollama") {
    return DEFAULT_MODEL;
  }
  return "";
}

function readPersistedModelCatalogCache(): Partial<ModelCatalogCache> {
  try {
    const raw = window.localStorage.getItem(MODEL_CACHE_STORAGE_KEY);
    if (!raw) {
      return {};
    }
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const now = Date.now();
    const result: Partial<ModelCatalogCache> = {};
    for (const provider of ["ollama", "lmstudio", "openai_compat"] as CompanionProvider[]) {
      const candidate = parsed[provider];
      if (!candidate || typeof candidate !== "object") {
        continue;
      }
      const entry = candidate as {
        models?: unknown;
        defaultModel?: unknown;
        updatedAt?: unknown;
      };
      const updatedAt = typeof entry.updatedAt === "number" ? entry.updatedAt : 0;
      if (updatedAt <= 0 || now - updatedAt > MODEL_CACHE_TTL_MS) {
        continue;
      }
      const models = Array.isArray(entry.models)
        ? normalizeModelCatalogEntries(entry.models as Array<string | null | undefined>)
        : [];
      const defaultModel = typeof entry.defaultModel === "string" ? entry.defaultModel.trim() : "";
      result[provider] = { models, defaultModel, updatedAt };
    }
    return result;
  } catch {
    return {};
  }
}

function persistModelCatalogCache(cache: ModelCatalogCache): void {
  try {
    window.localStorage.setItem(MODEL_CACHE_STORAGE_KEY, JSON.stringify(cache));
  } catch {
    // Best-effort cache persistence only.
  }
}

function readUiPreferences(): UiPreferences {
  const fallback: UiPreferences = { chatSide: "right", autoSpeakReplies: false };
  try {
    const raw = window.localStorage.getItem(UI_PREFERENCES_STORAGE_KEY);
    if (!raw) {
      return fallback;
    }
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const chatSideRaw = String(parsed.chatSide || "").trim().toLowerCase();
    const chatSide: ChatSide = chatSideRaw === "left" ? "left" : "right";
    const autoSpeakReplies = Boolean(parsed.autoSpeakReplies);
    return { chatSide, autoSpeakReplies };
  } catch {
    return fallback;
  }
}

function persistUiPreferences(value: UiPreferences): void {
  try {
    window.localStorage.setItem(UI_PREFERENCES_STORAGE_KEY, JSON.stringify(value));
  } catch {
    // Best-effort preference persistence only.
  }
}

const ROLE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "none", label: "None" },
  { value: "waifu", label: "Waifu" },
  { value: "boyfriend", label: "Boyfriend" },
  { value: "girlfriend", label: "Girlfriend" },
  { value: "husband", label: "Husband" },
  { value: "role_play", label: "Role Play" },
  { value: "general_assistant", label: "Balanced Companion" },
  { value: "supportive_listener", label: "Confidant" },
  { value: "strategist", label: "Planner" },
  { value: "tutor", label: "Mentor" },
  { value: "researcher", label: "Curious Explorer" },
  { value: "programmer", label: "Analytical Thinker" },
];

const STYLE_OPTIONS: Array<{ value: string; label: string; disabled?: boolean }> = [
  { value: "platonic", label: "Friendship" },
  { value: "intermediate", label: "Close" },
  { value: "romantic", label: "Romantic" },
  { value: "custom", label: "Custom (advanced)", disabled: true },
];

const FONT_PERSONALITIES: Array<{ value: FontPersonality; label: string }> = [
  { value: "girly", label: "Soft (Quicksand)" },
  { value: "manly", label: "Bold (IBM Plex Sans)" },
  { value: "neutral", label: "Clean (Source Sans 3)" },
  { value: "weird", label: "Quirky (Space Grotesk)" },
  { value: "elegant", label: "Classic (Playfair Display)" },
  { value: "playful", label: "Playful (Nunito)" },
  { value: "techno", label: "Sharp (Fira Sans)" },
];

const DEFAULT_CONFIG: CompanionConfig = {
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

const DEFAULT_VOICE_STATE: VoiceStateResponse = {
  ok: true,
  state: "stop",
  silence_delay_sec: 1.5,
};

function inferPresenceMood(text: string): PresenceMood {
  const normalized = text.toLowerCase();
  if (!normalized) {
    return "neutral";
  }
  if (normalized.includes("?") || normalized.includes("curious") || normalized.includes("wonder")) {
    return "curious";
  }
  if (normalized.includes("step") || normalized.includes("plan") || normalized.includes("focus")) {
    return "focused";
  }
  if (normalized.includes("glad") || normalized.includes("care") || normalized.includes("with you")) {
    return "warm";
  }
  return "neutral";
}

function humanizeState(raw: string): string {
  const normalized = String(raw || "").trim();
  if (!normalized) {
    return "unknown";
  }
  return normalized.replace(/_/g, " ");
}

function safeDelay(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, value));
}

function decodePcmS16LeBase64(payload: string): Uint8Array {
  const decoded = window.atob(String(payload || ""));
  const bytes = new Uint8Array(decoded.length);
  for (let index = 0; index < decoded.length; index += 1) {
    bytes[index] = decoded.charCodeAt(index);
  }
  return bytes;
}

function createAudioBufferFromPcm16Le(
  context: AudioContext,
  payloadB64: string,
  sampleRate: number,
  channels: number,
): AudioBuffer {
  const pcmBytes = decodePcmS16LeBase64(payloadB64);
  if (pcmBytes.length < 2) {
    throw new Error("Audio payload is empty.");
  }
  const resolvedChannels = Math.max(1, Math.floor(channels || 1));
  const sampleCount = Math.floor(pcmBytes.length / 2);
  const frameCount = Math.max(1, Math.floor(sampleCount / resolvedChannels));
  const buffer = context.createBuffer(resolvedChannels, frameCount, Math.max(8000, Math.floor(sampleRate || 22050)));
  for (let channel = 0; channel < resolvedChannels; channel += 1) {
    const channelData = buffer.getChannelData(channel);
    for (let frame = 0; frame < frameCount; frame += 1) {
      const sampleIndex = frame * resolvedChannels + channel;
      const byteOffset = sampleIndex * 2;
      if (byteOffset + 1 >= pcmBytes.length) {
        channelData[frame] = 0;
        continue;
      }
      const lo = pcmBytes[byteOffset];
      const hi = pcmBytes[byteOffset + 1];
      let value = (hi << 8) | lo;
      if (value & 0x8000) {
        value -= 0x10000;
      }
      channelData[frame] = value / 32768;
    }
  }
  return buffer;
}

export function App(): JSX.Element {
  const api = useMemo(() => new CompanionApiClient("/api"), []);

  const sessionId = "companion-main";
  const initialAvatarPrefsLoad = useMemo(() => loadAvatarPrefsFromStorage(), []);
  const [avatarPrefs, setAvatarPrefs] = useState<AvatarPrefsV1>(initialAvatarPrefsLoad.prefs);
  const [avatarLoadFailed, setAvatarLoadFailed] = useState(false);
  const [uiPreferences, setUiPreferences] = useState<UiPreferences>(() => readUiPreferences());
  const [chatDraft, setChatDraft] = useState("");
  const [history, setHistory] = useState<HistoryRow[]>([]);
  const [config, setConfig] = useState<CompanionConfig>(DEFAULT_CONFIG);
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [voiceState, setVoiceState] = useState<VoiceStateResponse>(DEFAULT_VOICE_STATE);
  const [ttsVoices, setTtsVoices] = useState<VoiceInfo[]>([]);
  const [selectedVoiceId, setSelectedVoiceId] = useState("");
  const [ttsSpeaking, setTtsSpeaking] = useState(false);
  const [fontPersonality, setFontPersonality] = useState<FontPersonality>("neutral");
  const [provider, setProvider] = useState<CompanionProvider>(DEFAULT_PROVIDER);
  const [model, setModel] = useState(DEFAULT_MODEL);
  const [availableModels, setAvailableModels] = useState<string[]>([DEFAULT_MODEL]);
  const modelSelectionRef = useRef(DEFAULT_MODEL);
  const modelCatalogCacheRef = useRef<ModelCatalogCache>(createDefaultModelCatalogCache());
  const modelCatalogRequestSeqRef = useRef<Record<CompanionProvider, number>>({
    ollama: 0,
    lmstudio: 0,
    openai_compat: 0,
  });
  const didInitialModelRefreshRef = useRef(false);
  const [trayOpen, setTrayOpen] = useState(true);
  const [notice, setNotice] = useState("I am here with you, not at you.");
  const [sending, setSending] = useState(false);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const audioSourceRef = useRef<AudioBufferSourceNode | null>(null);
  const avatarRendererRef = useRef<ReturnType<typeof createAvatarRenderer> | null>(null);
  const avatarControlEventDeduperRef = useRef(createAvatarControlEventDeduper());
  const avatarControlEventSeqRef = useRef(0);
  const setModelSelection = useCallback((nextModel: string): void => {
    modelSelectionRef.current = nextModel;
    setModel(nextModel);
  }, []);

  const latestAssistantText = useMemo(() => {
    for (let index = history.length - 1; index >= 0; index -= 1) {
      if (history[index].role === "assistant") {
        return String(history[index].content || "");
      }
    }
    return "";
  }, [history]);

  const presenceMood = useMemo(() => inferPresenceMood(latestAssistantText), [latestAssistantText]);
  const modelOptions = useMemo(
    () => [...new Set(availableModels.filter((entry) => String(entry || "").trim().length > 0))],
    [availableModels],
  );
  const ttsVoiceOptions = useMemo(
    () => ttsVoices.filter((voice) => String(voice.voice_id || "").trim().length > 0),
    [ttsVoices],
  );
  const panesSwapped = uiPreferences.chatSide === "left";
  const voiceStateToken = String(voiceState.state || "").trim().toLowerCase();
  const voicePickupActive =
    avatarPrefs.motion_profile !== "reduced" &&
    voiceStateToken.length > 0 &&
    !["stop", "idle", "inactive"].includes(voiceStateToken);
  const avatarRenderDecision = useMemo(
    () =>
      resolveAvatarRenderDecision({
        prefs: avatarPrefs,
        assetLoadFailed: avatarLoadFailed,
      }),
    [avatarLoadFailed, avatarPrefs],
  );
  const avatarAssetAllowed = avatarRenderDecision.assetPolicyAllowed;
  const hasAvatarAssetRef = avatarRenderDecision.hasAssetRef;
  const avatarFallbackActive = avatarRenderDecision.fallbackActive;
  const avatarPrimaryState = useMemo(
    () =>
      deriveAvatarPrimaryState({
        playbackActive: ttsSpeaking,
        voiceCaptureActive: voicePickupActive,
        requestInFlight: sending,
      }),
    [sending, ttsSpeaking, voicePickupActive],
  );

  const updateUiPreferences = useCallback((patch: Partial<UiPreferences>): void => {
    setUiPreferences((current) => {
      const next: UiPreferences = { ...current, ...patch };
      persistUiPreferences(next);
      return next;
    });
  }, []);

  const updateAvatarPrefs = useCallback((patch: Partial<AvatarPrefsV1>): void => {
    setAvatarPrefs((current) => ({
      ...current,
      ...patch,
      version: "avatar_prefs_v1",
      fallback_policy: "always_safe",
    }));
  }, []);

  const dispatchAvatarControlEvent = useCallback(
    (type: string, payload: Record<string, unknown>): void => {
      avatarControlEventSeqRef.current += 1;
      const parsed = parseAvatarControlEventEnvelope({
        type,
        version: "avatar_event_v1",
        session_id: sessionId,
        ts: new Date().toISOString(),
        idempotency_key: `${type}:${sessionId}:${avatarControlEventSeqRef.current}`,
        payload,
      });
      if (!parsed.ok || !parsed.event) {
        console.warn("avatar.control_event_parse_failed", {
          type,
          error: parsed.error,
        });
        return;
      }
      if (!avatarControlEventDeduperRef.current.shouldProcess(parsed.event.idempotency_key)) {
        return;
      }
      try {
        avatarRendererRef.current?.applyControlEvent(parsed.event);
      } catch (error) {
        console.warn("avatar.control_event_apply_failed", {
          type: parsed.event.type,
          error: error instanceof Error ? error.message : "unknown_error",
        });
      }
    },
    [sessionId],
  );

  useEffect(() => {
    if (!initialAvatarPrefsLoad.migrationWarning) {
      return;
    }
    console.warn("avatar.settings_migration_failed", {
      warning: initialAvatarPrefsLoad.migrationWarning,
    });
  }, [initialAvatarPrefsLoad.migrationWarning]);

  useEffect(() => {
    persistAvatarPrefs(avatarPrefs);
  }, [avatarPrefs]);

  useEffect(() => {
    setAvatarLoadFailed(false);
  }, [avatarPrefs.asset_ref, avatarPrefs.mode, avatarPrefs.renderer]);

  useEffect(() => {
    let active = true;
    const renderer = createAvatarRenderer(avatarRenderDecision.rendererId);
    avatarRendererRef.current = renderer;
    void (async () => {
      try {
        await renderer.init();
        await renderer.loadAsset(avatarRenderDecision.renderAssetRef);
      } catch (error) {
        if (!active) {
          return;
        }
        setAvatarLoadFailed(true);
        console.warn("avatar.renderer_init_failed", {
          renderer_id: renderer.id,
          error: error instanceof Error ? error.message : "unknown_error",
        });
      }
    })();
    return () => {
      active = false;
      if (avatarRendererRef.current === renderer) {
        avatarRendererRef.current = null;
      }
      void renderer.dispose().catch(() => undefined);
    };
  }, [avatarRenderDecision.renderAssetRef, avatarRenderDecision.rendererId]);

  useEffect(() => {
    const renderer = avatarRendererRef.current;
    if (!renderer) {
      return;
    }
    try {
      renderer.applyState({
        primary_state: avatarPrimaryState,
        motion_profile: avatarPrefs.motion_profile,
        mouth_open: avatarPrimaryState === "speaking" ? 1 : 0,
        fallback_active: avatarFallbackActive,
        asset_ref: avatarRenderDecision.renderAssetRef,
      });
    } catch (error) {
      setAvatarLoadFailed(true);
      console.warn("avatar.renderer_apply_state_failed", {
        renderer_id: renderer.id,
        error: error instanceof Error ? error.message : "unknown_error",
      });
    }
  }, [
    avatarFallbackActive,
    avatarPrefs.motion_profile,
    avatarPrimaryState,
    avatarRenderDecision.renderAssetRef,
  ]);

  const stopAudioPlayback = useCallback((): void => {
    const source = audioSourceRef.current;
    if (source) {
      try {
        source.stop();
      } catch {
        // Best effort stop on already-completed nodes.
      }
      source.disconnect();
      audioSourceRef.current = null;
    }
    setTtsSpeaking(false);
  }, []);

  const ensureAudioContext = useCallback((): AudioContext => {
    if (audioContextRef.current) {
      return audioContextRef.current;
    }
    const ctor =
      (window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext })
        .AudioContext ||
      (window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!ctor) {
      throw new Error("Audio playback is unavailable in this browser.");
    }
    const created = new ctor();
    audioContextRef.current = created;
    return created;
  }, []);

  const refreshStatus = useCallback(async (): Promise<void> => {
    const payload = await api.status();
    setStatus(payload);
  }, [api]);

  const refreshVoice = useCallback(async (): Promise<void> => {
    const payload = await api.voiceState();
    setVoiceState(payload);
    setConfig((current) => ({
      ...current,
      voice: {
        ...current.voice,
        silence_delay_sec: safeDelay(
          payload.silence_delay_sec,
          current.voice.silence_delay_min_sec,
          current.voice.silence_delay_max_sec,
        ),
      },
    }));
  }, [api]);

  const refreshVoices = useCallback(async (): Promise<void> => {
    const payload = await api.voiceVoices();
    const available = (payload.voices || []).filter((voice) => String(voice.voice_id || "").trim().length > 0);
    setTtsVoices(available);
    setSelectedVoiceId((current) => {
      if (current && available.some((voice) => voice.voice_id === current)) {
        return current;
      }
      if (payload.default_voice_id && available.some((voice) => voice.voice_id === payload.default_voice_id)) {
        return payload.default_voice_id;
      }
      return available[0]?.voice_id || "";
    });
  }, [api]);

  const refreshConfig = useCallback(async (): Promise<void> => {
    const payload = await api.getConfig(sessionId);
    setConfig(payload.config);
  }, [api, sessionId]);

  const refreshHistory = useCallback(async (): Promise<void> => {
    const payload = await api.history(sessionId, 40);
    setHistory(payload.history || []);
  }, [api, sessionId]);

  const fetchAndCacheModelCatalog = useCallback(
    async (targetProvider: CompanionProvider): Promise<ModelCatalogCacheEntry> => {
      const payload = await api.models(targetProvider);
      const models = normalizeModelCatalogEntries(payload.models || []);
      const defaultToken = String(payload.default_model || "").trim();
      const resolvedModels =
        models.length > 0
          ? models
          : targetProvider === "ollama"
            ? [DEFAULT_MODEL]
            : defaultToken
              ? [defaultToken]
              : [];
      const resolvedDefaultModel = chooseCatalogModel(targetProvider, resolvedModels, "", defaultToken);
      const entry: ModelCatalogCacheEntry = {
        models: resolvedModels,
        defaultModel: resolvedDefaultModel,
        updatedAt: Date.now(),
      };
      modelCatalogCacheRef.current[targetProvider] = entry;
      persistModelCatalogCache(modelCatalogCacheRef.current);
      return entry;
    },
    [api],
  );

  const refreshModelCatalog = useCallback(
    async (nextProvider: CompanionProvider, keepSelection: boolean): Promise<void> => {
      const requestSeq = (modelCatalogRequestSeqRef.current[nextProvider] || 0) + 1;
      modelCatalogRequestSeqRef.current[nextProvider] = requestSeq;
      const previousSelection = keepSelection ? modelSelectionRef.current : "";
      const cachedEntry = modelCatalogCacheRef.current[nextProvider];
      const cachedModels = normalizeModelCatalogEntries(cachedEntry?.models || []);
      const immediateModels =
        cachedModels.length > 0
          ? cachedModels
          : nextProvider === "ollama"
            ? [DEFAULT_MODEL]
            : previousSelection
              ? [previousSelection]
              : [];
      const immediateDefault = cachedEntry?.defaultModel || "";
      setAvailableModels(immediateModels);
      setModelSelection(chooseCatalogModel(nextProvider, immediateModels, previousSelection, immediateDefault));
      try {
        const freshEntry = await fetchAndCacheModelCatalog(nextProvider);
        if (modelCatalogRequestSeqRef.current[nextProvider] !== requestSeq) {
          return;
        }
        const resolvedModels = freshEntry.models.length > 0 ? freshEntry.models : immediateModels;
        setAvailableModels(resolvedModels);
        setModelSelection(chooseCatalogModel(nextProvider, resolvedModels, previousSelection, freshEntry.defaultModel));
      } catch {
        if (modelCatalogRequestSeqRef.current[nextProvider] !== requestSeq) {
          return;
        }
        // Keep immediate cached fallback in place.
      }
    },
    [fetchAndCacheModelCatalog, setModelSelection],
  );

  const refreshAll = useCallback(async (): Promise<void> => {
    try {
      await Promise.all([
        refreshStatus(),
        refreshConfig(),
        refreshHistory(),
        refreshVoice(),
        refreshVoices(),
        refreshModelCatalog(provider, true),
      ]);
      setNotice("Synced with host.");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to refresh host state.";
      setNotice(`Refresh error: ${message}`);
    }
  }, [provider, refreshConfig, refreshHistory, refreshModelCatalog, refreshStatus, refreshVoice, refreshVoices]);

  useEffect(() => {
    const persisted = readPersistedModelCatalogCache();
    const merged: ModelCatalogCache = {
      ...modelCatalogCacheRef.current,
      ...persisted,
      ollama: persisted.ollama
        ? {
            models: persisted.ollama.models.length > 0 ? persisted.ollama.models : [DEFAULT_MODEL],
            defaultModel: persisted.ollama.defaultModel || DEFAULT_MODEL,
            updatedAt: persisted.ollama.updatedAt,
          }
        : modelCatalogCacheRef.current.ollama,
    };
    modelCatalogCacheRef.current = merged;
    const startupEntry = merged[provider];
    if (startupEntry.models.length > 0) {
      setAvailableModels(startupEntry.models);
      const startupModel = chooseCatalogModel(
        provider,
        startupEntry.models,
        modelSelectionRef.current,
        startupEntry.defaultModel,
      );
      setModelSelection(startupModel);
    }
  }, [setModelSelection]);

  useEffect(() => {
    void refreshAll();
    const timer = window.setInterval(() => {
      void refreshStatus();
      void refreshVoice();
    }, 9000);
    return () => window.clearInterval(timer);
  }, [refreshAll, refreshStatus, refreshVoice]);

  useEffect(() => {
    return () => {
      stopAudioPlayback();
      const context = audioContextRef.current;
      audioContextRef.current = null;
      if (context) {
        void context.close().catch(() => undefined);
      }
    };
  }, [stopAudioPlayback]);

  useEffect(() => {
    if (!didInitialModelRefreshRef.current) {
      didInitialModelRefreshRef.current = true;
      return;
    }
    void refreshModelCatalog(provider, true);
  }, [provider, refreshModelCatalog]);

  useEffect(() => {
    void Promise.all(
      PROVIDER_OPTIONS.map(async ({ value }) => {
        const cachedEntry = modelCatalogCacheRef.current[value];
        if (cachedEntry.updatedAt > 0 && Date.now() - cachedEntry.updatedAt < MODEL_CACHE_TTL_MS) {
          return;
        }
        try {
          await fetchAndCacheModelCatalog(value);
        } catch {
          // Background prefetch is best-effort.
        }
      }),
    );
  }, [fetchAndCacheModelCatalog]);

  const applySettings = useCallback(
    async (scope: CompanionConfigScope): Promise<void> => {
      const payload = await api.updateConfig({
        session_id: sessionId,
        scope,
        patch: {
          mode: {
            role_id: config.mode.role_id,
            relationship_style: config.mode.relationship_style,
            custom_style:
              config.mode.relationship_style === "custom"
                ? config.mode.custom_style ?? {}
                : null,
          },
          memory: {
            session_memory_enabled: config.memory.session_memory_enabled,
            profile_memory_enabled: config.memory.profile_memory_enabled,
            episodic_memory_enabled: config.memory.episodic_memory_enabled,
          },
          voice: {
            silence_delay_sec: safeDelay(
              config.voice.silence_delay_sec,
              config.voice.silence_delay_min_sec,
              config.voice.silence_delay_max_sec,
            ),
          },
        },
      });
      setConfig(payload.config);
      if (scope === "profile") {
        setNotice("Saved current settings as profile defaults.");
      } else if (scope === "session") {
        setNotice("Applied settings to the current chat.");
      } else {
        setNotice("Queued settings for the next turn.");
      }
    },
    [api, config, sessionId],
  );

  const speakText = useCallback(
    async (text: string, emotionHintOverride: string = presenceMood): Promise<void> => {
      const normalized = String(text || "").trim();
      if (!normalized) {
        setNotice("Nothing to speak yet.");
        return;
      }
      try {
        setTtsSpeaking(true);
        const payload = await api.voiceSynthesize(normalized, selectedVoiceId || "", emotionHintOverride, 1.0);
        if (!payload.ok || !payload.audio_b64) {
          setTtsSpeaking(false);
          const failureMessage = payload.error_message || "No TTS backend configured.";
          setNotice(`TTS unavailable: ${failureMessage}`);
          return;
        }
        const context = ensureAudioContext();
        if (context.state === "suspended") {
          await context.resume();
        }
        const buffer = createAudioBufferFromPcm16Le(
          context,
          payload.audio_b64,
          Number(payload.sample_rate || 22050),
          Number(payload.channels || 1),
        );
        stopAudioPlayback();
        const source = context.createBufferSource();
        source.buffer = buffer;
        source.connect(context.destination);
        source.onended = () => {
          if (audioSourceRef.current === source) {
            audioSourceRef.current = null;
            setTtsSpeaking(false);
            dispatchAvatarControlEvent("speech.end", { source: "tts_playback" });
          }
        };
        audioSourceRef.current = source;
        setTtsSpeaking(true);
        dispatchAvatarControlEvent("speech.start", { source: "tts_playback" });
        source.start(0);
        setNotice(`Speaking with ${payload.voice_id || "default voice"}.`);
      } catch (error) {
        setTtsSpeaking(false);
        const detail = error instanceof Error ? error.message : "TTS request failed.";
        setNotice(`TTS error: ${detail}`);
      }
    },
    [api, dispatchAvatarControlEvent, ensureAudioContext, presenceMood, selectedVoiceId, stopAudioPlayback],
  );

  const handleChatSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>): Promise<void> => {
      event.preventDefault();
      const message = chatDraft.trim();
      if (!message || sending) {
        return;
      }
      setSending(true);
      setChatDraft("");
      setHistory((current) => [...current, { role: "user", content: message }]);
      try {
        await applySettings("session");
        const payload = await api.chat({
          session_id: sessionId,
          message,
          provider,
          model,
        });
        const assistantMessage = String(payload.message || "");
        setHistory((current) => [...current, { role: "assistant", content: assistantMessage }]);
        if (payload.config) {
          setConfig(payload.config);
        }
        if (uiPreferences.autoSpeakReplies && assistantMessage.trim()) {
          void speakText(assistantMessage, inferPresenceMood(assistantMessage));
        }
        setNotice(
          payload.text_only_degraded
            ? `Voice capture unavailable. Reply generated in ${payload.latency_ms}ms.`
            : `Reply generated in ${payload.latency_ms}ms.`,
        );
      } catch (error) {
        const detail = error instanceof Error ? error.message : "Chat request failed.";
        setNotice(`Chat error: ${detail}`);
      } finally {
        setSending(false);
        window.requestAnimationFrame(() => composerRef.current?.focus());
      }
    },
    [api, applySettings, chatDraft, model, provider, sending, sessionId, speakText, uiPreferences.autoSpeakReplies],
  );

  const runVoiceCommand = useCallback(
    async (command: VoiceCommand): Promise<void> => {
      try {
        const payload = await api.voiceControl(command, config.voice.silence_delay_sec);
        setVoiceState({
          ok: payload.ok,
          state: payload.state,
          silence_delay_sec: config.voice.silence_delay_sec,
        });
        if (payload.error_code) {
          setNotice(`Voice ${command}: ${payload.error_code} ${payload.error_message}`.trim());
          return;
        }
        if (payload.state === "start") {
          dispatchAvatarControlEvent("speech.start", { source: "voice_control" });
        } else if (payload.state === "stop") {
          dispatchAvatarControlEvent("speech.end", { source: "voice_control" });
        }
        setNotice(`Voice command '${command}' applied. State is now ${humanizeState(payload.state)}.`);
      } catch (error) {
        const detail = error instanceof Error ? error.message : "Voice request failed.";
        setNotice(`Voice error: ${detail}`);
      }
    },
    [api, config.voice.silence_delay_sec, dispatchAvatarControlEvent],
  );

  const speakLatestAssistantReply = useCallback(async (): Promise<void> => {
    await speakText(latestAssistantText);
  }, [latestAssistantText, speakText]);

  const clearSessionMemory = useCallback(async (): Promise<void> => {
    try {
      const payload = await api.clearSessionMemory(sessionId);
      setHistory([]);
      setNotice(`Cleared chat memory (${payload.deleted_records} records).`);
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Chat memory clear failed.";
      setNotice(`Clear memory error: ${detail}`);
    }
  }, [api, sessionId]);

  const sttUnavailable = Boolean(status?.text_only_degraded || (status && !status.stt_available));

  const statusToneClass = sttUnavailable ? styles.statusBadgeDegraded : styles.statusBadgeReady;

  return (
    <div className={styles.appShell} data-font-personality={fontPersonality}>
      <main className={styles.mainGrid}>
        {panesSwapped ? (
          <ChatPanel
            chatDraft={chatDraft}
            sending={sending}
            history={history}
            onChatDraftChange={setChatDraft}
            onSubmit={handleChatSubmit}
            composerRef={composerRef}
          />
        ) : (
          <PresencePanel
            mood={presenceMood}
            sttUnavailable={sttUnavailable}
            voiceState={voiceState.state}
            avatarMode={avatarPrefs.mode}
            motionProfile={avatarPrefs.motion_profile}
            avatarRenderAssetRef={avatarRenderDecision.renderAssetRef}
            avatarFallbackActive={avatarFallbackActive}
            avatarFallbackReason={avatarRenderDecision.fallbackReason}
            avatarPrimaryState={avatarPrimaryState}
            onAvatarError={() => setAvatarLoadFailed(true)}
          />
        )}

        {panesSwapped ? (
          <PresencePanel
            mood={presenceMood}
            sttUnavailable={sttUnavailable}
            voiceState={voiceState.state}
            avatarMode={avatarPrefs.mode}
            motionProfile={avatarPrefs.motion_profile}
            avatarRenderAssetRef={avatarRenderDecision.renderAssetRef}
            avatarFallbackActive={avatarFallbackActive}
            avatarFallbackReason={avatarRenderDecision.fallbackReason}
            avatarPrimaryState={avatarPrimaryState}
            onAvatarError={() => setAvatarLoadFailed(true)}
          />
        ) : (
          <ChatPanel
            chatDraft={chatDraft}
            sending={sending}
            history={history}
            onChatDraftChange={setChatDraft}
            onSubmit={handleChatSubmit}
            composerRef={composerRef}
          />
        )}
      </main>

      <section className={`${styles.controlTray} ${trayOpen ? styles.controlTrayOpen : ""}`}>
        <button
          type="button"
          className={styles.trayToggle}
          aria-label={trayOpen ? "Close controls" : "Open controls"}
          onClick={() => setTrayOpen((current) => !current)}
        >
          <span className={styles.trayGrip} aria-hidden="true" />
          <ChevronDown className={styles.trayToggleIcon} size={14} aria-hidden="true" />
        </button>

        <div className={styles.trayBody}>
          <div className={styles.noticeBar}>{notice}</div>
          <Accordion.Root className={styles.accordionRoot} type="multiple" defaultValue={["settings", "voice", "status"]}>
          <Accordion.Item className={styles.accordionItem} value="settings">
            <Accordion.Header>
              <Accordion.Trigger className={styles.accordionTrigger}>
                <span className={styles.triggerLabel}>
                  <Save size={16} aria-hidden="true" />
                  Companion Settings
                </span>
                <ChevronDown className={styles.triggerIcon} size={16} aria-hidden="true" />
              </Accordion.Trigger>
            </Accordion.Header>
            <Accordion.Content className={styles.accordionContent}>
              <div className={styles.accordionInner}>
                <label className={styles.fieldLabel} htmlFor="provider-id">
                  Provider
                </label>
                <select
                  id="provider-id"
                  className={`${styles.selectInput} ${styles.compactSelect}`}
                  value={provider}
                  onChange={(event) => setProvider(event.target.value as CompanionProvider)}
                >
                  {PROVIDER_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>

                <label className={styles.fieldLabel} htmlFor="model-id">
                  Model
                </label>
                <select
                  id="model-id"
                  className={`${styles.selectInput} ${styles.compactSelect}`}
                  value={model || ""}
                  onChange={(event) => setModelSelection(event.target.value)}
                >
                  {modelOptions.length === 0 ? (
                    <option value="">No models detected</option>
                  ) : (
                    modelOptions.map((entry) => (
                      <option key={entry} value={entry}>
                        {entry}
                      </option>
                    ))
                  )}
                </select>

                <label className={styles.fieldLabel} htmlFor="role-id">
                  Companion Role
                </label>
                <select
                  id="role-id"
                  className={`${styles.selectInput} ${styles.compactSelect}`}
                  value={config.mode.role_id}
                  onChange={(event) =>
                    setConfig((current) => ({
                      ...current,
                      mode: {
                        ...current.mode,
                        role_id: event.target.value,
                      },
                    }))
                  }
                >
                  {ROLE_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>

                <label className={styles.fieldLabel} htmlFor="style-id">
                  Relationship Style
                </label>
                <select
                  id="style-id"
                  className={`${styles.selectInput} ${styles.compactSelect}`}
                  value={config.mode.relationship_style}
                  onChange={(event) =>
                    setConfig((current) => ({
                      ...current,
                      mode: {
                        ...current.mode,
                        relationship_style: event.target.value,
                      },
                    }))
                  }
                >
                  {STYLE_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value} disabled={Boolean(option.disabled)}>
                      {option.label}
                    </option>
                  ))}
                </select>

                <label className={styles.fieldLabel} htmlFor="font-personality">
                  Font Personality
                </label>
                <select
                  id="font-personality"
                  className={`${styles.selectInput} ${styles.compactSelect}`}
                  value={fontPersonality}
                  onChange={(event) => setFontPersonality(event.target.value as FontPersonality)}
                >
                  {FONT_PERSONALITIES.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>

                <label className={styles.fieldLabel} htmlFor="chat-side">
                  Chat Side
                </label>
                <select
                  id="chat-side"
                  className={`${styles.selectInput} ${styles.compactSelect}`}
                  value={uiPreferences.chatSide}
                  onChange={(event) => updateUiPreferences({ chatSide: event.target.value as ChatSide })}
                >
                  <option value="right">Right</option>
                  <option value="left">Left</option>
                </select>

                <label className={styles.fieldLabel} htmlFor="avatar-mode">
                  Avatar Mode
                </label>
                <select
                  id="avatar-mode"
                  className={`${styles.selectInput} ${styles.compactSelect}`}
                  value={avatarPrefs.mode}
                  onChange={(event) => {
                    const nextMode = event.target.value as AvatarPrefsV1["mode"];
                    updateAvatarPrefs({
                      mode: nextMode,
                      renderer: nextMode === "avatar" ? avatarPrefs.renderer : "fallback",
                    });
                  }}
                >
                  <option value="off">Off</option>
                  <option value="fallback">Fallback</option>
                  <option value="avatar">Avatar</option>
                </select>

                <label className={styles.fieldLabel} htmlFor="avatar-renderer">
                  Avatar Renderer
                </label>
                <select
                  id="avatar-renderer"
                  className={`${styles.selectInput} ${styles.compactSelect}`}
                  value={avatarPrefs.renderer}
                  onChange={(event) => updateAvatarPrefs({ renderer: event.target.value as AvatarPrefsV1["renderer"] })}
                >
                  <option value="fallback">Fallback</option>
                  <option value="vrm">VRM</option>
                </select>

                <label className={styles.fieldLabel} htmlFor="avatar-motion-profile">
                  Motion Profile
                </label>
                <select
                  id="avatar-motion-profile"
                  className={`${styles.selectInput} ${styles.compactSelect}`}
                  value={avatarPrefs.motion_profile}
                  onChange={(event) =>
                    updateAvatarPrefs({ motion_profile: event.target.value as AvatarPrefsV1["motion_profile"] })
                  }
                >
                  <option value="default">Default</option>
                  <option value="reduced">Reduced</option>
                </select>

                <label className={styles.fieldLabel} htmlFor="avatar-asset-ref">
                  Avatar Asset Ref (local)
                </label>
                <input
                  id="avatar-asset-ref"
                  className={styles.textInput}
                  placeholder="assets/avatar.png"
                  value={avatarPrefs.asset_ref || ""}
                  onChange={(event) => {
                    const nextRef = String(event.target.value || "").trim();
                    updateAvatarPrefs({ asset_ref: nextRef ? nextRef : null });
                  }}
                />
                <p className={styles.helperText}>
                  Remote URLs are blocked. Companion always fails closed to fallback if asset policy is violated.
                </p>
                {!avatarAssetAllowed && hasAvatarAssetRef ? (
                  <p className={styles.helperText}>Remote avatar assets are disabled for this lane.</p>
                ) : null}

                <div className={styles.inlineButtons}>
                  <button type="button" className={styles.primaryButton} onClick={() => void applySettings("session")}>
                    <Save size={16} aria-hidden="true" />
                    Apply to Chat
                  </button>
                  <button type="button" className={styles.secondaryButton} onClick={() => void applySettings("profile")}>
                    <Save size={16} aria-hidden="true" />
                    Save Profile
                  </button>
                  <button type="button" className={styles.ghostButton} onClick={() => void refreshModelCatalog(provider, false)}>
                    Refresh Models
                  </button>
                </div>
              </div>
            </Accordion.Content>
          </Accordion.Item>

          <Accordion.Item className={styles.accordionItem} value="voice">
            <Accordion.Header>
              <Accordion.Trigger className={styles.accordionTrigger}>
                <span className={styles.triggerLabel}>
                  <AudioLines size={16} aria-hidden="true" />
                  Voice Controls
                </span>
                <ChevronDown className={styles.triggerIcon} size={16} aria-hidden="true" />
              </Accordion.Trigger>
            </Accordion.Header>
            <Accordion.Content className={styles.accordionContent}>
              <div className={styles.accordionInner}>
                <div className={styles.controlRow}>
                  <span className={styles.controlTitle}>Silence Delay</span>
                  <span className={styles.rangeValue}>{config.voice.silence_delay_sec.toFixed(1)}s</span>
                </div>
                <input
                  className={styles.rangeInput}
                  type="range"
                  min={config.voice.silence_delay_min_sec}
                  max={config.voice.silence_delay_max_sec}
                  step={0.1}
                  value={config.voice.silence_delay_sec}
                  onChange={(event) =>
                    setConfig((current) => ({
                      ...current,
                      voice: {
                        ...current.voice,
                        silence_delay_sec: Number(event.target.value),
                      },
                    }))
                  }
                />
                <p className={styles.helperText}>Text submission always remains explicit and unaffected by voice timing.</p>

                <label className={styles.fieldLabel} htmlFor="voice-id">
                  Voice
                </label>
                <select
                  id="voice-id"
                  className={`${styles.selectInput} ${styles.compactSelect}`}
                  value={selectedVoiceId}
                  onChange={(event) => setSelectedVoiceId(event.target.value)}
                >
                  {ttsVoiceOptions.length === 0 ? (
                    <option value="">No voices detected</option>
                  ) : (
                    ttsVoiceOptions.map((voice) => (
                      <option key={voice.voice_id} value={voice.voice_id}>
                        {voice.display_name || voice.voice_id}
                      </option>
                    ))
                  )}
                </select>

                <div className={styles.inlineButtons}>
                  <button type="button" className={styles.secondaryButton} onClick={() => void runVoiceCommand("start")}>
                    <Mic size={16} aria-hidden="true" />
                    Start
                  </button>
                  <button type="button" className={styles.secondaryButton} onClick={() => void runVoiceCommand("submit")}>
                    <SendHorizonal size={16} aria-hidden="true" />
                    Submit
                  </button>
                  <button type="button" className={styles.secondaryButton} onClick={() => void runVoiceCommand("stop")}>
                    <MicOff size={16} aria-hidden="true" />
                    Stop
                  </button>
                </div>
                <div className={styles.inlineButtons}>
                  <button
                    type="button"
                    className={styles.secondaryButton}
                    disabled={!latestAssistantText.trim() || ttsVoiceOptions.length === 0}
                    onClick={() => void speakLatestAssistantReply()}
                  >
                    <AudioLines size={16} aria-hidden="true" />
                    Speak Last Reply
                  </button>
                  <button
                    type="button"
                    className={styles.ghostButton}
                    disabled={!ttsSpeaking}
                    onClick={stopAudioPlayback}
                  >
                    Stop Playback
                  </button>
                </div>
                <ToggleRow
                  label="Auto-speak replies"
                  hint="Speak each new Companion reply automatically."
                  checked={uiPreferences.autoSpeakReplies}
                  onCheckedChange={(next) => updateUiPreferences({ autoSpeakReplies: next })}
                />
                <p className={styles.helperText}>Current voice state: {humanizeState(voiceState.state)}</p>
                <p className={styles.helperText}>
                  TTS: {status?.tts_available ? "available" : "unavailable"} {ttsSpeaking ? " | speaking" : ""}
                </p>
              </div>
            </Accordion.Content>
          </Accordion.Item>

          <Accordion.Item className={styles.accordionItem} value="memory">
            <Accordion.Header>
              <Accordion.Trigger className={styles.accordionTrigger}>
                <span className={styles.triggerLabel}>
                  <Brain size={16} aria-hidden="true" />
                  Memory Controls
                </span>
                <ChevronDown className={styles.triggerIcon} size={16} aria-hidden="true" />
              </Accordion.Trigger>
            </Accordion.Header>
            <Accordion.Content className={styles.accordionContent}>
              <div className={styles.accordionInner}>
                <ToggleRow
                  label="Chat memory"
                  hint="Turn memory in this chat on or off."
                  checked={config.memory.session_memory_enabled}
                  onCheckedChange={(next) =>
                    setConfig((current) => ({
                      ...current,
                      memory: { ...current.memory, session_memory_enabled: next },
                    }))
                  }
                />
                <ToggleRow
                  label="Profile memory"
                  hint="Persist preferences as profile defaults."
                  checked={config.memory.profile_memory_enabled}
                  onCheckedChange={(next) =>
                    setConfig((current) => ({
                      ...current,
                      memory: { ...current.memory, profile_memory_enabled: next },
                    }))
                  }
                />
                <div className={styles.inlineButtons}>
                  <button type="button" className={styles.secondaryButton} onClick={() => void clearSessionMemory()}>
                    <RotateCcw size={16} aria-hidden="true" />
                    Clear Chat Memory
                  </button>
                </div>
              </div>
            </Accordion.Content>
          </Accordion.Item>

          <Accordion.Item className={styles.accordionItem} value="status">
            <Accordion.Header>
              <Accordion.Trigger className={styles.accordionTrigger}>
                <span className={styles.triggerLabel}>
                  <Waves size={16} aria-hidden="true" />
                  Status
                </span>
                <ChevronDown className={styles.triggerIcon} size={16} aria-hidden="true" />
              </Accordion.Trigger>
            </Accordion.Header>
            <Accordion.Content className={styles.accordionContent}>
              <div className={styles.accordionInner}>
                <div className={styles.statusGrid}>
                  <div className={styles.statusItem}>
                    <span className={styles.statusLabel}>STT</span>
                    <span className={statusToneClass}>{status?.stt_available ? "available" : "unavailable"}</span>
                  </div>
                  <div className={styles.statusItem}>
                    <span className={styles.statusLabel}>TTS</span>
                    <span className={status?.tts_available ? styles.statusBadgeReady : styles.statusBadgeDegraded}>
                      {status?.tts_available ? "available" : "unavailable"}
                    </span>
                  </div>
                  <div className={styles.statusItem}>
                    <span className={styles.statusLabel}>Voice State</span>
                    <span className={styles.statusValue}>{humanizeState(voiceState.state)}</span>
                  </div>
                  <div className={styles.statusItem}>
                    <span className={styles.statusLabel}>Provider</span>
                    <span className={styles.statusValue}>{provider}</span>
                  </div>
                  <div className={styles.statusItem}>
                    <span className={styles.statusLabel}>Model</span>
                    <span className={styles.statusValue}>{model || "(none)"}</span>
                  </div>
                  <div className={styles.statusItem}>
                    <span className={styles.statusLabel}>Model Path</span>
                    <span className={styles.statusValue}>{status?.model_available ? "ready" : "degraded"}</span>
                  </div>
                  <div className={styles.statusItem}>
                    <span className={styles.statusLabel}>Active Chats</span>
                    <span className={styles.statusValue}>{status?.active_sessions ?? 0}</span>
                  </div>
                </div>
                <p className={styles.helperText}>
                  {sttUnavailable
                    ? "STT is unavailable, so Companion stays in explicit text mode."
                    : "STT is available. Voice remains optional and user-controlled."}
                </p>
              </div>
            </Accordion.Content>
          </Accordion.Item>
          </Accordion.Root>
        </div>
        <VoicePickupWave active={voicePickupActive} />
      </section>
    </div>
  );
}

interface ChatPanelProps {
  history: HistoryRow[];
  chatDraft: string;
  sending: boolean;
  onChatDraftChange: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  composerRef: React.RefObject<HTMLTextAreaElement>;
}

function ChatPanel({
  history,
  chatDraft,
  sending,
  onChatDraftChange,
  onSubmit,
  composerRef,
}: ChatPanelProps): JSX.Element {
  const messageListRef = useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = useRef(true);
  const STICKY_BOTTOM_EPSILON_PX = 28;

  const updateStickiness = useCallback((): void => {
    const container = messageListRef.current;
    if (!container) {
      return;
    }
    const distanceFromBottom = container.scrollHeight - (container.scrollTop + container.clientHeight);
    stickToBottomRef.current = distanceFromBottom <= STICKY_BOTTOM_EPSILON_PX;
  }, []);

  useLayoutEffect(() => {
    const container = messageListRef.current;
    if (!container) {
      return;
    }
    if (stickToBottomRef.current) {
      container.scrollTop = container.scrollHeight;
    }
  }, [history]);

  const onComposerKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
      if (event.key !== "Enter" || event.shiftKey) {
        return;
      }
      event.preventDefault();
      const form = event.currentTarget.form;
      if (!form) {
        return;
      }
      if (typeof form.requestSubmit === "function") {
        form.requestSubmit();
        return;
      }
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    },
    [],
  );

  return (
    <section className={styles.panelSurface}>
      <header className={styles.panelHeader}>
        <h2 className={styles.srOnly}>Chat</h2>
      </header>

      <div
        className={styles.messageList}
        data-testid="chat-message-list"
        ref={messageListRef}
        onScroll={updateStickiness}
      >
        {history.length === 0 ? <p className={styles.emptyState}>Start with a message whenever you are ready.</p> : null}
        {history.map((item, index) => {
          const isUser = item.role === "user";
          return (
            <article
              key={`${item.role}-${index}-${item.timestamp_utc || ""}`}
              className={`${styles.messageBubble} ${isUser ? styles.messageUser : styles.messageAssistant}`}
            >
              <span className={styles.roleTag}>{isUser ? "You" : "Companion"}</span>
              <p className={styles.messageText}>{item.content}</p>
            </article>
          );
        })}
      </div>

      <form className={styles.chatComposer} onSubmit={onSubmit}>
        <textarea
          ref={composerRef}
          className={styles.chatInput}
          rows={3}
          placeholder="Type your message and press Send"
          value={chatDraft}
          onChange={(event) => onChatDraftChange(event.target.value)}
          onKeyDown={onComposerKeyDown}
        />
        <button type="submit" className={styles.primaryButton} disabled={sending || !chatDraft.trim()}>
          <SendHorizonal size={16} aria-hidden="true" />
          {sending ? "Sending..." : "Send"}
        </button>
      </form>
    </section>
  );
}

interface PresencePanelProps {
  mood: PresenceMood;
  voiceState: string;
  sttUnavailable: boolean;
  avatarMode: AvatarPrefsV1["mode"];
  motionProfile: AvatarPrefsV1["motion_profile"];
  avatarRenderAssetRef: string | null;
  avatarFallbackActive: boolean;
  avatarFallbackReason: string;
  avatarPrimaryState: "idle" | "listening" | "thinking" | "speaking";
  onAvatarError: () => void;
}

function PresencePanel({
  mood,
  voiceState,
  sttUnavailable: _sttUnavailable,
  avatarMode,
  motionProfile,
  avatarRenderAssetRef,
  avatarFallbackActive,
  avatarFallbackReason,
  avatarPrimaryState,
  onAvatarError,
}: PresencePanelProps): JSX.Element {
  const normalizedAssetRef = String(avatarRenderAssetRef || "").trim();
  const avatarCanRenderVrmAsset = normalizedAssetRef.length > 0;

  return (
    <section className={styles.panelSurface}>
      <header className={styles.panelHeader}>
        <h2 className={styles.srOnly}>Presence</h2>
      </header>

      <div className={styles.presenceStage}>
        <div className={`${styles.avatarFrame} ${voiceState === "start" ? styles.avatarListening : ""}`}>
          {avatarCanRenderVrmAsset ? (
            <img
              alt="Companion avatar"
              className={styles.avatarImage}
              src={normalizedAssetRef}
              onError={onAvatarError}
            />
          ) : (
            <div className={styles.avatarFallback} data-testid="presence-avatar-fallback">
              <UserRound size={58} aria-hidden="true" />
            </div>
          )}
        </div>

        <div className={styles.moodChip}>
          <span className={styles.statusLabel}>{avatarPrimaryState}</span>
          <span className={styles.statusValue}>{mood}</span>
        </div>
        <p className={styles.helperText}>{avatarFallbackActive ? avatarFallbackReason : "Avatar asset loaded."}</p>
        {motionProfile === "reduced" ? (
          <p className={styles.helperText}>Reduced motion is enabled.</p>
        ) : null}
        {avatarMode === "off" ? <p className={styles.helperText}>Presence remains active in fallback mode.</p> : null}
      </div>
    </section>
  );
}

interface VoicePickupWaveProps {
  active: boolean;
}

function VoicePickupWave({ active }: VoicePickupWaveProps): JSX.Element {
  return (
    <div
      className={`${styles.voicePickupWave} ${active ? styles.voicePickupWaveActive : ""}`}
      data-active={active ? "true" : "false"}
      data-testid="voice-pickup-wave"
      aria-hidden="true"
    >
      {Array.from({ length: 8 }, (_, index) => (
        <span
          key={`wave-${index}`}
          className={styles.voicePickupBar}
          style={{ animationDelay: `${index * 90}ms` }}
        />
      ))}
    </div>
  );
}

interface ToggleRowProps {
  label: string;
  hint: string;
  checked: boolean;
  onCheckedChange: (next: boolean) => void;
}

function ToggleRow({ label, hint, checked, onCheckedChange }: ToggleRowProps): JSX.Element {
  return (
    <div className={styles.toggleRow}>
      <div>
        <div className={styles.controlTitle}>{label}</div>
        <div className={styles.helperText}>{hint}</div>
      </div>
      <Switch.Root
        className={styles.switchRoot}
        checked={checked}
        onCheckedChange={onCheckedChange}
        aria-label={label}
      >
        <Switch.Thumb className={styles.switchThumb} />
      </Switch.Root>
    </div>
  );
}

