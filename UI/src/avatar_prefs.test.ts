import { describe, expect, it } from "vitest";

import {
  createDefaultAvatarPrefs,
  isLocalAvatarAssetRef,
  parseAvatarPrefsFromUnknown,
} from "./avatar_prefs";

describe("avatar_prefs", () => {
  it("Layer: contract. parses a valid avatar_prefs_v1 payload without warnings.", () => {
    const result = parseAvatarPrefsFromUnknown({
      version: "avatar_prefs_v1",
      mode: "avatar",
      renderer: "vrm",
      asset_ref: "assets/avatar.png",
      motion_profile: "default",
      fallback_policy: "always_safe",
    });
    expect(result.migrationWarning).toBeNull();
    expect(result.prefs.mode).toBe("avatar");
    expect(result.prefs.renderer).toBe("vrm");
    expect(result.prefs.asset_ref).toBe("assets/avatar.png");
  });

  it("Layer: contract. migrates legacy payloads to avatar_prefs_v1.", () => {
    const result = parseAvatarPrefsFromUnknown({
      mode: "avatar",
      renderer: "vrm",
      asset_ref: "assets/legacy-avatar.png",
      motion_profile: "reduced",
    });
    expect(result.migrationWarning).toBe("avatar_settings_migrated_legacy_payload");
    expect(result.prefs.version).toBe("avatar_prefs_v1");
    expect(result.prefs.fallback_policy).toBe("always_safe");
    expect(result.prefs.motion_profile).toBe("reduced");
  });

  it("Layer: contract. fails closed to defaults on unknown version.", () => {
    const defaults = createDefaultAvatarPrefs();
    const result = parseAvatarPrefsFromUnknown({
      version: "avatar_prefs_v0",
      mode: "avatar",
      renderer: "vrm",
    });
    expect(result.migrationWarning).toBe("avatar_settings_unknown_version");
    expect(result.prefs).toEqual(defaults);
  });

  it("Layer: contract. enforces local-only asset refs.", () => {
    expect(isLocalAvatarAssetRef("assets/avatar.png")).toBe(true);
    expect(isLocalAvatarAssetRef("/images/avatar.png")).toBe(true);
    expect(isLocalAvatarAssetRef("https://example.com/avatar.png")).toBe(false);
    expect(isLocalAvatarAssetRef("C:\\avatars\\face.png")).toBe(false);
  });
});
