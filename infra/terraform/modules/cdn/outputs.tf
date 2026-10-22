output "distribution_id" {
  description = "CloudFront distribution id (for invalidations)."
  value       = aws_cloudfront_distribution.media.id
}

output "distribution_arn" {
  description = "Distribution ARN, granted read on the media bucket via OAC."
  value       = aws_cloudfront_distribution.media.arn
}

output "domain_name" {
  description = "Distribution domain, e.g. dxxxx.cloudfront.net."
  value       = aws_cloudfront_distribution.media.domain_name
}

output "media_public_base" {
  description = "MEDIA_PUBLIC_BASE for the API."
  value       = "https://${length(var.aliases) > 0 ? var.aliases[0] : aws_cloudfront_distribution.media.domain_name}"
}

output "key_pair_id" {
  description = "CLOUDFRONT_KEY_PAIR_ID for the API (the public key id)."
  value       = aws_cloudfront_public_key.signer.id
}
