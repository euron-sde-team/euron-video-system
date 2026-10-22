# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0] - 2026-10-22

First public release.

### Added

- Transcode worker: single-decode, multi-encode FFmpeg ABR ladder (capped CRF,
  cap-to-source with a quality floor, orientation-aware rungs, no upscaling),
  AES-128 HLS packaging, poster and sprite thumbnails, Whisper captions, and a
  size-conscious downloadable MP4.
- Postgres-as-queue with `FOR UPDATE SKIP LOCKED` claims, guarded mutations,
  heartbeats, a reaper and a decoupled background-job queue.
- Spot autoscaler: multi-AZ x instance-type EC2 Fleet ladder, self-terminating
  idle workers, Spot-interruption hand-back. Runs as a scheduled Lambda or a local loop.
- Control plane API: hashed and scoped API keys, playback policies, revocable
  playback sessions, signed webhooks over a transactional outbox, append-only
  audit log, daily usage, OpenAPI 3.1 spec, Prometheus metrics.
- Secure delivery: KMS envelope encryption of per-video keys, tokenized
  playlist and key delivery, signed segment URLs (CloudFront, S3 presign or proxy).
- Operator console and an embeddable hls.js player with sprite thumbnails and
  a dynamic watermark.
- Terraform modules for AWS, a local AWS emulator profile, Docker images,
  Packer worker AMI, and CI workflows.
