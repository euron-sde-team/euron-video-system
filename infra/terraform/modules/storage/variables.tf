variable "name_prefix" {
  description = "Prefix for bucket names: <prefix>-uploads, <prefix>-media, <prefix>-downloads. Must be globally unique on AWS."
  type        = string
}

variable "kms_key_arn" {
  description = "CMK for SSE-KMS on the uploads and downloads buckets. Null = SSE-S3."
  type        = string
  default     = null
}

variable "upload_expiration_days" {
  description = "Raw sources are deleted this many days after upload (outputs are kept)."
  type        = number
  default     = 7
}

variable "cors_allowed_origins" {
  description = "Browser origins allowed to POST uploads directly to S3 and GET media (presigned delivery)."
  type        = list(string)
  default     = []
}

variable "grant_cloudfront_access" {
  description = "Grant cloudfront_distribution_arn (OAC) read access on the media bucket. A separate flag because the ARN is unknown until apply and for_each keys must be known at plan time."
  type        = bool
  default     = false
}

variable "cloudfront_distribution_arn" {
  description = "Distribution granted read on the media bucket when grant_cloudfront_access is true."
  type        = string
  default     = null
}

variable "enforce_tls" {
  description = "Deny any request that is not over TLS. Disable only for local emulators (plain HTTP)."
  type        = bool
  default     = true
}

variable "enable_lifecycle" {
  description = "Create lifecycle rules (source expiry, abort incomplete multipart uploads)."
  type        = bool
  default     = true
}

variable "force_destroy" {
  description = "Allow terraform destroy to delete non-empty buckets. Keep false outside throwaway environments."
  type        = bool
  default     = false
}
