import { describe, expect, it, vi } from "vitest";

import { createAvatarObservability } from "./avatar_observability";

describe("avatar_observability", () => {
  it("Layer: contract. emits structured avatar events to the sink.", () => {
    const sink = vi.fn();
    const logger = createAvatarObservability({ sink });
    logger.emit("avatar.renderer_selected", { renderer_id: "fallback" });

    expect(sink).toHaveBeenCalledTimes(1);
    const event = sink.mock.calls[0][0];
    expect(event.type).toBe("avatar.renderer_selected");
    expect(event.payload.renderer_id).toBe("fallback");
    expect(typeof event.ts).toBe("string");
  });

  it("Layer: contract. rate-limits repeated non-fatal warnings by key.", () => {
    const sink = vi.fn();
    let nowValue = 1000;
    const logger = createAvatarObservability({
      sink,
      now: () => nowValue,
      warningCooldownMs: 3000,
    });

    logger.emit("avatar.asset_load_failed", { reason: "bad_asset" }, { rateLimitKey: "asset_load_failed:bad_asset" });
    logger.emit("avatar.asset_load_failed", { reason: "bad_asset" }, { rateLimitKey: "asset_load_failed:bad_asset" });
    expect(sink).toHaveBeenCalledTimes(1);

    nowValue += 3500;
    logger.emit("avatar.asset_load_failed", { reason: "bad_asset" }, { rateLimitKey: "asset_load_failed:bad_asset" });
    expect(sink).toHaveBeenCalledTimes(2);
  });

  it("Layer: contract. does not rate-limit events with different keys.", () => {
    const sink = vi.fn();
    const logger = createAvatarObservability({
      sink,
      now: () => 5000,
      warningCooldownMs: 3000,
    });

    logger.emit("avatar.asset_load_failed", { reason: "one" }, { rateLimitKey: "asset:one" });
    logger.emit("avatar.asset_load_failed", { reason: "two" }, { rateLimitKey: "asset:two" });
    expect(sink).toHaveBeenCalledTimes(2);
  });
});
