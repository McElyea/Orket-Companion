import type { AvatarControlEventEnvelopeV1, AvatarPrefsV1 } from "./types";
import { isLocalAvatarAssetRef, isSupportedAvatarAssetRef } from "./avatar_prefs";

export interface NormalizedAvatarState {
  primary_state: "idle" | "listening" | "thinking" | "speaking";
  motion_profile: "default" | "reduced";
  mouth_open: number;
  fallback_active: boolean;
  asset_ref: string | null;
}

export interface AvatarControlSignalUpdate {
  expression?: string;
  gesture?: string;
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
  latestExpression: string | null;
  latestGesture: string | null;
  latestControlEventType: string | null;
}

export interface AvatarRendererDebugSnapshot {
  suspended: boolean;
  latestState: NormalizedAvatarState | null;
  latestAssetRef: string | null;
  latestExpression: string | null;
  latestGesture: string | null;
  latestControlEventType: string | null;
}

class InMemoryAvatarRenderer implements AvatarRenderer {
  public readonly id: "fallback" | "vrm";
  protected readonly state: RendererState = {
    suspended: false,
    latestState: null,
    latestAssetRef: null,
    latestExpression: null,
    latestGesture: null,
    latestControlEventType: null,
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

  applyControlEvent(event: AvatarControlEventEnvelopeV1): void {
    this.state.latestControlEventType = event.type;
    const signalUpdate = extractAvatarControlSignalUpdate(event);
    if (!signalUpdate) {
      return;
    }
    if (signalUpdate.expression) {
      this.state.latestExpression = signalUpdate.expression;
    }
    if (signalUpdate.gesture) {
      this.state.latestGesture = signalUpdate.gesture;
    }
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
    this.state.latestExpression = null;
    this.state.latestGesture = null;
    this.state.latestControlEventType = null;
    this.state.suspended = false;
    return Promise.resolve();
  }

  getDebugSnapshot(): AvatarRendererDebugSnapshot {
    return {
      suspended: this.state.suspended,
      latestState: this.state.latestState ? { ...this.state.latestState } : null,
      latestAssetRef: this.state.latestAssetRef,
      latestExpression: this.state.latestExpression,
      latestGesture: this.state.latestGesture,
      latestControlEventType: this.state.latestControlEventType,
    };
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

const CONTROL_SIGNAL_VALUE_PATTERN = /^[a-zA-Z0-9 _.-]{1,64}$/;

function normalizeControlSignalValue(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  if (!normalized || !CONTROL_SIGNAL_VALUE_PATTERN.test(normalized)) {
    return null;
  }
  return normalized;
}

export function extractAvatarControlSignalUpdate(
  event: AvatarControlEventEnvelopeV1,
): AvatarControlSignalUpdate | null {
  if (event.type === "avatar.expression") {
    const expression = normalizeControlSignalValue(event.payload.expression);
    if (!expression) {
      return null;
    }
    return { expression };
  }
  if (event.type === "avatar.gesture") {
    const gesture = normalizeControlSignalValue(event.payload.gesture);
    if (!gesture) {
      return null;
    }
    return { gesture };
  }
  return null;
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
