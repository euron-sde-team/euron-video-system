# ADR-0002: Self-managed FFmpeg workers instead of a managed transcoding service

- **Status:** Accepted
- **Date:** 2026-10-22

## Context

AWS Elemental MediaConvert (and similar managed services) will transcode and
package HLS on demand. They are excellent for broadcast workloads. We needed:

- per-title control: cap each rung to the source's real bitrate, with a quality
  floor so screen recordings of text stay sharp;
- correct handling of near-static sources (slides held for minutes), which
  produce sub-1-fps timelines that MSE players refuse to play;
- the content key generated, wrapped and stored by *our* code, so key custody
  never leaves the deployment;
- captions via Whisper and a separate size-optimized download MP4 from the same source;
- predictable cost at long durations, where per-minute managed pricing dominates;
- an encoding path that runs identically on a laptop, in CI and in production.

## Decision

Run FFmpeg on EC2 Spot instances (Graviton by default) from a worker image
built with Packer, scaled by our own orchestrator (ADR-0004).

The pipeline does a **single decode with multiple encodes**: one FFmpeg process
decodes the source once and encodes every ladder rung in parallel with
`libx264` capped CRF. The HLS muxer packages each rung into AES-128 MPEG-TS segments.

## Consequences

**Good**
- Full control over the ladder, the encryption, and how unusual sources are handled.
- Spot Graviton compute at a fraction of on-demand x86 or per-minute managed pricing.
- The same worker runs in Docker locally against the emulator, so encoding changes are testable end to end.
- No managed service ever touches content keys.

**Bad**
- We own the encoder fleet: AMI builds, FFmpeg upgrades, capacity.
- No hardware encoders. CPU x264 runs at about 1x realtime per rung group on a
  4xlarge; long videos take as long as they take. The orchestrator scales out
  (one worker per queued video) to keep queue latency bounded.

## Alternatives considered

- **MediaConvert:** strongest option for broadcast formats and hardware
  encoding, but managed key custody and per-minute cost ruled it out. It is
  also not emulated locally, so it would break the local-first workflow (ADR-0005).
- **GPU (NVENC) workers:** faster, but lower quality per bit at our bitrates,
  and GPU Spot capacity is scarcer. Worth revisiting for a premium tier.
