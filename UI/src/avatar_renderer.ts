import type { AvatarPrefsV1 } from "./types";
import { isLocalAvatarAssetRef, isSupportedAvatarAssetRef } from "./avatar_prefs";

export interface NormalizedAvatarState {
  primary_state: "idle" | "listening" | "thinking" | "speaking";
  motion_profile: "default" | "reduced";
  mouth_open: number;
  fallback_active: boolean;
  asset_ref: string | null;
}

export interface AvatarControlEventEnvelopeV1 {
  type: string;
  version: "avatar_event_v1";
  session_id: string;
  ts: string;
  idempotency_key: string;
  payload: Record<string, unknown>;
}

export interface AvatarRenderer {
  id: "fallback" | "vrm" | string;
  init(): Promise<void>;
  loadAsset(assetRef: string | null): Promise<void>;
  applyState(state: NormalizedAvatarState): void;
  applyControlEvent(event: AvatarControlEventEnvelopeV1): void;
  suspend(reason: "perf" | "hidden" | "degraded"): void;
  resume(): void;
  dispose(): Promise<void>;
}

interface RendererState {
  suspended: boolean;
  latestState: NormalizedAvatarState | null;
  latestAssetRef: string | null;
}

class InMemoryAvatarRenderer implements AvatarRenderer {
  public readonly id: "fallback" | "vrm";
  protected readonly state: RendererState = {
    suspended: false,
    latestState: null,
    latestAssetRef: null,
  };

  constructor(id: "fallback" | "vrm") {
    this.id = id;
  }

  async init(): Promise<void> {
    return Promise.resolve();
  }

  async loadAsset(assetRef: string | null): Promise<void> {
    this.state.latestAssetRef = assetRef;
    return Promise.resolve();
  }

  applyState(state: NormalizedAvatarState): void {
    this.state.latestState = state;
  }

  applyControlEvent(_event: AvatarControlEventEnvelopeV1): void {
    // Control events are additive and non-authoritative at this phase.
  }

  suspend(_reason: "perf" | "hidden" | "degraded"): void {
    this.state.suspended = true;
  }

  resume(): void {
    this.state.suspended = false;
  }

  async dispose(): Promise<void> {
    this.state.latestState = null;
    this.state.latestAssetRef = null;
    this.state.suspended = false;
    return Promise.resolve();
  }
}

export class FallbackAvatarRenderer extends InMemoryAvatarRenderer {
  constructor() {
    super("fallback");
  }
}

export class VrmAvatarRenderer extends InMemoryAvatarRenderer {
  constructor() {
    super("vrm");
  }
}

export function createAvatarRenderer(rendererId: AvatarPrefsV1["renderer"]): AvatarRenderer {
  if (rendererId === "vrm") {
    return new VrmAvatarRenderer();
  }
  return new FallbackAvatarRenderer();
}

export interface AvatarRenderDecision {
  rendererId: AvatarPrefsV1["renderer"];
  hasAssetRef: boolean;
  assetPolicyAllowed: boolean;
  assetTypeAllowed: boolean;
  renderAssetRef: string | null;
  fallbackActive: boolean;
  fallbackReason: string;
}

interface AvatarRenderDecisionInput {
  prefs: AvatarPrefsV1;
  assetLoadFailed: boolean;
}

export function resolveAvatarRenderDecision({
  prefs,
  assetLoadFailed,
}: AvatarRenderDecisionInput): AvatarRenderDecision {
  const normalizedAssetRef = String(prefs.asset_ref || "").trim();
  const hasAssetRef = normalizedAssetRef.length > 0;
  const assetPolicyAllowed = isLocalAvatarAssetRef(prefs.asset_ref);
  const assetTypeAllowed = isSupportedAvatarAssetRef(prefs.asset_ref);
  if (prefs.mode === "off") {
    return {
      rendererId: "fallback",
      hasAssetRef,
      assetPolicyAllowed,
      assetTypeAllowed,
      renderAssetRef: null,
      fallbackActive: true,
      fallbackReason: "Avatar mode is off.",
    };
  }
  if (prefs.mode === "fallback" || prefs.renderer === "fallback") {
    return {
      rendererId: "fallback",
      hasAssetRef,
      assetPolicyAllowed,
      assetTypeAllowed,
      renderAssetRef: null,
      fallbackActive: true,
      fallbackReason: "Fallback renderer selected.",
    };
  }
  if (!hasAssetRef) {
    return {
      rendererId: "vrm",
      hasAssetRef,
      assetPolicyAllowed,
      assetTypeAllowed,
      renderAssetRef: null,
      fallbackActive: true,
      fallbackReason: "No avatar asset configured.",
    };
  }
  if (!assetTypeAllowed) {
    return {
      rendererId: "fallback",
      hasAssetRef,
      assetPolicyAllowed,
      assetTypeAllowed,
      renderAssetRef: null,
      fallbackActive: true,
      fallbackReason: "Unsupported avatar asset type; using safe fallback.",
    };
  }
  if (!assetPolicyAllowed) {
    return {
      rendererId: "fallback",
      hasAssetRef,
      assetPolicyAllowed,
      assetTypeAllowed,
      renderAssetRef: null,
      fallbackActive: true,
      fallbackReason: "Remote avatar assets are disabled; using safe fallback.",
    };
  }
  if (assetLoadFailed) {
    return {
      rendererId: "fallback",
      hasAssetRef,
      assetPolicyAllowed,
      assetTypeAllowed,
      renderAssetRef: null,
      fallbackActive: true,
      fallbackReason: "Avatar asset failed to load; using safe fallback.",
    };
  }
  return {
    rendererId: "vrm",
    hasAssetRef,
    assetPolicyAllowed,
    assetTypeAllowed,
    renderAssetRef: normalizedAssetRef,
    fallbackActive: false,
    fallbackReason: "",
  };
}
