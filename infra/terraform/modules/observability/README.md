# `observability` module

SNS alarm topic (optional email), CloudWatch alarms for API 5xx, unhealthy targets, API and DB CPU, autoscaler errors and DLQ depth, and a dashboard covering traffic, latency, ECS, RDS and the autoscaler.

## Inputs

| Name | Description | Type | Default |
|---|---|---|---|
| `name_prefix` | Prefix for every resource name. | `string` | required |
| `alarm_email` | Optional email subscribed to the alarm topic (confirm the subscription email). | `string` | `null` |
| `alb_arn_suffix` | ALB CloudWatch dimension. | `string` | required |
| `target_group_arn_suffix` | Target group CloudWatch dimension. | `string` | required |
| `ecs_cluster_name` | ECS cluster name. | `string` | required |
| `ecs_service_name` | ECS service name. | `string` | required |
| `db_instance_identifier` | RDS instance identifier. | `string` | required |
| `orchestrator_function_name` | Orchestrator Lambda name. | `string` | required |
| `orchestrator_dlq_name` | Orchestrator dead-letter queue name. | `string` | required |

## Outputs

| Name | Description |
|---|---|
| `alarm_topic_arn` | SNS topic every alarm notifies. |
| `dashboard_name` | CloudWatch dashboard name. |
