# `kms` module

One customer-managed KMS key (annual rotation) plus alias. It wraps per-video AES-128 content keys and encrypts the uploads/downloads buckets, RDS and Secrets Manager. Usage is granted per role by IAM, scoped by `kms:EncryptionContext:videoId` or `kms:ViaService`.

## Inputs

| Name | Description | Type | Default |
|---|---|---|---|
| `name_prefix` | Prefix for every resource name. | `string` | required |
| `deletion_window_in_days` | Waiting period before a scheduled key deletion completes. | `number` | `30` |
| `admin_principal_arns` | IAM principals allowed to administer (not use) the key. Empty = account root only, which delegates to IAM policies. | `list(string)` | `[]` |

## Outputs

| Name | Description |
|---|---|
| `key_arn` | KMS key ARN. |
| `key_id` | KMS key id. |
| `alias_name` | Alias, usable as KMS_KEY_ID. |
