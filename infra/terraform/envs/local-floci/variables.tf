variable "endpoint" {
  description = "Emulator endpoint. http://localhost:4566 from the host, http://floci:4566 inside compose."
  type        = string
  default     = "http://localhost:4566"
}

variable "name_prefix" {
  description = "Must match the bucket names and KMS alias in deploy/compose/compose.floci.yaml."
  type        = string
  default     = "evs-local"
}

variable "cors_origins" {
  description = "Browser origins (console, players) allowed to upload and fetch media."
  type        = list(string)
  default     = ["http://localhost:3000", "http://localhost:8080"]
}

variable "enable_cdn" {
  description = "Also create the CloudFront distribution in the emulator (management plane only: it does not serve traffic locally)."
  type        = bool
  default     = false
}
