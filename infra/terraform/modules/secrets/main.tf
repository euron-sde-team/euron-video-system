# Application secrets, generated here so no human ever sees or copies them.
#
# They are split by consumer for least privilege:
#   <prefix>/shared  DATA_ENCRYPTION_KEY                      api + workers
#   <prefix>/api     API_KEY_PEPPER, PLAYBACK_SIGNING_KEYS,   api only
#                    CLOUDFRONT_PRIVATE_KEY
#
# Generated values are stored in Terraform state: use an encrypted remote
# backend with tight access (see envs/*/backend.tf.example).

resource "random_password" "data_encryption_key" {
  length  = 64
  special = false
}

resource "random_password" "api_key_pepper" {
  length  = 64
  special = false
}

resource "random_password" "playback_signing_key" {
  length  = 64
  special = false
}

resource "tls_private_key" "cloudfront" {
  algorithm = "RSA"
  rsa_bits  = 2048
}

resource "aws_secretsmanager_secret" "shared" {
  name                    = "${var.name_prefix}/shared"
  description             = "Secrets shared by the API and transcode workers"
  kms_key_id              = var.kms_key_arn
  recovery_window_in_days = var.recovery_window_in_days
}

resource "aws_secretsmanager_secret_version" "shared" {
  secret_id = aws_secretsmanager_secret.shared.id
  secret_string = jsonencode({
    DATA_ENCRYPTION_KEY = random_password.data_encryption_key.result
  })
}

resource "aws_secretsmanager_secret" "api" {
  name                    = "${var.name_prefix}/api"
  description             = "Secrets only the API may read"
  kms_key_id              = var.kms_key_arn
  recovery_window_in_days = var.recovery_window_in_days
}

resource "aws_secretsmanager_secret_version" "api" {
  secret_id = aws_secretsmanager_secret.api.id
  secret_string = jsonencode({
    API_KEY_PEPPER         = random_password.api_key_pepper.result
    PLAYBACK_SIGNING_KEYS  = "k1=${random_password.playback_signing_key.result}"
    PLAYBACK_ACTIVE_KID    = "k1"
    CLOUDFRONT_PRIVATE_KEY = tls_private_key.cloudfront.private_key_pem
  })

  # Terraform seeds this secret; operators own its value afterwards. Without
  # this, the documented zero-downtime rotation (add k2 to
  # PLAYBACK_SIGNING_KEYS, switch PLAYBACK_ACTIVE_KID, drop k1 after one max
  # TTL) would be silently reverted by the next apply.
  # See docs/guides/operations.md.
  lifecycle {
    ignore_changes = [secret_string]
  }
}
