export type AvatarObservabilityEventType =
  | "avatar.renderer_selected"
  | "avatar.asset_load_started"
  | "avatar.asset_load_succeeded"
  | "avatar.asset_load_failed"
  | "avatar.fallback_activated"
  | "avatar.state_changed"
  | "avatar.lipsync_started"
  | "avatar.lipsync_failed"
  | "avatar.lipsync_stopped";

export interface AvatarObservabilityEvent {
  type: AvatarObservabilityEventType;
  ts: string;
  payload: Record<string, unknown>;
}

export interface AvatarObservabilityEmitOptions {
  rateLimitKey?: string;
}

export interface AvatarObservability {
  emit: (
    type: AvatarObservabilityEventType,
    payload?: Record<string, unknown>,
    options?: AvatarObservabilityEmitOptions,
  ) => void;
}

interface AvatarObservabilityOptions {
  warningCooldownMs?: number;
  sink?: (event: AvatarObservabilityEvent) => void;
  now?: () => number;
}

function isWindowAvailable(): boolean {
  return typeof window !== "undefined";
}

function defaultSink(event: AvatarObservabilityEvent): void {
  if (isWindowAvailable()) {
    const diagnosticsWindow = window as unknown as {
      __COMPANION_AVATAR_EVENTS__?: AvatarObservabilityEvent[];
    };
    if (!Array.isArray(diagnosticsWindow.__COMPANION_AVATAR_EVENTS__)) {
      diagnosticsWindow.__COMPANION_AVATAR_EVENTS__ = [];
    }
    diagnosticsWindow.__COMPANION_AVATAR_EVENTS__.push(event);
  }
  const isTestEnv =
    typeof process !== "undefined" &&
    typeof process.env === "object" &&
    String(process.env.NODE_ENV || "").toLowerCase() === "test";
  if (typeof console !== "undefined" && !isTestEnv) {
    console.debug(event.type, event.payload);
  }
}

export function createAvatarObservability(options: AvatarObservabilityOptions = {}): AvatarObservability {
  const warningCooldownMs = Math.max(1000, Math.floor(options.warningCooldownMs ?? 4000));
  const sink = options.sink || defaultSink;
  const now = options.now || (() => Date.now());
  const rateLimitRegistry = new Map<string, number>();

  return {
    emit(type, payload = {}, emitOptions = {}): void {
      const rateLimitKey = String(emitOptions.rateLimitKey || "").trim();
      if (rateLimitKey) {
        const currentNow = now();
        const previousTs = rateLimitRegistry.get(rateLimitKey);
        if (typeof previousTs === "number" && currentNow - previousTs < warningCooldownMs) {
          return;
        }
        rateLimitRegistry.set(rateLimitKey, currentNow);
      }
      sink({
        type,
        ts: new Date(now()).toISOString(),
        payload: { ...payload },
      });
    },
  };
}
