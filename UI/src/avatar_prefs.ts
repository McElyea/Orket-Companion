import type { AvatarMode, AvatarMotionProfile, AvatarPrefsV1, AvatarRenderer } from "./types";

export const AVATAR_PREFS_STORAGE_KEY = "companion:avatar-prefs:v1";

const ALLOWED_AVATAR_MODES: readonly AvatarMode[] = ["off", "fallback", "avatar"];
const ALLOWED_AVATAR_RENDERERS: readonly AvatarRenderer[] = ["fallback", "vrm"];
const ALLOWED_MOTION_PROFILES: readonly AvatarMotionProfile[] = ["default", "reduced"];

export interface AvatarPrefsLoadResult {
  prefs: AvatarPrefsV1;
  migrationWarning: string | null;
}

export function createDefaultAvatarPrefs(): AvatarPrefsV1 {
  return {
    version: "avatar_prefs_v1",
    mode: "fallback",
    renderer: "fallback",
    asset_ref: null,
    motion_profile: "default",
    fallback_policy: "always_safe",
  };
}

function normalizeAvatarMode(value: unknown): AvatarMode | null {
  const token = String(value || "").trim().toLowerCase() as AvatarMode;
  return ALLOWED_AVATAR_MODES.includes(token) ? token : null;
}

function normalizeAvatarRenderer(value: unknown): AvatarRenderer | null {
  const token = String(value || "").trim().toLowerCase() as AvatarRenderer;
  return ALLOWED_AVATAR_RENDERERS.includes(token) ? token : null;
}

function normalizeMotionProfile(value: unknown): AvatarMotionProfile | null {
  const token = String(value || "").trim().toLowerCase() as AvatarMotionProfile;
  return ALLOWED_MOTION_PROFILES.includes(token) ? token : null;
}

function normalizeAssetRef(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function toAvatarPrefsV1(candidate: Record<string, unknown>): AvatarPrefsV1 | null {
  const mode = normalizeAvatarMode(candidate.mode);
  const renderer = normalizeAvatarRenderer(candidate.renderer);
  const motionProfile = normalizeMotionProfile(candidate.motion_profile);
  const assetRef = normalizeAssetRef(candidate.asset_ref);
  const fallbackPolicy = String(candidate.fallback_policy || "").trim();
  if (!mode || !renderer || !motionProfile || fallbackPolicy !== "always_safe") {
    return null;
  }
  return {
    version: "avatar_prefs_v1",
    mode,
    renderer,
    asset_ref: assetRef,
    motion_profile: motionProfile,
    fallback_policy: "always_safe",
  };
}

function migrateLegacyAvatarPrefs(candidate: Record<string, unknown>): AvatarPrefsV1 | null {
  const defaults = createDefaultAvatarPrefs();
  const mode = normalizeAvatarMode(candidate.mode) || defaults.mode;
  const renderer = normalizeAvatarRenderer(candidate.renderer) || defaults.renderer;
  const motionProfile = normalizeMotionProfile(candidate.motion_profile) || defaults.motion_profile;
  return {
    version: "avatar_prefs_v1",
    mode,
    renderer,
    asset_ref: normalizeAssetRef(candidate.asset_ref),
    motion_profile: motionProfile,
    fallback_policy: "always_safe",
  };
}

export function parseAvatarPrefsFromUnknown(value: unknown): AvatarPrefsLoadResult {
  const defaults = createDefaultAvatarPrefs();
  const record = asRecord(value);
  if (!record) {
    return { prefs: defaults, migrationWarning: "avatar_settings_invalid_payload" };
  }

  const version = String(record.version || "").trim();
  if (!version) {
    return {
      prefs: migrateLegacyAvatarPrefs(record) || defaults,
      migrationWarning: "avatar_settings_migrated_legacy_payload",
    };
  }
  if (version !== "avatar_prefs_v1") {
    return { prefs: defaults, migrationWarning: "avatar_settings_unknown_version" };
  }

  const validated = toAvatarPrefsV1(record);
  if (!validated) {
    return { prefs: defaults, migrationWarning: "avatar_settings_v1_schema_invalid" };
  }
  return { prefs: validated, migrationWarning: null };
}

export function loadAvatarPrefsFromStorage(storage: Storage = window.localStorage): AvatarPrefsLoadResult {
  try {
    const raw = storage.getItem(AVATAR_PREFS_STORAGE_KEY);
    if (!raw) {
      return { prefs: createDefaultAvatarPrefs(), migrationWarning: null };
    }
    return parseAvatarPrefsFromUnknown(JSON.parse(raw));
  } catch {
    return {
      prefs: createDefaultAvatarPrefs(),
      migrationWarning: "avatar_settings_storage_parse_failed",
    };
  }
}

export function persistAvatarPrefs(
  prefs: AvatarPrefsV1,
  storage: Storage = window.localStorage,
): void {
  try {
    storage.setItem(AVATAR_PREFS_STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // Best-effort persistence only.
  }
}

export function isLocalAvatarAssetRef(value: string | null): boolean {
  const normalized = String(value || "").trim();
  if (!normalized) {
    return true;
  }
  if (normalized.includes("://") || normalized.startsWith("//")) {
    return false;
  }
  if (/^[a-zA-Z]+:[\\/]/.test(normalized)) {
    return false;
  }
  return true;
}
