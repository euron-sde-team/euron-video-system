output "alb_dns_name" {
  description = "Point your API DNS record (CNAME/alias) here."
  value       = aws_lb.api.dns_name
}

output "alb_zone_id" {
  description = "Hosted zone of the ALB, for Route 53 alias records."
  value       = aws_lb.api.zone_id
}

output "alb_arn_suffix" {
  description = "CloudWatch dimension for ALB metrics."
  value       = aws_lb.api.arn_suffix
}

output "target_group_arn_suffix" {
  description = "CloudWatch dimension for target-group metrics."
  value       = aws_lb_target_group.api.arn_suffix
}

output "ecr_repository_url" {
  description = "Push api images (and <tag>-tools images) here."
  value       = aws_ecr_repository.api.repository_url
}

output "cluster_name" {
  description = "ECS cluster name."
  value       = aws_ecs_cluster.this.name
}

output "service_name" {
  description = "ECS service name."
  value       = aws_ecs_service.api.name
}

output "task_security_group_id" {
  description = "Security group of API tasks."
  value       = aws_security_group.task.id
}

output "migrate_task_definition" {
  description = "Family of the one-off migration task."
  value       = aws_ecs_task_definition.migrate.family
}
