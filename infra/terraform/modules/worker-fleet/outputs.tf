output "launch_template_name" {
  description = "Primary pool launch template (LAUNCH_TEMPLATE_NAME)."
  value       = aws_launch_template.pool["primary"].name
}

output "jobs_launch_template_name" {
  description = "Background-jobs pool launch template (JOBS_LAUNCH_TEMPLATE_NAME), or null."
  value       = var.enable_jobs_pool ? aws_launch_template.pool["jobs"].name : null
}

output "launch_template_arns" {
  description = "ARNs of every pool's launch template."
  value       = [for lt in aws_launch_template.pool : lt.arn]
}

output "role_arn" {
  description = "Worker IAM role (the orchestrator needs iam:PassRole on it)."
  value       = aws_iam_role.worker.arn
}

output "security_group_id" {
  description = "Worker security group."
  value       = aws_security_group.worker.id
}

output "role_tag" {
  description = "Primary pool role tag."
  value       = var.role_tag
}

output "jobs_role_tag" {
  description = "Jobs pool role tag."
  value       = var.jobs_role_tag
}
