import { describe, expect, it } from "vitest";

import { computeAvatarMouthEnvelope, mouthOpenForPlaybackProgress } from "./avatar_lipsync";

function makeAudioSource(frames: number[]): {
  numberOfChannels: number;
  length: number;
  getChannelData: (channel: number) => Float32Array;
} {
  const channel = Float32Array.from(frames);
  return {
    numberOfChannels: 1,
    length: channel.length,
    getChannelData: (_channel: number) => channel,
  };
}

describe("avatar_lipsync", () => {
  it("Layer: contract. computes a normalized mouth envelope from decoded playback audio.", () => {
    const source = makeAudioSource([0, 0.2, 0.6, 0.1, 0.9, 0.3, 0.05, 0.4, 0.7, 0.2, 0, 0]);
    const envelope = computeAvatarMouthEnvelope(source, 6);

    expect(envelope.length).toBeGreaterThanOrEqual(6);
    expect(Math.max(...envelope)).toBeCloseTo(1, 5);
    expect(Math.min(...envelope)).toBeGreaterThanOrEqual(0);
  });

  it("Layer: contract. resolves mouth-open progression from elapsed playback time.", () => {
    const envelope = [0, 0.25, 0.75, 1, 0.5, 0.1];

    const early = mouthOpenForPlaybackProgress(envelope, 0.1, 2, "default");
    const middle = mouthOpenForPlaybackProgress(envelope, 1, 2, "default");
    const late = mouthOpenForPlaybackProgress(envelope, 1.8, 2, "default");

    expect(early).toBeGreaterThanOrEqual(0);
    expect(middle).toBeGreaterThan(early);
    expect(late).toBeLessThanOrEqual(1);
  });

  it("Layer: contract. caps reduced-motion mouth-open output to low-motion bounds.", () => {
    const reduced = mouthOpenForPlaybackProgress([0.9, 1, 0.8], 0.4, 1, "reduced");
    expect(reduced).toBeGreaterThanOrEqual(0.04);
    expect(reduced).toBeLessThanOrEqual(0.22);
  });

  it("Layer: contract. returns zero when playback timing is invalid or silent.", () => {
    expect(mouthOpenForPlaybackProgress([], 0.1, 1, "default")).toBe(0);
    expect(mouthOpenForPlaybackProgress([0, 0, 0], 0.1, 1, "default")).toBe(0);
    expect(mouthOpenForPlaybackProgress([0.5], 0.1, 0, "default")).toBe(0);
  });
});
