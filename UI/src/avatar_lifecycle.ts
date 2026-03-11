export type AvatarPrimaryState = "idle" | "listening" | "thinking" | "speaking";

export interface AvatarLifecycleSignals {
  playbackActive: boolean;
  voiceCaptureActive: boolean;
  requestInFlight: boolean;
  playbackInterrupted?: boolean;
}

export function deriveAvatarPrimaryState({
  playbackActive,
  voiceCaptureActive,
  requestInFlight,
  playbackInterrupted = false,
}: AvatarLifecycleSignals): AvatarPrimaryState {
  if (playbackActive && !playbackInterrupted) {
    return "speaking";
  }
  if (voiceCaptureActive) {
    return "listening";
  }
  if (requestInFlight) {
    return "thinking";
  }
  return "idle";
}
