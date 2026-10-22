# ADR-0006: One deployment serves one organization

- **Status:** Accepted
- **Date:** 2026-10-22

## Context

A video platform can be multi-tenant (one deployment, a tenant column on every
row, tenant-scoped keys and storage prefixes) or single-tenant (one deployment
per organization).

Multi-tenancy puts the isolation boundary in application code. Every query,
storage key and cache entry must carry the tenant, and one forgotten `WHERE
tenant_id = ?` is a cross-customer data leak. It also shares the blast radius:
one KMS key, one database, one noisy neighbor.

This project is meant to be deployed *by* an organization *for* its own
content, inside its own cloud account.

## Decision

The data model has **no tenant concept**. An organization gets its own
deployment, which means its own:

- Postgres database,
- S3 buckets and CloudFront distribution,
- KMS customer managed key, so key custody belongs to the organization's own account,
- Secrets Manager secrets, playback signing keys and API key pepper,
- Terraform state.

Separation *inside* a deployment (for example environments, or teams in one
organization) is expressed with scoped API keys and playback policies, not tenants.

## Consequences

**Good**
- The isolation boundary is the cloud account and the network, enforced by AWS
  and not by application code. A missing filter cannot leak another
  organization's data, because no other organization's data exists in that database.
- A smaller, simpler schema and API: no tenant headers or tenant-scoped indexes.
- Per-organization KMS keys make crypto-shredding (delete the key, and every
  wrapped content key becomes unrecoverable) a real offboarding tool.

**Bad**
- Running many organizations means running many deployments. Terraform modules
  and `name_prefix` make that repeatable, but fixed infrastructure costs (RDS,
  NAT, ALB) are paid per deployment.
- Cross-organization analytics need an external aggregation layer.

## Alternatives considered

- **Row-level multi-tenancy with Postgres RLS:** stronger than application-only
  filtering, but storage, KMS and caches would still be shared, so the blast
  radius would not be per-organization.
- **Schema-per-tenant:** operationally heavy migrations, with the same shared-infrastructure drawbacks.
