data "aws_region" "current" {}
data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}

data "archive_file" "lambda" {
  type        = "zip"
  source_dir  = var.lambda_source_dir
  output_path = "${path.root}/.build/${var.name_prefix}-orchestrator.zip"
}

resource "aws_cloudwatch_log_group" "lambda" {
  name              = "/aws/lambda/${var.name_prefix}-orchestrator"
  retention_in_days = var.log_retention_days
}

resource "aws_security_group" "lambda" {
  name        = "${var.name_prefix}-orchestrator"
  description = "Orchestrator Lambda: egress to EC2/Secrets Manager APIs and PostgreSQL"
  vpc_id      = var.vpc_id
  tags        = { Name = "${var.name_prefix}-orchestrator" }
}

resource "aws_vpc_security_group_egress_rule" "https" {
  security_group_id = aws_security_group.lambda.id
  description       = "HTTPS to AWS APIs"
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
}

resource "aws_vpc_security_group_egress_rule" "db" {
  security_group_id            = aws_security_group.lambda.id
  description                  = "To PostgreSQL"
  referenced_security_group_id = var.db_security_group_id
  ip_protocol                  = "tcp"
  from_port                    = var.db_port
  to_port                      = var.db_port
}

resource "aws_vpc_security_group_ingress_rule" "db_from_lambda" {
  security_group_id            = var.db_security_group_id
  description                  = "From the orchestrator"
  referenced_security_group_id = aws_security_group.lambda.id
  ip_protocol                  = "tcp"
  from_port                    = var.db_port
  to_port                      = var.db_port
}

# ─── IAM ─────────────────────────────────────────────────────────────────────

data "aws_iam_policy_document" "assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "lambda" {
  name               = "${var.name_prefix}-orchestrator"
  assume_role_policy = data.aws_iam_policy_document.assume.json
}

resource "aws_iam_role_policy_attachment" "xray" {
  role       = aws_iam_role.lambda.name
  policy_arn = "arn:${data.aws_partition.current.partition}:iam::aws:policy/AWSXRayDaemonWriteAccess"
}

resource "aws_iam_role_policy_attachment" "vpc" {
  role       = aws_iam_role.lambda.name
  policy_arn = "arn:${data.aws_partition.current.partition}:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole"
}

data "aws_iam_policy_document" "lambda" {
  statement {
    sid       = "Observe"
    actions   = ["ec2:DescribeInstances", "ec2:DescribeLaunchTemplates", "ec2:DescribeLaunchTemplateVersions", "ec2:DescribeSubnets"]
    resources = ["*"]
  }
  statement {
    sid       = "LaunchFleet"
    actions   = ["ec2:CreateFleet", "ec2:RunInstances", "ec2:CreateTags"]
    resources = ["*"]
    # Launches only ever happen from this deployment's launch templates.
    condition {
      test     = "StringEquals"
      variable = "aws:RequestedRegion"
      values   = [data.aws_region.current.region]
    }
  }
  statement {
    sid       = "PassWorkerRoleOnly"
    actions   = ["iam:PassRole"]
    resources = [var.worker_role_arn]
    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values   = ["ec2.amazonaws.com"]
    }
  }
  statement {
    sid       = "SpotServiceLinkedRole"
    actions   = ["iam:CreateServiceLinkedRole"]
    resources = ["*"]
    condition {
      test     = "StringEquals"
      variable = "iam:AWSServiceName"
      values   = ["spot.amazonaws.com", "ec2fleet.amazonaws.com"]
    }
  }
  statement {
    sid       = "ReadDbSecret"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [var.db_secret_arn]
  }
  statement {
    sid       = "DecryptDbSecret"
    actions   = ["kms:Decrypt"]
    resources = [var.kms_key_arn]
    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["secretsmanager.${data.aws_region.current.region}.amazonaws.com"]
    }
  }
  statement {
    sid       = "DeadLetter"
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.dlq.arn]
  }
}

resource "aws_iam_role_policy" "lambda" {
  name   = "controller"
  role   = aws_iam_role.lambda.id
  policy = data.aws_iam_policy_document.lambda.json
}

