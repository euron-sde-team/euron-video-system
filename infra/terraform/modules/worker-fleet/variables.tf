variable "name_prefix" {
  description = "Prefix for every resource name."
  type        = string
}

variable "vpc_id" {
  description = "VPC id."
  type        = string
}

variable "ami_id" {
  description = "Worker AMI built by infra/packer/worker.pkr.hcl (arm64)."
  type        = string
}

variable "default_instance_type" {
  description = "Launch-template default. The orchestrator overrides it per launch from its instance-type ladder."
  type        = string
  default     = "c7g.xlarge"
}

variable "root_volume_gb" {
  description = "gp3 scratch volume for sources and renditions. Size for your largest source x ~3."
  type        = number
  default     = 100
}

variable "role_tag" {
  description = "Value of the `role` tag the orchestrator counts primary workers by."
  type        = string
  default     = "evs-transcoder"
}

variable "enable_jobs_pool" {
  description = "Also create a launch template for a separate, smaller background-jobs pool (captions + MP4)."
  type        = bool
  default     = false
}

variable "jobs_role_tag" {
  description = "`role` tag for the background-jobs pool."
  type        = string
  default     = "evs-transcoder-jobs"
}

variable "bucket_names" {
  description = "Map uploads/media/downloads -> bucket name."
  type        = map(string)
}

variable "bucket_arns" {
  description = "Map uploads/media/downloads -> bucket ARN."
  type        = map(string)
}

variable "kms_key_arn" {
  description = "CMK for content-key wrapping and SSE-KMS buckets."
  type        = string
}

variable "kms_key_alias" {
  description = "Alias passed to the worker as KMS_KEY_ID."
  type        = string
}

variable "shared_secret_arn" {
  description = "Secret <prefix>/shared."
  type        = string
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
  description = "RDS-managed master user secret."
  type        = string
}

variable "db_security_group_id" {
  description = "DB security group to grant ingress on."
  type        = string
}

variable "log_retention_days" {
  description = "CloudWatch Logs retention."
  type        = number
  default     = 30
}

variable "extra_environment" {
  description = "Additional worker environment (ladder tuning, captions, ...)."
  type        = map(string)
  default     = {}
}

variable "db_username" {
  description = "Database user. The password is read from db_secret_arn at runtime for every new connection, so rotation needs no restart."
  type        = string
}
