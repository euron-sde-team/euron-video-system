output "api_alb_dns_name" {
  description = "Create a DNS record for api_domain pointing here."
  value       = module.api.alb_dns_name
}

output "api_ecr_repository_url" {
  description = "Push the api image (and <tag>-tools) here."
  value       = module.api.ecr_repository_url
}

output "migrate_task_definition" {
  description = "Run once per release: aws ecs run-task --task-definition <this> ..."
  value       = module.api.migrate_task_definition
}

output "ecs_cluster_name" {
  description = "ECS cluster."
  value       = module.api.cluster_name
}

output "private_subnet_ids" {
  description = "For `aws ecs run-task --network-configuration`."
  value       = module.network.private_subnet_ids
}

output "api_task_security_group_id" {
  description = "For `aws ecs run-task --network-configuration`."
  value       = module.api.task_security_group_id
}

output "bucket_names" {
  description = "uploads / media / downloads."
  value       = module.storage.bucket_names
}

output "kms_key_alias" {
  description = "KMS_KEY_ID."
  value       = module.kms.alias_name
}

output "media_public_base" {
  description = "MEDIA_PUBLIC_BASE."
  value       = module.cdn.media_public_base
}

output "cloudfront_key_pair_id" {
  description = "CLOUDFRONT_KEY_PAIR_ID."
  value       = module.cdn.key_pair_id
}

output "api_secret_arn" {
  description = "Holds CLOUDFRONT_PRIVATE_KEY etc. (for compose.aws.yaml local runs)."
  value       = module.secrets.api_secret_arn
}

output "cloudfront_private_key_pem" {
  description = "CloudFront signing private key, for key-pair rotation only. Read with: terraform output -raw cloudfront_private_key_pem"
  value       = module.secrets.cloudfront_private_key_pem
  sensitive   = true
}
