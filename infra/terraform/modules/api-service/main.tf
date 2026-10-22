data "aws_region" "current" {}
data "aws_caller_identity" "current" {}

locals {
  image       = coalesce(var.image_override, "${aws_ecr_repository.api.repository_url}:${var.image_tag}")
  tools_image = "${local.image}-tools"
  port        = 8080

  environment = merge({
    NODE_ENV               = "production"
    TZ                     = "UTC"
    EVS_CLOUD              = "aws"
    EVS_SERVICE            = "api"
    PORT                   = tostring(local.port)
    CLUSTER_WORKERS        = tostring(var.cluster_workers)
    AWS_REGION             = data.aws_region.current.region
    PUBLIC_API_BASE        = var.public_api_base
    CORS_ALLOWED_ORIGINS   = join(",", var.cors_allowed_origins)
    UPLOADS_BUCKET         = var.bucket_names["uploads"]
    MEDIA_BUCKET           = var.bucket_names["media"]
    DOWNLOADS_BUCKET       = var.bucket_names["downloads"]
    KMS_KEY_ID             = var.kms_key_alias
    DELIVERY_DRIVER        = var.delivery_driver
    MEDIA_PUBLIC_BASE      = var.media_public_base == null ? "" : var.media_public_base
    CLOUDFRONT_KEY_PAIR_ID = var.cloudfront_key_pair_id == null ? "" : var.cloudfront_key_pair_id
    # No password in the environment: the app reads it from the RDS-managed
    # secret per new connection (packages/core/src/db/connection-config.ts),
    # so RDS password rotation takes effect without a redeploy.
    DATABASE_SECRET_ARN = var.db_secret_arn
    DB_HOST             = var.db_address
    DB_PORT             = tostring(var.db_port)
    DB_NAME             = var.db_name
    DB_USER             = var.db_username
    DB_SSL              = "require"
  }, var.extra_environment)

  secrets = [
    { name = "DATA_ENCRYPTION_KEY", valueFrom = "${var.shared_secret_arn}:DATA_ENCRYPTION_KEY::" },
    { name = "API_KEY_PEPPER", valueFrom = "${var.api_secret_arn}:API_KEY_PEPPER::" },
    { name = "PLAYBACK_SIGNING_KEYS", valueFrom = "${var.api_secret_arn}:PLAYBACK_SIGNING_KEYS::" },
    { name = "PLAYBACK_ACTIVE_KID", valueFrom = "${var.api_secret_arn}:PLAYBACK_ACTIVE_KID::" },
    { name = "CLOUDFRONT_PRIVATE_KEY", valueFrom = "${var.api_secret_arn}:CLOUDFRONT_PRIVATE_KEY::" },
  ]
}

# ─── Image registry ──────────────────────────────────────────────────────────

resource "aws_ecr_repository" "api" {
  name                 = "${var.name_prefix}-api"
  image_tag_mutability = "IMMUTABLE"
  image_scanning_configuration {
    scan_on_push = true
  }
  encryption_configuration {
    encryption_type = "KMS"
    kms_key         = var.kms_key_arn
  }
}

resource "aws_ecr_lifecycle_policy" "api" {
  repository = aws_ecr_repository.api.name
  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Keep the 50 most recent images"
      selection    = { tagStatus = "any", countType = "imageCountMoreThan", countNumber = 50 }
      action       = { type = "expire" }
    }]
  })
}

# ─── Networking ──────────────────────────────────────────────────────────────

resource "aws_security_group" "alb" {
  name        = "${var.name_prefix}-alb"
  description = "Public HTTPS into the API load balancer"
  vpc_id      = var.vpc_id
  tags        = { Name = "${var.name_prefix}-alb" }
}

resource "aws_vpc_security_group_ingress_rule" "alb" {
  #checkov:skip=CKV_AWS_260:Port 80 only answers with a 301 to HTTPS (see the http listener).
  for_each          = toset(["80", "443"])
  security_group_id = aws_security_group.alb.id
  description       = "HTTP/HTTPS from the internet (80 only redirects)"
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = tonumber(each.key)
  to_port           = tonumber(each.key)
}

resource "aws_vpc_security_group_egress_rule" "alb_to_tasks" {
  security_group_id            = aws_security_group.alb.id
  description                  = "To API tasks"
  referenced_security_group_id = aws_security_group.task.id
  ip_protocol                  = "tcp"
  from_port                    = local.port
  to_port                      = local.port
}

resource "aws_security_group" "task" {
  name        = "${var.name_prefix}-api-task"
  description = "API tasks; ingress only from the ALB"
  vpc_id      = var.vpc_id
  tags        = { Name = "${var.name_prefix}-api-task" }
}

resource "aws_vpc_security_group_ingress_rule" "task_from_alb" {
  security_group_id            = aws_security_group.task.id
  description                  = "From the ALB"
  referenced_security_group_id = aws_security_group.alb.id
  ip_protocol                  = "tcp"
  from_port                    = local.port
  to_port                      = local.port
}