# ─── Function ────────────────────────────────────────────────────────────────

resource "aws_sqs_queue" "dlq" {
  name                      = "${var.name_prefix}-orchestrator-dlq"
  message_retention_seconds = 1209600
  sqs_managed_sse_enabled   = true
}

resource "aws_lambda_function" "this" {
  function_name    = "${var.name_prefix}-orchestrator"
  description      = "Reaps stale claims and scales EC2 Spot workers from the queue backlog"
  role             = aws_iam_role.lambda.arn
  runtime          = "nodejs22.x"
  architectures    = ["arm64"]
  handler          = "index.handler"
  filename         = data.archive_file.lambda.output_path
  source_code_hash = data.archive_file.lambda.output_base64sha256
  memory_size      = 256
  timeout          = 50
  # Exactly one tick at a time: overlapping ticks would double-launch.
  reserved_concurrent_executions = 1

  tracing_config {
    mode = "Active"
  }

  vpc_config {
    subnet_ids         = var.private_subnet_ids
    security_group_ids = [aws_security_group.lambda.id]
  }

  dead_letter_config {
    target_arn = aws_sqs_queue.dlq.arn
  }

  logging_config {
    log_format = "Text"
    log_group  = aws_cloudwatch_log_group.lambda.name
  }

  environment {
    variables = {
      NODE_ENV                  = "production"
      EVS_SERVICE               = "orchestrator"
      LAUNCHER                  = "ec2-spot"
      DATABASE_SECRET_ARN       = var.db_secret_arn
      DB_HOST                   = var.db_address
      DB_PORT                   = tostring(var.db_port)
      DB_NAME                   = var.db_name
      DB_USER                   = var.db_username
      DB_SSL                    = "require"
      LAUNCH_TEMPLATE_NAME      = var.launch_template_name
      JOBS_LAUNCH_TEMPLATE_NAME = var.jobs_launch_template_name == null ? "" : var.jobs_launch_template_name
      WORKER_SUBNET_IDS         = join(",", var.worker_subnet_ids)
      WORKER_INSTANCE_TYPES     = join(",", var.worker_instance_types)
      JOBS_INSTANCE_TYPES       = join(",", var.jobs_instance_types)
      WORKER_ROLE_TAG           = var.role_tag
      JOBS_ROLE_TAG             = var.jobs_role_tag
      MAX_WORKERS               = tostring(var.max_workers)
      JOBS_MAX_WORKERS          = tostring(var.jobs_max_workers)
      ONDEMAND_FALLBACK         = tostring(var.ondemand_fallback)
    }
  }
}

# ─── Schedule ────────────────────────────────────────────────────────────────

data "aws_iam_policy_document" "scheduler_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["scheduler.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }
  }
}

resource "aws_iam_role" "scheduler" {
  name               = "${var.name_prefix}-orchestrator-scheduler"
  assume_role_policy = data.aws_iam_policy_document.scheduler_assume.json
}

data "aws_iam_policy_document" "scheduler" {
  statement {
    actions   = ["lambda:InvokeFunction"]
    resources = [aws_lambda_function.this.arn]
  }
  statement {
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.dlq.arn]
  }
  statement {
    actions   = ["kms:Decrypt"]
    resources = [var.kms_key_arn]
  }
}

resource "aws_iam_role_policy" "scheduler" {
  name   = "invoke"
  role   = aws_iam_role.scheduler.id
  policy = data.aws_iam_policy_document.scheduler.json
}

resource "aws_scheduler_schedule" "tick" {
  name                = "${var.name_prefix}-orchestrator"
  description         = "Autoscaler tick"
  schedule_expression = var.schedule_expression
  kms_key_arn         = var.kms_key_arn
  flexible_time_window {
    mode = "OFF"
  }
  target {
    arn      = aws_lambda_function.this.arn
    role_arn = aws_iam_role.scheduler.arn
    retry_policy {
      # A missed tick is superseded by the next one; never pile up retries.
      maximum_retry_attempts       = 0
      maximum_event_age_in_seconds = 60
    }
    dead_letter_config {
      arn = aws_sqs_queue.dlq.arn
    }
  }
}
