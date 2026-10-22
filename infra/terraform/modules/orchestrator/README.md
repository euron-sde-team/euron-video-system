# `orchestrator` module

The autoscaler as an arm64 Lambda in private subnets, ticked by EventBridge Scheduler (`rate(1 minute)`, no retries, DLQ). Reserved concurrency 1 guarantees ticks never overlap. IAM allows EC2 Fleet launches in-region and `iam:PassRole` on the worker role only.

## Inputs

| Name | Description | Type | Default |
|---|---|---|---|
| `name_prefix` | Prefix for every resource name. | `string` | required |
| `vpc_id` | VPC id. | `string` | required |
| `private_subnet_ids` | Subnets the Lambda runs in (needs NAT or endpoints for EC2 + Secrets Manager). | `list(string)` | required |
| `lambda_source_dir` | Directory containing the built handler (apps/orchestrator/dist/lambda: index.js + package.json). | `string` | required |
| `schedule_expression` | How often the controller ticks. | `string` | `"rate(1 minute)"` |
| `db_address` | Database hostname. | `string` | required |
| `db_port` | Database port. | `number` | `5432` |
| `db_name` | Database name. | `string` | required |
| `db_secret_arn` | RDS-managed master user secret; the handler builds its connection string from it. | `string` | required |
| `db_security_group_id` | DB security group to grant ingress on. | `string` | required |
| `kms_key_arn` | CMK that encrypts the DB secret. | `string` | required |
| `worker_subnet_ids` | Subnets (one per AZ) the controller fans worker launches across. | `list(string)` | required |
| `worker_role_arn` | Worker IAM role the launched instances assume (iam:PassRole is scoped to it). | `string` | required |
| `launch_template_name` | Primary pool launch template. | `string` | required |
| `jobs_launch_template_name` | Background-jobs pool launch template; null = single pool. | `string` | `null` |
| `worker_instance_types` | Strict preference ladder, highest first. Must match the AMI architecture. | `list(string)` | `["c7g.4xlarge", "c7g.2xlarge", "c7g.xlarge", "c6g.xlarge", "m7g.xlarge"]` |
| `jobs_instance_types` | Instance ladder for the jobs pool. | `list(string)` | `["c7g.xlarge", "c6g.xlarge", "m7g.xlarge"]` |
| `role_tag` | Primary pool `role` tag. | `string` | required |
| `jobs_role_tag` | Jobs pool `role` tag. | `string` | required |
| `max_workers` | Hard ceiling on primary workers. | `number` | `20` |
| `jobs_max_workers` | Hard ceiling on jobs workers. | `number` | `10` |
| `ondemand_fallback` | Fall back to On-Demand when no Spot pool has capacity. | `bool` | `false` |
| `log_retention_days` | CloudWatch Logs retention. | `number` | `30` |

## Outputs

| Name | Description |
|---|---|
| `function_name` | Lambda function name. |
| `function_arn` | Lambda function ARN. |
| `dlq_name` | Dead-letter queue for failed ticks. |