resource "aws_vpc_security_group_egress_rule" "task_https" {
  security_group_id = aws_security_group.task.id
  description       = "HTTPS to AWS APIs and webhook receivers"
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
}

resource "aws_vpc_security_group_egress_rule" "task_db" {
  security_group_id            = aws_security_group.task.id
  description                  = "To PostgreSQL"
  referenced_security_group_id = var.db_security_group_id
  ip_protocol                  = "tcp"
  from_port                    = var.db_port
  to_port                      = var.db_port
}

resource "aws_vpc_security_group_ingress_rule" "db_from_task" {
  security_group_id            = var.db_security_group_id
  description                  = "From API tasks"
  referenced_security_group_id = aws_security_group.task.id
  ip_protocol                  = "tcp"
  from_port                    = var.db_port
  to_port                      = var.db_port
}

# ─── Load balancer ───────────────────────────────────────────────────────────

resource "aws_lb" "api" {
  name                       = "${var.name_prefix}-api"
  load_balancer_type         = "application"
  internal                   = false
  subnets                    = var.public_subnet_ids
  security_groups            = [aws_security_group.alb.id]
  drop_invalid_header_fields = true
  idle_timeout               = 60
  enable_deletion_protection = var.deletion_protection

  #checkov:skip=CKV_AWS_91:Access logging is opt-in via access_logs_bucket.
  dynamic "access_logs" {
    for_each = var.access_logs_bucket == null ? [] : [1]
    content {
      bucket  = var.access_logs_bucket
      prefix  = "alb"
      enabled = true
    }
  }
}

resource "aws_lb_target_group" "api" {
  name                 = "${var.name_prefix}-api"
  port                 = local.port
  protocol             = "HTTP"
  target_type          = "ip"
  vpc_id               = var.vpc_id
  deregistration_delay = 30
  health_check {
    path                = "/readyz"
    matcher             = "200"
    interval            = 15
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }
}

resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.api.arn
  port              = 80
  protocol          = "HTTP"
  default_action {
    type = "redirect"
    redirect {
      port        = "443"
      protocol    = "HTTPS"
      status_code = "HTTP_301"
    }
  }
}

resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.api.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = var.certificate_arn
  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.api.arn
  }
}

# ─── IAM ─────────────────────────────────────────────────────────────────────

data "aws_iam_policy_document" "ecs_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }
  }
}

# Execution role: pull the image, write logs, inject secrets. Nothing else.
resource "aws_iam_role" "execution" {
  name               = "${var.name_prefix}-api-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

resource "aws_iam_role_policy_attachment" "execution" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

data "aws_iam_policy_document" "execution" {
  statement {
    sid       = "ReadSecrets"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [var.shared_secret_arn, var.api_secret_arn, var.db_secret_arn]
  }
  statement {
    sid       = "DecryptSecrets"
    actions   = ["kms:Decrypt"]
    resources = [var.kms_key_arn]
    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["secretsmanager.${data.aws_region.current.region}.amazonaws.com"]
    }
  }
}

resource "aws_iam_role_policy" "execution" {
  name   = "secrets"
  role   = aws_iam_role.execution.id
  policy = data.aws_iam_policy_document.execution.json
}

# Task role: exactly what the API code does at runtime.
resource "aws_iam_role" "task" {
  name               = "${var.name_prefix}-api-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

data "aws_iam_policy_document" "task" {
  statement {
    sid     = "Uploads"
    actions = ["s3:PutObject", "s3:GetObject", "s3:DeleteObject"]
    # PutObject is exercised by browsers via presigned POSTs this role signs.
    resources = ["${var.bucket_arns["uploads"]}/uploads/*"]
  }
  statement {
    sid       = "MediaReadAndCleanup"
    actions   = ["s3:GetObject", "s3:DeleteObject"]
    resources = ["${var.bucket_arns["media"]}/media/*"]
  }
  statement {
    sid       = "Downloads"
    actions   = ["s3:GetObject", "s3:DeleteObject"]
    resources = ["${var.bucket_arns["downloads"]}/downloads/*"]
  }
  statement {
    sid       = "ListForSizingAndCleanup"
    actions   = ["s3:ListBucket"]
    resources = values(var.bucket_arns)
  }
  statement {
    # Content-key unwrap. KMS refuses any Decrypt without the videoId
    # encryption context, so this role cannot decrypt arbitrary ciphertexts.
    sid       = "UnwrapContentKeys"
    actions   = ["kms:Decrypt"]
    resources = [var.kms_key_arn]
    condition {
      test     = "Null"
      variable = "kms:EncryptionContext:videoId"
      values   = ["false"]
    }
  }
  statement {
    # The app reads the RDS-managed password itself, per new connection, so a
    # rotated password is picked up without a restart.
    sid       = "ReadDatabasePassword"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [var.db_secret_arn]
  }
  statement {
    sid       = "DecryptDatabaseSecret"
    actions   = ["kms:Decrypt"]
    resources = [var.kms_key_arn]
    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["secretsmanager.${data.aws_region.current.region}.amazonaws.com"]
    }
  }
  statement {
    sid       = "SseKmsViaS3"
    actions   = ["kms:GenerateDataKey", "kms:Decrypt"]
    resources = [var.kms_key_arn]
    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["s3.${data.aws_region.current.region}.amazonaws.com"]
    }
  }
}

