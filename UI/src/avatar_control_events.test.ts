import { describe, expect, it } from "vitest";

import {
  createAvatarControlEventDeduper,
  parseAvatarControlEventEnvelope,
} from "./avatar_control_events";

describe("avatar_control_events", () => {
  it("Layer: contract. parses a valid avatar_event_v1 envelope.", () => {
    const parsed = parseAvatarControlEventEnvelope({
      type: "speech.start",
      version: "avatar_event_v1",
      session_id: "s-1",
      ts: "2026-03-11T00:00:00.000Z",
      idempotency_key: "k-1",
      payload: { source: "voice" },
    });
    expect(parsed.ok).toBe(true);
    expect(parsed.error).toBeNull();
    expect(parsed.event?.type).toBe("speech.start");
  });

  it("Layer: contract. fails closed on unsupported envelope versions.", () => {
    const parsed = parseAvatarControlEventEnvelope({
      type: "speech.start",
      version: "avatar_event_v2",
      session_id: "s-1",
      ts: "2026-03-11T00:00:00.000Z",
      idempotency_key: "k-1",
      payload: { source: "voice" },
    });
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toBe("avatar_event_version_unsupported");
  });

  it("Layer: contract. deduplicates idempotency keys and evicts older keys when full.", () => {
    const deduper = createAvatarControlEventDeduper(2);
    expect(deduper.shouldProcess("a")).toBe(true);
    expect(deduper.shouldProcess("a")).toBe(false);
    expect(deduper.shouldProcess("b")).toBe(true);
    expect(deduper.shouldProcess("c")).toBe(true);
    expect(deduper.shouldProcess("a")).toBe(true);
  });
});
