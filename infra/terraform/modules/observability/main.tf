data "aws_region" "current" {}

resource "aws_sns_topic" "alarms" {
  name              = "${var.name_prefix}-alarms"
  kms_master_key_id = "alias/aws/sns"
}

resource "aws_sns_topic_subscription" "email" {
  count     = var.alarm_email == null ? 0 : 1
  topic_arn = aws_sns_topic.alarms.arn
  protocol  = "email"
  endpoint  = var.alarm_email
}

locals {
  alarms = {
    api-5xx = {
      description = "API returned 5xx responses"
      namespace   = "AWS/ApplicationELB"
      metric      = "HTTPCode_Target_5XX_Count"
      stat        = "Sum"
      threshold   = 25
      period      = 300
      dimensions  = { LoadBalancer = var.alb_arn_suffix }
    }
    api-unhealthy-targets = {
      description = "API tasks failing health checks"
      namespace   = "AWS/ApplicationELB"
      metric      = "UnHealthyHostCount"
      stat        = "Maximum"
      threshold   = 0
      period      = 60
      dimensions  = { LoadBalancer = var.alb_arn_suffix, TargetGroup = var.target_group_arn_suffix }
    }
    api-cpu-high = {
      description = "API service CPU sustained above 85%"
      namespace   = "AWS/ECS"
      metric      = "CPUUtilization"
      stat        = "Average"
      threshold   = 85
      period      = 300
      dimensions  = { ClusterName = var.ecs_cluster_name, ServiceName = var.ecs_service_name }
    }
    db-cpu-high = {
      description = "Database CPU sustained above 80%"
      namespace   = "AWS/RDS"
      metric      = "CPUUtilization"
      stat        = "Average"
      threshold   = 80
      period      = 300
      dimensions  = { DBInstanceIdentifier = var.db_instance_identifier }
    }
    orchestrator-errors = {
      description = "Autoscaler tick failed (workers may not be launching)"
      namespace   = "AWS/Lambda"
      metric      = "Errors"
      stat        = "Sum"
      threshold   = 2
      period      = 300
      dimensions  = { FunctionName = var.orchestrator_function_name }
    }
    orchestrator-dlq = {
      description = "Autoscaler ticks landed in the dead-letter queue"
      namespace   = "AWS/SQS"
      metric      = "ApproximateNumberOfMessagesVisible"
      stat        = "Maximum"
      threshold   = 0
      period      = 300
      dimensions  = { QueueName = var.orchestrator_dlq_name }
    }
  }
}

resource "aws_cloudwatch_metric_alarm" "this" {
  for_each            = local.alarms
  alarm_name          = "${var.name_prefix}-${each.key}"
  alarm_description   = each.value.description
  namespace           = each.value.namespace
  metric_name         = each.value.metric
  statistic           = each.value.stat
  dimensions          = each.value.dimensions
  period              = each.value.period
  evaluation_periods  = 2
  threshold           = each.value.threshold
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alarms.arn]
  ok_actions          = [aws_sns_topic.alarms.arn]
}

resource "aws_cloudwatch_dashboard" "this" {
  dashboard_name = var.name_prefix
  dashboard_body = jsonencode({
    widgets = [
      {
        type = "metric", x = 0, y = 0, width = 12, height = 6
        properties = {
          title = "API requests and errors", region = data.aws_region.current.region, stat = "Sum", period = 60
          metrics = [
            ["AWS/ApplicationELB", "RequestCount", "LoadBalancer", var.alb_arn_suffix],
            [".", "HTTPCode_Target_4XX_Count", ".", "."],
            [".", "HTTPCode_Target_5XX_Count", ".", "."],
          ]
        }
      },
      {
        type = "metric", x = 12, y = 0, width = 12, height = 6
        properties = {
          title = "API latency (p50 / p99)", region = data.aws_region.current.region, period = 60
          metrics = [
            ["AWS/ApplicationELB", "TargetResponseTime", "LoadBalancer", var.alb_arn_suffix, { stat = "p50" }],
            ["...", { stat = "p99" }],
          ]
        }
      },
      {
        type = "metric", x = 0, y = 6, width = 12, height = 6
        properties = {
          title = "API service CPU / memory", region = data.aws_region.current.region, stat = "Average", period = 60
          metrics = [
            ["AWS/ECS", "CPUUtilization", "ClusterName", var.ecs_cluster_name, "ServiceName", var.ecs_service_name],
            [".", "MemoryUtilization", ".", ".", ".", "."],
          ]
        }
      },
      {
        type = "metric", x = 12, y = 6, width = 12, height = 6
        properties = {
          title = "Database", region = data.aws_region.current.region, stat = "Average", period = 60
          metrics = [
            ["AWS/RDS", "CPUUtilization", "DBInstanceIdentifier", var.db_instance_identifier],
            [".", "DatabaseConnections", ".", "."],
          ]
        }
      },
      {
        type = "metric", x = 0, y = 12, width = 24, height = 6
        properties = {
          title = "Autoscaler", region = data.aws_region.current.region, stat = "Sum", period = 60
          metrics = [
            ["AWS/Lambda", "Invocations", "FunctionName", var.orchestrator_function_name],
            [".", "Errors", ".", "."],
            [".", "Duration", ".", ".", { stat = "Average" }],
          ]
        }
      },
    ]
  })
}