resource "aws_iam_role_policy" "task" {
  name   = "runtime"
  role   = aws_iam_role.task.id
  policy = data.aws_iam_policy_document.task.json
}

# ─── ECS ─────────────────────────────────────────────────────────────────────

resource "aws_cloudwatch_log_group" "api" {
  name              = "/evs/${var.name_prefix}/api"
  retention_in_days = var.log_retention_days
  kms_key_id        = null
}

resource "aws_ecs_cluster" "this" {
  name = var.name_prefix
  setting {
    name  = "containerInsights"
    value = "enhanced"
  }
}

resource "aws_ecs_task_definition" "api" {
  family                   = "${var.name_prefix}-api"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.cpu
  memory                   = var.memory
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "ARM64"
  }

  volume {
    name = "tmp"
  }

  container_definitions = jsonencode([{
    name                   = "api"
    image                  = local.image
    essential              = true
    readonlyRootFilesystem = true
    command                = ["node", "dist/index.js"]
    portMappings           = [{ containerPort = local.port, protocol = "tcp" }]
    environment            = [for k, v in local.environment : { name = k, value = v }]
    secrets                = local.secrets
    linuxParameters        = { initProcessEnabled = true }
    # Root filesystem is read-only; Node only needs a writable /tmp.
    mountPoints = [{ sourceVolume = "tmp", containerPath = "/tmp", readOnly = false }]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.api.name
        awslogs-region        = data.aws_region.current.region
        awslogs-stream-prefix = "api"
      }
    }
  }])
}

# One-off migration task: `aws ecs run-task --task-definition <prefix>-migrate ...`
# (see docs/guides/deploy-aws.md). Same network and secrets.
resource "aws_ecs_task_definition" "migrate" {
  family                   = "${var.name_prefix}-migrate"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 256
  memory                   = 512
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "ARM64"
  }

  volume {
    name = "tmp"
  }

  container_definitions = jsonencode([{
    name      = "migrate"
    image     = local.tools_image
    essential = true
    command   = ["pnpm", "db:migrate"]
    # Read-only root like the API task. pnpm and tsx only need a writable home
    # and cache, both pointed at the /tmp volume (verified with --read-only).
    readonlyRootFilesystem = true
    mountPoints            = [{ sourceVolume = "tmp", containerPath = "/tmp", readOnly = false }]
    environment            = [for k, v in merge(local.environment, { HOME = "/tmp", XDG_CACHE_HOME = "/tmp" }) : { name = k, value = v }]
    secrets                = local.secrets
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.api.name
        awslogs-region        = data.aws_region.current.region
        awslogs-stream-prefix = "migrate"
      }
    }
  }])
}

resource "aws_ecs_service" "api" {
  name                              = "api"
  cluster                           = aws_ecs_cluster.this.id
  task_definition                   = aws_ecs_task_definition.api.arn
  desired_count                     = var.desired_count
  launch_type                       = "FARGATE"
  platform_version                  = "LATEST"
  health_check_grace_period_seconds = 30
  enable_execute_command            = false
  propagate_tags                    = "SERVICE"

  network_configuration {
    subnets          = var.private_subnet_ids
    security_groups  = [aws_security_group.task.id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.api.arn
    container_name   = "api"
    container_port   = local.port
  }

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  lifecycle {
    ignore_changes = [desired_count]
  }

  depends_on = [aws_lb_listener.https]
}

resource "aws_appautoscaling_target" "api" {
  service_namespace  = "ecs"
  resource_id        = "service/${aws_ecs_cluster.this.name}/${aws_ecs_service.api.name}"
  scalable_dimension = "ecs:service:DesiredCount"
  min_capacity       = var.min_count
  max_capacity       = var.max_count
}

resource "aws_appautoscaling_policy" "cpu" {
  name               = "${var.name_prefix}-api-cpu"
  service_namespace  = aws_appautoscaling_target.api.service_namespace
  resource_id        = aws_appautoscaling_target.api.resource_id
  scalable_dimension = aws_appautoscaling_target.api.scalable_dimension
  policy_type        = "TargetTrackingScaling"
  target_tracking_scaling_policy_configuration {
    target_value       = 60
    scale_in_cooldown  = 120
    scale_out_cooldown = 60
    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageCPUUtilization"
    }
  }
}
