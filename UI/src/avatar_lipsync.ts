import type { AvatarMotionProfile } from "./types";

interface AudioEnvelopeSource {
  numberOfChannels: number;
  length: number;
  getChannelData: (channel: number) => Float32Array;
}

export function computeAvatarMouthEnvelope(source: AudioEnvelopeSource, bucketCount: number = 96): number[] {
  const totalFrames = Math.max(0, Math.floor(source.length || 0));
  const channels = Math.max(1, Math.floor(source.numberOfChannels || 1));
  if (totalFrames <= 0) {
    return [0];
  }

  const desiredBuckets = Math.max(8, Math.floor(bucketCount || 96));
  const chunkFrames = Math.max(1, Math.floor(totalFrames / desiredBuckets));
  const rawBuckets: number[] = [];

  for (let start = 0; start < totalFrames; start += chunkFrames) {
    const end = Math.min(totalFrames, start + chunkFrames);
    let sum = 0;
    let sampleCount = 0;
    for (let channel = 0; channel < channels; channel += 1) {
      const channelData = source.getChannelData(channel);
      for (let frame = start; frame < end; frame += 1) {
        sum += Math.abs(channelData[frame] || 0);
        sampleCount += 1;
      }
    }
    rawBuckets.push(sampleCount > 0 ? sum / sampleCount : 0);
  }

  // Smooth adjacent buckets to avoid visible jitter from frame-level spikes.
  const smoothed = rawBuckets.map((_, index) => {
    const prev = rawBuckets[Math.max(0, index - 1)];
    const current = rawBuckets[index];
    const next = rawBuckets[Math.min(rawBuckets.length - 1, index + 1)];
    return (prev + current + next) / 3;
  });

  const maxBucket = Math.max(...smoothed, 0);
  if (maxBucket <= 0) {
    return smoothed.map(() => 0);
  }

  return smoothed.map((value) => Math.max(0, Math.min(1, value / maxBucket)));
}

export function mouthOpenForPlaybackProgress(
  envelope: number[],
  elapsedSeconds: number,
  durationSeconds: number,
  motionProfile: AvatarMotionProfile,
): number {
  if (!Array.isArray(envelope) || envelope.length === 0) {
    return 0;
  }
  const resolvedDuration = Number(durationSeconds);
  if (!Number.isFinite(resolvedDuration) || resolvedDuration <= 0) {
    return 0;
  }
  const resolvedElapsed = Math.max(0, Number(elapsedSeconds) || 0);
  const progress = Math.min(1, resolvedElapsed / resolvedDuration);
  const index = Math.min(envelope.length - 1, Math.floor(progress * (envelope.length - 1)));
  const amplitude = Math.max(0, Math.min(1, Number(envelope[index]) || 0));
  if (amplitude <= 0.01) {
    return 0;
  }

  if (motionProfile === "reduced") {
    const reducedCeiling = 0.22;
    const reducedFloor = 0.04;
    return Math.min(reducedCeiling, Math.max(reducedFloor, amplitude * reducedCeiling));
  }

  const defaultFloor = 0.08;
  return Math.min(1, Math.max(defaultFloor, amplitude));
}
