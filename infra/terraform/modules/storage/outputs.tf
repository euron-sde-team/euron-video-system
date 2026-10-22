output "bucket_names" {
  description = "Map of purpose (uploads, media, downloads) to bucket name."
  value       = { for k, b in aws_s3_bucket.this : k => b.id }
}

output "bucket_arns" {
  description = "Map of purpose to bucket ARN."
  value       = { for k, b in aws_s3_bucket.this : k => b.arn }
}

output "media_bucket_regional_domain_name" {
  description = "Regional domain of the media bucket (CloudFront origin)."
  value       = aws_s3_bucket.this["media"].bucket_regional_domain_name
}
