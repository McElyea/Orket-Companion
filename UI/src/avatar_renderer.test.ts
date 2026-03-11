import { describe, expect, it } from "vitest";

import {
  createAvatarRenderer,
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
    expect(decision.renderAssetRef).toBe("assets/local-avatar.png");
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
});
