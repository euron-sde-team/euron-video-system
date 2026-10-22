variable "name_prefix" {
  description = "Prefix for secret names: <prefix>/shared and <prefix>/api."
  type        = string
}

variable "kms_key_arn" {
  description = "CMK that encrypts the secrets. Null = the AWS-managed aws/secretsmanager key."
  type        = string
  default     = null
}

variable "recovery_window_in_days" {
  description = "Days a deleted secret stays recoverable (0 = immediate, for throwaway envs)."
  type        = number
  default     = 30
}
