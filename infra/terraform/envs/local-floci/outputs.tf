output "bucket_names" {
  description = "uploads / media / downloads."
  value       = module.storage.bucket_names
}

output "kms_key_id" {
  description = "Content-key wrapping key."
  value       = module.kms.key_id
}

output "kms_key_alias" {
  description = "KMS_KEY_ID used by compose."
  value       = module.kms.alias_name
}

output "cdn_domain_name" {
  description = "Emulated distribution domain (enable_cdn = true only)."
  value       = var.enable_cdn ? module.cdn[0].domain_name : null
}
