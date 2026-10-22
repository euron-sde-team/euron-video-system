# `worker-fleet` module

Launch template(s) for EC2 Spot transcode workers: IMDSv2 only (hop limit 1), encrypted gp3 scratch volume, no ingress and no SSH (SSM Session Manager only), shutdown behavior `terminate` so idle workers release themselves, and an instance role scoped to exactly the S3 prefixes and KMS operations the worker performs. User data pulls secrets at boot; nothing secret is baked into the AMI. Optional second pool for background jobs.

## Inputs

| Name | Description | Type | Default |
|---|---|---|---|
| `name_prefix` | Prefix for every resource name. | `string` | required |
| `vpc_id` | VPC id. | `string` | required |
| `ami_id` | Worker AMI built by infra/packer/worker.pkr.hcl (arm64). | `string` | required |
| `default_instance_type` | Launch-template default. The orchestrator overrides it per launch from its instance-type ladder. | `string` | `"c7g.xlarge"` |
| `root_volume_gb` | gp3 scratch volume for sources and renditions. Size for your largest source x ~3. | `number` | `100` |
| `role_tag` | Value of the `role` tag the orchestrator counts primary workers by. | `string` | `"evs-transcoder"` |
| `enable_jobs_pool` | Also create a launch template for a separate, smaller background-jobs pool (captions + MP4). | `bool` | `false` |
| `jobs_role_tag` | `role` tag for the background-jobs pool. | `string` | `"evs-transcoder-jobs"` |
| `bucket_names` | Map uploads/media/downloads -> bucket name. | `map(string)` | required |
| `bucket_arns` | Map uploads/media/downloads -> bucket ARN. | `map(string)` | required |
| `kms_key_arn` | CMK for content-key wrapping and SSE-KMS buckets. | `string` | required |
| `kms_key_alias` | Alias passed to the worker as KMS_KEY_ID. | `string` | required |
| `shared_secret_arn` | Secret <prefix>/shared. | `string` | required |
| `db_address` | Database hostname. | `string` | required |
| `db_port` | Database port. | `number` | `5432` |
| `db_name` | Database name. | `string` | required |
| `db_secret_arn` | RDS-managed master user secret. | `string` | required |
| `db_security_group_id` | DB security group to grant ingress on. | `string` | required |
| `log_retention_days` | CloudWatch Logs retention. | `number` | `30` |
| `extra_environment` | Additional worker environment (ladder tuning, captions, ...). | `map(string)` | `{}` |

## Outputs

| Name | Description |
|---|---|
| `launch_template_name` | Primary pool launch template (LAUNCH_TEMPLATE_NAME). |
| `jobs_launch_template_name` | Background-jobs pool launch template (JOBS_LAUNCH_TEMPLATE_NAME), or null. |
| `launch_template_arns` | ARNs of every pool's launch template. |
| `role_arn` | Worker IAM role (the orchestrator needs iam:PassRole on it). |
| `security_group_id` | Worker security group. |
| `role_tag` | Primary pool role tag. |
| `jobs_role_tag` | Jobs pool role tag. |
