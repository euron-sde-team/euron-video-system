variable "name_prefix" {
  description = "Prefix for every resource name."
  type        = string
}

variable "alarm_email" {
  description = "Optional email subscribed to the alarm topic (confirm the subscription email)."
  type        = string
  default     = null
}

variable "alb_arn_suffix" {
  description = "ALB CloudWatch dimension."
  type        = string
}

variable "target_group_arn_suffix" {
  description = "Target group CloudWatch dimension."
  type        = string
}

variable "ecs_cluster_name" {
  description = "ECS cluster name."
  type        = string
}

variable "ecs_service_name" {
  description = "ECS service name."
  type        = string
}

variable "db_instance_identifier" {
  description = "RDS instance identifier."
  type        = string
}

variable "orchestrator_function_name" {
  description = "Orchestrator Lambda name."
  type        = string
}

variable "orchestrator_dlq_name" {
  description = "Orchestrator dead-letter queue name."
  type        = string
}
