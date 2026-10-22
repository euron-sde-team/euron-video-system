variable "name_prefix" {
  description = "Prefix for every resource name."
  type        = string
}

variable "media_bucket_regional_domain_name" {
  description = "Origin: the media bucket's regional domain name."
  type        = string
}

variable "signing_public_key_pem" {
  description = "RSA public key (PEM) whose private half the API uses to sign CloudFront policies."
  type        = string
}

variable "cors_allowed_origins" {
  description = "Player origins allowed to fetch segments cross-origin. Empty = any origin (segments are signed regardless)."
  type        = list(string)
  default     = []
}

variable "aliases" {
  description = "Custom domain names, e.g. [\"media.example.com\"]. Requires acm_certificate_arn."
  type        = list(string)
  default     = []
}

variable "acm_certificate_arn" {
  description = "ACM certificate in us-east-1 covering every alias."
  type        = string
  default     = null
}

variable "price_class" {
  description = "PriceClass_All | PriceClass_200 | PriceClass_100."
  type        = string
  default     = "PriceClass_100"
}

variable "logging_bucket_domain_name" {
  description = "Optional <bucket>.s3.amazonaws.com for standard access logs."
  type        = string
  default     = null
}

variable "web_acl_arn" {
  description = "Optional WAFv2 web ACL (scope CLOUDFRONT) to attach."
  type        = string
  default     = null
}
