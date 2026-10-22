output "shared_secret_arn" {
  description = "ARN of <prefix>/shared."
  value       = aws_secretsmanager_secret.shared.arn
}

output "api_secret_arn" {
  description = "ARN of <prefix>/api."
  value       = aws_secretsmanager_secret.api.arn
}

output "cloudfront_public_key_pem" {
  description = "Public half of the CloudFront signing key (feed to the cdn module)."
  value       = tls_private_key.cloudfront.public_key_pem
}

output "cloudfront_private_key_pem" {
  description = "CloudFront signing private key. Only needed when rotating the key pair (see docs/guides/operations.md); the API reads it from the api secret."
  value       = tls_private_key.cloudfront.private_key_pem
  sensitive   = true
}
