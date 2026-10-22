variable "name_prefix" {
  description = "Prefix for every resource name."
  type        = string
}

variable "vpc_id" {
  description = "VPC id."
  type        = string
}

variable "private_subnet_ids" {
  description = "Subnets the Lambda runs in (needs NAT or endpoints for EC2 + Secrets Manager)."
  type        = list(string)
}

variable "lambda_source_dir" {
  description = "Directory containing the built handler (apps/orchestrator/dist/lambda: index.js + package.json)."
  type        = string
}

variable "schedule_expression" {
  description = "How often the controller ticks."
  type        = string
  default     = "rate(1 minute)"
}

variable "db_address" {
  description = "Database hostname."
  type        = string
}

variable "db_port" {
  description = "Database port."
  type        = number
  default     = 5432
}

variable "db_name" {
  description = "Database name."
  type        = string
}

variable "db_secret_arn" {
  description = "RDS-managed master user secret; the handler builds its connection string from it."
  type        = string
}

variable "db_security_group_id" {
  description = "DB security group to grant ingress on."
  type        = string
}

variable "kms_key_arn" {
  description = "CMK that encrypts the DB secret."
  type        = string
}

variable "worker_subnet_ids" {
  description = "Subnets (one per AZ) the controller fans worker launches across."
  type        = list(string)
}

variable "worker_role_arn" {
  description = "Worker IAM role the launched instances assume (iam:PassRole is scoped to it)."
  type        = string
}

variable "launch_template_name" {
  description = "Primary pool launch template."
  type        = string
}

variable "jobs_launch_template_name" {
  description = "Background-jobs pool launch template; null = single pool."
  type        = string
  default     = null
}

variable "worker_instance_types" {
  description = "Strict preference ladder, highest first. Must match the AMI architecture."
  type        = list(string)
  default     = ["c7g.4xlarge", "c7g.2xlarge", "c7g.xlarge", "c6g.xlarge", "m7g.xlarge"]
}

variable "jobs_instance_types" {
  description = "Instance ladder for the jobs pool."
  type        = list(string)
  default     = ["c7g.xlarge", "c6g.xlarge", "m7g.xlarge"]
}

variable "role_tag" {
  description = "Primary pool `role` tag."
  type        = string
}

variable "jobs_role_tag" {
  description = "Jobs pool `role` tag."
  type        = string
}

variable "max_workers" {
  description = "Hard ceiling on primary workers."
  type        = number
  default     = 20
}

variable "jobs_max_workers" {
  description = "Hard ceiling on jobs workers."
  type        = number
  default     = 10
}

variable "ondemand_fallback" {
  description = "Fall back to On-Demand when no Spot pool has capacity."
  type        = bool
  default     = false
}

variable "log_retention_days" {
  description = "CloudWatch Logs retention."
  type        = number
  default     = 30
}

variable "db_username" {
  description = "Database user. The password is read from db_secret_arn at runtime for every new connection, so rotation needs no restart."
  type        = string
}
