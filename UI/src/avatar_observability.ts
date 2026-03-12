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

const REDACTED_PAYLOAD_KEY_PATTERN =
  /(message|prompt|content|audio|token|secret|credential|authorization|api[_-]?key)/i;
const ASSET_IDENTIFIER_KEY_PATTERN = /(asset(_ref|_id)?)/i;

function isWindowAvailable(): boolean {
  return typeof window !== "undefined";
}

function isTestEnv(): boolean {
  return (
    typeof process !== "undefined" &&
    typeof process.env === "object" &&
    String(process.env.NODE_ENV || "").toLowerCase() === "test"
  );
}

function defaultSink(event: AvatarObservabilityEvent): void {
  if (isWindowAvailable() && isTestEnv()) {
    const diagnosticsWindow = window as unknown as {
      __COMPANION_AVATAR_EVENTS__?: AvatarObservabilityEvent[];
    };
    if (!Array.isArray(diagnosticsWindow.__COMPANION_AVATAR_EVENTS__)) {
      diagnosticsWindow.__COMPANION_AVATAR_EVENTS__ = [];
    }
    diagnosticsWindow.__COMPANION_AVATAR_EVENTS__.push(event);
  }
}

function sanitizeAssetIdentifier(value: string): string {
  const normalized = value.trim();
  if (!normalized) {
    return normalized;
  }
  const queryIndex = normalized.indexOf("?");
  const hashIndex = normalized.indexOf("#");
  const cutPositions = [queryIndex, hashIndex].filter((index) => index >= 0).sort((a, b) => a - b);
  if (cutPositions.length === 0) {
    return normalized;
  }
  return normalized.slice(0, cutPositions[0]);
}

function sanitizePayloadValue(key: string, value: unknown): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value === "string") {
    if (ASSET_IDENTIFIER_KEY_PATTERN.test(key)) {
      return sanitizeAssetIdentifier(value);
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => {
      if (entry && typeof entry === "object" && !Array.isArray(entry)) {
        return sanitizePayload(entry as Record<string, unknown>);
      }
      return entry;
    });
  }
  if (typeof value === "object") {
    return sanitizePayload(value as Record<string, unknown>);
  }
  return value;
}

function sanitizePayload(payload: Record<string, unknown>): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (REDACTED_PAYLOAD_KEY_PATTERN.test(key)) {
      continue;
    }
    sanitized[key] = sanitizePayloadValue(key, value);
  }
  return sanitized;
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
        payload: sanitizePayload(payload),
      });
    },
  };
}
