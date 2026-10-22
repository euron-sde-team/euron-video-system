# `storage` module

Three single-purpose S3 buckets (`uploads`, `media`, `downloads`) with Block Public Access, BucketOwnerEnforced, SSE-KMS (SSE-S3 for media, whose segments are already AES-128 encrypted), TLS-only bucket policies, source expiry lifecycle, browser CORS, and optional CloudFront OAC read on media.

## Inputs

| Name | Description | Type | Default |
|---|---|---|---|
| `name_prefix` | Prefix for bucket names: <prefix>-uploads, <prefix>-media, <prefix>-downloads. Must be globally unique on AWS. | `string` | required |
| `kms_key_arn` | CMK for SSE-KMS on the uploads and downloads buckets. Null = SSE-S3. | `string` | `null` |
| `upload_expiration_days` | Raw sources are deleted this many days after upload (outputs are kept). | `number` | `7` |
| `cors_allowed_origins` | Browser origins allowed to POST uploads directly to S3 and GET media (presigned delivery). | `list(string)` | `[]` |
| `grant_cloudfront_access` | Grant cloudfront_distribution_arn (OAC) read access on the media bucket. A separate flag because the ARN is unknown until apply and for_each keys must be known at plan time. | `bool` | `false` |
| `cloudfront_distribution_arn` | Distribution granted read on the media bucket when grant_cloudfront_access is true. | `string` | `null` |
| `enforce_tls` | Deny any request that is not over TLS. Disable only for local emulators (plain HTTP). | `bool` | `true` |
| `enable_lifecycle` | Create lifecycle rules (source expiry, abort incomplete multipart uploads). | `bool` | `true` |
| `force_destroy` | Allow terraform destroy to delete non-empty buckets. Keep false outside throwaway environments. | `bool` | `false` |

## Outputs

| Name | Description |
|---|---|
| `bucket_names` | Map of purpose (uploads, media, downloads) to bucket name. |
| `bucket_arns` | Map of purpose to bucket ARN. |
| `media_bucket_regional_domain_name` | Regional domain of the media bucket (CloudFront origin). |
