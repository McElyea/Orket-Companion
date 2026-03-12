import { describe, expect, it } from "vitest";

import {
  createAvatarRenderer,
  extractAvatarControlSignalUpdate,
  FallbackAvatarRenderer,
  resolveAvatarRenderDecision,
  VrmAvatarRenderer,
} from "./avatar_renderer";
import { createDefaultAvatarPrefs } from "./avatar_prefs";

describe("avatar_renderer", () => {
  it("Layer: contract. creates renderer instances from renderer ids.", () => {
    expect(createAvatarRenderer("fallback")).toBeInstanceOf(FallbackAvatarRenderer);
    expect(createAvatarRenderer("vrm")).toBeInstanceOf(VrmAvatarRenderer);
  });

  it("Layer: contract. resolves to VRM render path when avatar mode is enabled with local asset.", () => {
    const prefs = createDefaultAvatarPrefs();
    prefs.mode = "avatar";
    prefs.renderer = "vrm";
    prefs.asset_ref = "assets/local-avatar.png";
    const decision = resolveAvatarRenderDecision({
      prefs,
      assetLoadFailed: false,
    });
    expect(decision.fallbackActive).toBe(false);
    expect(decision.renderAssetRef).toBe("/static/assets/local-avatar.png");
    expect(decision.rendererId).toBe("vrm");
  });

  it("Layer: contract. fails closed to fallback when asset policy is violated.", () => {
    const prefs = createDefaultAvatarPrefs();
    prefs.mode = "avatar";
    prefs.renderer = "vrm";
    prefs.asset_ref = "https://example.com/remote-avatar.png";
    const decision = resolveAvatarRenderDecision({
      prefs,
      assetLoadFailed: false,
    });
    expect(decision.fallbackActive).toBe(true);
    expect(decision.renderAssetRef).toBeNull();
    expect(decision.assetPolicyAllowed).toBe(false);
    expect(decision.fallbackReason).toContain("disabled");
  });

  it("Layer: contract. fails closed to fallback when asset type is unsupported.", () => {
    const prefs = createDefaultAvatarPrefs();
    prefs.mode = "avatar";
    prefs.renderer = "vrm";
    prefs.asset_ref = "assets/avatar.exe";
    const decision = resolveAvatarRenderDecision({
      prefs,
      assetLoadFailed: false,
    });
    expect(decision.fallbackActive).toBe(true);
    expect(decision.renderAssetRef).toBeNull();
    expect(decision.assetPolicyAllowed).toBe(true);
    expect(decision.assetTypeAllowed).toBe(false);
    expect(decision.fallbackReason).toContain("Unsupported");
  });

  it("Layer: contract. maps supported control events to additive expression and gesture signals.", () => {
    const renderer = new VrmAvatarRenderer();
    renderer.applyControlEvent({
      type: "avatar.expression",
      version: "avatar_event_v1",
      session_id: "session-1",
      ts: "2026-03-11T00:00:00.000Z",
      idempotency_key: "expr-1",
      payload: {
        expression: "smile",
      },
    });
    renderer.applyControlEvent({
      type: "avatar.gesture",
      version: "avatar_event_v1",
      session_id: "session-1",
      ts: "2026-03-11T00:00:01.000Z",
      idempotency_key: "gesture-1",
      payload: {
        gesture: "wave",
      },
    });

    const snapshot = renderer.getDebugSnapshot();
    expect(snapshot.latestExpression).toBe("smile");
    expect(snapshot.latestGesture).toBe("wave");
    expect(snapshot.latestControlEventType).toBe("avatar.gesture");
  });

  it("Layer: contract. ignores malformed control-event payloads and keeps lifecycle state authoritative.", () => {
    const renderer = new VrmAvatarRenderer();
    renderer.applyState({
      primary_state: "speaking",
      motion_profile: "default",
      mouth_open: 1,
      fallback_active: false,
      asset_ref: "assets/local-avatar.png",
    });
    renderer.applyControlEvent({
      type: "avatar.expression",
      version: "avatar_event_v1",
      session_id: "session-1",
      ts: "2026-03-11T00:00:00.000Z",
      idempotency_key: "bad-expr-1",
      payload: {
        expression: "%%%not-valid%%%",
      },
    });
    renderer.applyControlEvent({
      type: "avatar.unknown",
      version: "avatar_event_v1",
      session_id: "session-1",
      ts: "2026-03-11T00:00:01.000Z",
      idempotency_key: "unknown-1",
      payload: {
        anything: "goes",
      },
    });

    const snapshot = renderer.getDebugSnapshot();
    expect(snapshot.latestExpression).toBeNull();
    expect(snapshot.latestGesture).toBeNull();
    expect(snapshot.latestState?.primary_state).toBe("speaking");
  });

  it("Layer: contract. exposes pure control-signal extraction for supported event types only.", () => {
    expect(
      extractAvatarControlSignalUpdate({
        type: "avatar.expression",
        version: "avatar_event_v1",
        session_id: "session-1",
        ts: "2026-03-11T00:00:00.000Z",
        idempotency_key: "expr-1",
        payload: { expression: "smile" },
      }),
    ).toEqual({ expression: "smile" });

    expect(
      extractAvatarControlSignalUpdate({
        type: "avatar.gesture",
        version: "avatar_event_v1",
        session_id: "session-1",
        ts: "2026-03-11T00:00:01.000Z",
        idempotency_key: "gesture-1",
        payload: { gesture: "nod" },
      }),
    ).toEqual({ gesture: "nod" });

    expect(
      extractAvatarControlSignalUpdate({
        type: "speech.start",
        version: "avatar_event_v1",
        session_id: "session-1",
        ts: "2026-03-11T00:00:01.000Z",
        idempotency_key: "speech-1",
        payload: { source: "tts_playback" },
      }),
    ).toBeNull();
  });
});
