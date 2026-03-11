import type { AvatarControlEventEnvelopeV1 } from "./avatar_renderer";

export interface AvatarControlEventParseResult {
  ok: boolean;
  event: AvatarControlEventEnvelopeV1 | null;
  error: string | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

export function parseAvatarControlEventEnvelope(input: unknown): AvatarControlEventParseResult {
  const record = asRecord(input);
  if (!record) {
    return { ok: false, event: null, error: "avatar_event_payload_invalid" };
  }
  const type = String(record.type || "").trim();
  const version = String(record.version || "").trim();
  const sessionId = String(record.session_id || "").trim();
  const ts = String(record.ts || "").trim();
  const idempotencyKey = String(record.idempotency_key || "").trim();
  const payload = asRecord(record.payload);

  if (!type || !sessionId || !ts || !idempotencyKey || !payload) {
    return { ok: false, event: null, error: "avatar_event_required_fields_missing" };
  }
  if (version !== "avatar_event_v1") {
    return { ok: false, event: null, error: "avatar_event_version_unsupported" };
  }
  return {
    ok: true,
    event: {
      type,
      version: "avatar_event_v1",
      session_id: sessionId,
      ts,
      idempotency_key: idempotencyKey,
      payload,
    },
    error: null,
  };
}

export interface AvatarControlEventDeduper {
  shouldProcess: (idempotencyKey: string) => boolean;
}

export function createAvatarControlEventDeduper(maxKeys: number = 256): AvatarControlEventDeduper {
  const seenKeys = new Set<string>();
  const insertionOrder: string[] = [];
  return {
    shouldProcess(idempotencyKey: string): boolean {
      const normalized = String(idempotencyKey || "").trim();
      if (!normalized) {
        return false;
      }
      if (seenKeys.has(normalized)) {
        return false;
      }
      seenKeys.add(normalized);
      insertionOrder.push(normalized);
      while (insertionOrder.length > maxKeys) {
        const oldest = insertionOrder.shift();
        if (oldest) {
          seenKeys.delete(oldest);
        }
      }
      return true;
    },
  };
}
