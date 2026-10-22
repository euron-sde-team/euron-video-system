variable "name_prefix" {
  description = "Prefix for every resource name."
  type        = string
}

variable "vpc_id" {
  description = "VPC id."
  type        = string
}

variable "public_subnet_ids" {
  description = "Subnets for the internet-facing ALB."
  type        = list(string)
}

variable "private_subnet_ids" {
  description = "Subnets for Fargate tasks."
  type        = list(string)
}

variable "certificate_arn" {
  description = "ACM certificate (same region) for the HTTPS listener."
  type        = string
}

variable "image_tag" {
  description = "Image tag in the module's ECR repository to deploy (tags are immutable). The migration task uses \"<tag>-tools\"."
  type        = string
}

variable "image_override" {
  description = "Full image reference to run instead of the module's ECR repository (e.g. ghcr.io/<org>/evs-api:0.1.0)."
  type        = string
  default     = null
}

variable "cpu" {
  description = "Task CPU units."
  type        = number
  default     = 1024
}

variable "memory" {
  description = "Task memory (MiB)."
  type        = number
  default     = 2048
}

variable "desired_count" {
  description = "Initial task count."
  type        = number
  default     = 2
}

variable "min_count" {
  description = "Autoscaling floor."
  type        = number
  default     = 2
}

variable "max_count" {
  description = "Autoscaling ceiling."
  type        = number
  default     = 10
}

variable "cluster_workers" {
  description = "Node cluster workers per task (0 = one per vCPU)."
  type        = number
  default     = 0
}

variable "public_api_base" {
  description = "Public HTTPS base URL of the API, e.g. https://api.video.example.com."
  type        = string
}

variable "cors_allowed_origins" {
  description = "Browser origins allowed to call the management API (the console)."
  type        = list(string)
  default     = []
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
  description = "CMK that wraps content keys and encrypts buckets/secrets."
  type        = string
}

variable "kms_key_alias" {
  description = "Alias passed to the app as KMS_KEY_ID."
  type        = string
}

variable "shared_secret_arn" {
  description = "Secret <prefix>/shared."
  type        = string
}

variable "api_secret_arn" {
  description = "Secret <prefix>/api."
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
  description = "RDS-managed master user secret (JSON username/password)."
  type        = string
}

variable "db_security_group_id" {
  description = "DB security group to grant ingress on."
  type        = string
}

variable "delivery_driver" {
  description = "cloudfront-signed | presigned | proxy | public."
  type        = string
  default     = "cloudfront-signed"
}

variable "media_public_base" {
  description = "CloudFront base URL for media."
  type        = string
  default     = null
}

variable "cloudfront_key_pair_id" {
  description = "CloudFront public key id used for signing."
  type        = string
  default     = null
}

variable "deletion_protection" {
  description = "Protect the load balancer from deletion."
  type        = bool
  default     = true
}

variable "access_logs_bucket" {
  description = "Optional S3 bucket for ALB access logs (must allow the regional ELB principal)."
  type        = string
  default     = null
}

variable "log_retention_days" {
  description = "CloudWatch Logs retention."
  type        = number
  default     = 30
}

variable "extra_environment" {
  description = "Additional plain environment variables (see docs/guides/configuration.md)."
  type        = map(string)
  default     = {}
}

variable "db_username" {
  description = "Database user. The password is read from db_secret_arn at runtime for every new connection, so rotation needs no restart."
  type        = string
}
