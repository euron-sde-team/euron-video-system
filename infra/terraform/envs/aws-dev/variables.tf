variable "region" {
  description = "AWS region."
  type        = string
  default     = "us-east-1"
}

variable "environment" {
  description = "Environment label used in tags."
  type        = string
  default     = "dev"
}

variable "name_prefix" {
  description = "Prefix for every resource name. Bucket names derive from it and must be globally unique."
  type        = string
  default     = "evs-dev"
}

variable "extra_tags" {
  description = "Additional tags applied to every resource."
  type        = map(string)
  default     = {}
}

variable "api_domain" {
  description = "Public hostname of the API, e.g. api.video.example.com. Point it at the alb_dns_name output."
  type        = string
}

variable "api_certificate_arn" {
  description = "ACM certificate (this region) for api_domain."
  type        = string
}

variable "console_origins" {
  description = "Origins of the operator console and players that call the API / fetch media."
  type        = list(string)
  default     = []
}

variable "media_aliases" {
  description = "Optional custom domains for the media CDN, e.g. [\"media.video.example.com\"]."
  type        = list(string)
  default     = []
}

variable "media_certificate_arn" {
  description = "ACM certificate in us-east-1 for media_aliases (CloudFront requirement)."
  type        = string
  default     = null
}

variable "worker_ami_id" {
  description = "AMI built from infra/packer/worker.pkr.hcl."
  type        = string
}

variable "api_image_tag" {
  description = "Tag of the api image in the ECR repository created by this stack (immutable, e.g. a release version or git SHA)."
  type        = string
}

variable "max_workers" {
  description = "Ceiling on concurrent transcode workers."
  type        = number
  default     = 5
}

variable "enable_jobs_pool" {
  description = "Run captions/MP4 jobs on a separate, smaller instance pool."
  type        = bool
  default     = false
}

variable "alarm_email" {
  description = "Optional email for CloudWatch alarm notifications."
  type        = string
  default     = null
}
