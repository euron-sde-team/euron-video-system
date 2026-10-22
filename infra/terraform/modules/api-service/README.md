# `api-service` module

The control plane on ECS Fargate (arm64): ECR repository (immutable tags, scan on push), ALB with HTTP->HTTPS redirect and TLS 1.3 policy, target-group health on `/readyz`, CPU target-tracking autoscaling, deployment circuit breaker with rollback, read-only root filesystem, secrets injected from Secrets Manager, least-privilege task role, and a one-off `migrate` task definition. The app reads the database password from the RDS-managed secret for every new connection (no password in the task definition), so RDS password rotation takes effect without a redeploy.

## Inputs

| Name | Description | Type | Default |
|---|---|---|---|
| `name_prefix` | Prefix for every resource name. | `string` | required |
| `vpc_id` | VPC id. | `string` | required |
| `public_subnet_ids` | Subnets for the internet-facing ALB. | `list(string)` | required |
| `private_subnet_ids` | Subnets for Fargate tasks. | `list(string)` | required |
| `certificate_arn` | ACM certificate (same region) for the HTTPS listener. | `string` | required |
| `image_tag` | Image tag in the module's ECR repository to deploy (tags are immutable). The migration task uses "<tag>-tools". | `string` | required |
| `image_override` | Full image reference to run instead of the module's ECR repository (e.g. ghcr.io/<org>/evs-api:0.1.0). | `string` | `null` |
| `cpu` | Task CPU units. | `number` | `1024` |
| `memory` | Task memory (MiB). | `number` | `2048` |
| `desired_count` | Initial task count. | `number` | `2` |
| `min_count` | Autoscaling floor. | `number` | `2` |
| `max_count` | Autoscaling ceiling. | `number` | `10` |
| `cluster_workers` | Node cluster workers per task (0 = one per vCPU). | `number` | `0` |
| `public_api_base` | Public HTTPS base URL of the API, e.g. https://api.video.example.com. | `string` | required |
| `cors_allowed_origins` | Browser origins allowed to call the management API (the console). | `list(string)` | `[]` |
| `bucket_names` | Map uploads/media/downloads -> bucket name. | `map(string)` | required |
| `bucket_arns` | Map uploads/media/downloads -> bucket ARN. | `map(string)` | required |
| `kms_key_arn` | CMK that wraps content keys and encrypts buckets/secrets. | `string` | required |
| `kms_key_alias` | Alias passed to the app as KMS_KEY_ID. | `string` | required |
| `shared_secret_arn` | Secret <prefix>/shared. | `string` | required |
| `api_secret_arn` | Secret <prefix>/api. | `string` | required |
| `db_address` | Database hostname. | `string` | required |
| `db_port` | Database port. | `number` | `5432` |
| `db_name` | Database name. | `string` | required |
| `db_secret_arn` | RDS-managed master user secret (JSON username/password). | `string` | required |
| `db_security_group_id` | DB security group to grant ingress on. | `string` | required |
| `delivery_driver` | cloudfront-signed \| presigned \| proxy \| public. | `string` | `"cloudfront-signed"` |
| `media_public_base` | CloudFront base URL for media. | `string` | `null` |
| `cloudfront_key_pair_id` | CloudFront public key id used for signing. | `string` | `null` |
| `deletion_protection` | Protect the load balancer from deletion. | `bool` | `true` |
| `access_logs_bucket` | Optional S3 bucket for ALB access logs (must allow the regional ELB principal). | `string` | `null` |
| `log_retention_days` | CloudWatch Logs retention. | `number` | `30` |
| `extra_environment` | Additional plain environment variables (see docs/guides/configuration.md). | `map(string)` | `{}` |

## Outputs

| Name | Description |
|---|---|
| `alb_dns_name` | Point your API DNS record (CNAME/alias) here. |
| `alb_zone_id` | Hosted zone of the ALB, for Route 53 alias records. |
| `alb_arn_suffix` | CloudWatch dimension for ALB metrics. |
| `target_group_arn_suffix` | CloudWatch dimension for target-group metrics. |
| `ecr_repository_url` | Push api images (and <tag>-tools images) here. |
| `cluster_name` | ECS cluster name. |
| `service_name` | ECS service name. |
| `task_security_group_id` | Security group of API tasks. |
| `migrate_task_definition` | Family of the one-off migration task. |
