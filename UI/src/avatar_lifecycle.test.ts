import { describe, expect, it } from "vitest";

import { deriveAvatarPrimaryState } from "./avatar_lifecycle";

describe("avatar_lifecycle", () => {
  it("Layer: contract. gives speaking precedence when playback is active.", () => {
    const state = deriveAvatarPrimaryState({
      playbackActive: true,
      voiceCaptureActive: true,
      requestInFlight: true,
    });
    expect(state).toBe("speaking");
  });

  it("Layer: contract. transitions to listening on playback interruption with active voice capture.", () => {
    const state = deriveAvatarPrimaryState({
      playbackActive: true,
      playbackInterrupted: true,
      voiceCaptureActive: true,
      requestInFlight: true,
    });
    expect(state).toBe("listening");
  });

  it("Layer: contract. resolves to thinking when request is in flight without speaking/listening.", () => {
    const state = deriveAvatarPrimaryState({
      playbackActive: false,
      voiceCaptureActive: false,
      requestInFlight: true,
    });
    expect(state).toBe("thinking");
  });

  it("Layer: contract. resolves to idle when no runtime signals are active.", () => {
    const state = deriveAvatarPrimaryState({
      playbackActive: false,
      voiceCaptureActive: false,
      requestInFlight: false,
    });
    expect(state).toBe("idle");
  });
});
