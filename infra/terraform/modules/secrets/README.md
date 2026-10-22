# `secrets` module

Generates and stores application secrets in Secrets Manager, split by consumer for least privilege: `<prefix>/shared` (api + workers) and `<prefix>/api` (api only, incl. the CloudFront signing key). Values live in Terraform state: use an encrypted remote backend.

## Inputs

| Name | Description | Type | Default |
|---|---|---|---|
| `name_prefix` | Prefix for secret names: <prefix>/shared and <prefix>/api. | `string` | required |
| `kms_key_arn` | CMK that encrypts the secrets. Null = the AWS-managed aws/secretsmanager key. | `string` | `null` |
| `recovery_window_in_days` | Days a deleted secret stays recoverable (0 = immediate, for throwaway envs). | `number` | `30` |

## Outputs

| Name | Description |
|---|---|
| `shared_secret_arn` | ARN of <prefix>/shared. |
| `api_secret_arn` | ARN of <prefix>/api. |
| `cloudfront_public_key_pem` | Public half of the CloudFront signing key (feed to the cdn module). |
