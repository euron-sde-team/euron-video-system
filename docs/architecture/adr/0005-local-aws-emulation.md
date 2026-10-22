# ADR-0005: A local AWS emulator for development and demos, with a one-switch path to real AWS

- **Status:** Accepted
- **Date:** 2026-10-22

## Context

The system touches S3 (three buckets, presigned POST and GET), KMS (encrypt
and decrypt with encryption context), Secrets Manager and CloudFront. Asking
every contributor or evaluator for an AWS account before they can see a video
play is a steep on-ramp. Mocking each SDK call in code would test the mocks,
not the system.

## Decision

Run **[Floci](https://github.com/floci-io/floci)**, an MIT-licensed local AWS
emulator, as a container. Point the unmodified AWS SDK at it with the standard
`AWS_ENDPOINT_URL` variable.

- `make up` starts Postgres, the emulator, the API, two workers, the
  orchestrator (with a no-op launcher) and the console.
- The **same Terraform** used for AWS provisions the buckets, KMS key and
  secrets inside the emulator (`infra/terraform/envs/local-floci`), so local
  runs exercise the real IaC.
- `make up-aws` runs the same containers against real AWS resources created by
  `infra/terraform/envs/aws-dev`. The only differences are environment
  variables: no endpoint override, credentials from the AWS profile, and the
  `cloudfront-signed` delivery driver.

## Consequences

**Good**
- Clone to playing video with only Docker. No account, no cost.
- Application code has no emulator-specific branches: everything goes through
  configuration (`AWS_ENDPOINT_URL`, `S3_FORCE_PATH_STYLE`, `S3_PUBLIC_ENDPOINT`).
- The Terraform gets exercised on every local run.

**Bad / caveats**
- Emulators prove compatibility for the API calls they implement, not full
  behavioral parity. IAM policies are not enforced locally, so least-privilege
  mistakes only show up on real AWS. The `aws-dev` environment exists for that.
- The emulator's CloudFront is management-plane only (no edge serving).
  Locally, segments are served by the `proxy` (or `presigned`) delivery driver
  instead of signed CloudFront URLs. The `DeliveryDriver` interface keeps that
  difference to one configuration value.
- EC2 is not emulated for launch, so the orchestrator runs its `noop` launcher
  locally and workers run as fixed compose replicas.
