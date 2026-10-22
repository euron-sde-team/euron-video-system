data "aws_region" "current" {}
data "aws_partition" "current" {}

locals {
  pools = merge(
    { primary = { mode = "primary", role_tag = var.role_tag } },
    var.enable_jobs_pool ? { jobs = { mode = "jobs", role_tag = var.jobs_role_tag } } : {}
  )
  # Without a jobs pool, primary workers also drain background jobs.
  single_pool_mode = var.enable_jobs_pool ? "primary" : "all"
}

resource "aws_cloudwatch_log_group" "worker" {
  name              = "/evs/${var.name_prefix}/worker"
  retention_in_days = var.log_retention_days
}

# ─── Network: egress only. No SSH, no inbound of any kind. ───────────────────

resource "aws_security_group" "worker" {
  name        = "${var.name_prefix}-worker"
  description = "Transcode workers: no ingress; egress to AWS APIs and PostgreSQL"
  vpc_id      = var.vpc_id
  tags        = { Name = "${var.name_prefix}-worker" }
}

resource "aws_vpc_security_group_egress_rule" "https" {
  security_group_id = aws_security_group.worker.id
  description       = "HTTPS to AWS APIs"
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
}

resource "aws_vpc_security_group_egress_rule" "db" {
  security_group_id            = aws_security_group.worker.id
  description                  = "To PostgreSQL"
  referenced_security_group_id = var.db_security_group_id
  ip_protocol                  = "tcp"
  from_port                    = var.db_port
  to_port                      = var.db_port
}

resource "aws_vpc_security_group_ingress_rule" "db_from_worker" {
  security_group_id            = var.db_security_group_id
  description                  = "From transcode workers"
  referenced_security_group_id = aws_security_group.worker.id
  ip_protocol                  = "tcp"
  from_port                    = var.db_port
  to_port                      = var.db_port
}

# ─── IAM: exactly what the worker does ───────────────────────────────────────

data "aws_iam_policy_document" "assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "worker" {
  name               = "${var.name_prefix}-worker"
  assume_role_policy = data.aws_iam_policy_document.assume.json
}

data "aws_iam_policy_document" "worker" {
  statement {
    sid       = "ReadSources"
    actions   = ["s3:GetObject"]
    resources = ["${var.bucket_arns["uploads"]}/uploads/*"]
  }
  statement {
    sid       = "WriteOutputs"
    actions   = ["s3:PutObject", "s3:GetObject", "s3:DeleteObject"]
    resources = ["${var.bucket_arns["media"]}/media/*", "${var.bucket_arns["downloads"]}/downloads/*"]
  }
  statement {
    sid       = "ListForSweep"
    actions   = ["s3:ListBucket"]
    resources = [var.bucket_arns["media"], var.bucket_arns["downloads"]]
  }
  statement {
    # Wrap freshly generated content keys; the videoId context is mandatory.
    sid       = "WrapContentKeys"
    actions   = ["kms:Encrypt"]
    resources = [var.kms_key_arn]
    condition {
      test     = "Null"
      variable = "kms:EncryptionContext:videoId"
      values   = ["false"]
    }
  }
  statement {
    sid       = "SseKmsViaS3AndSecrets"
    actions   = ["kms:GenerateDataKey", "kms:Decrypt"]
    resources = [var.kms_key_arn]
    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values = [
        "s3.${data.aws_region.current.region}.amazonaws.com",
        "secretsmanager.${data.aws_region.current.region}.amazonaws.com",
      ]
    }
  }
  statement {
    sid       = "ReadSecrets"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [var.shared_secret_arn, var.db_secret_arn]
  }
}

resource "aws_iam_role_policy" "worker" {
  name   = "runtime"
  role   = aws_iam_role.worker.id
  policy = data.aws_iam_policy_document.worker.json
}

resource "aws_iam_role_policy_attachment" "cloudwatch" {
  role       = aws_iam_role.worker.name
  policy_arn = "arn:${data.aws_partition.current.partition}:iam::aws:policy/CloudWatchAgentServerPolicy"
}

# Shell access goes through SSM Session Manager (audited), never SSH.
resource "aws_iam_role_policy_attachment" "ssm" {
  role       = aws_iam_role.worker.name
  policy_arn = "arn:${data.aws_partition.current.partition}:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_instance_profile" "worker" {
  name = "${var.name_prefix}-worker"
  role = aws_iam_role.worker.name
}

# ─── Launch templates ────────────────────────────────────────────────────────

resource "aws_launch_template" "pool" {
  for_each      = local.pools
  name          = "${var.name_prefix}-worker-${each.key}"
  description   = "EVS transcode worker (${each.key} pool)"
  image_id      = var.ami_id
  instance_type = var.default_instance_type

  # The orchestrator never terminates instances; an idle worker shuts its own
  # host down, and "terminate" makes that shutdown release the instance.
  instance_initiated_shutdown_behavior = "terminate"
  update_default_version               = true
  vpc_security_group_ids               = [aws_security_group.worker.id]

  iam_instance_profile {
    arn = aws_iam_instance_profile.worker.arn
  }

  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required" # IMDSv2 only
    http_put_response_hop_limit = 1
    instance_metadata_tags      = "enabled"
  }

  block_device_mappings {
    device_name = "/dev/xvda"
    ebs {
      volume_size           = var.root_volume_gb
      volume_type           = "gp3"
      throughput            = 250
      encrypted             = true
      kms_key_id            = var.kms_key_arn
      delete_on_termination = true
    }
  }

  monitoring {
    enabled = true
  }

  tag_specifications {
    resource_type = "instance"
    tags          = { Name = "${var.name_prefix}-worker-${each.key}", role = each.value.role_tag }
  }

  tag_specifications {
    resource_type = "volume"
    tags          = { Name = "${var.name_prefix}-worker-${each.key}" }
  }

  user_data = base64encode(templatefile("${path.module}/user-data.sh.tftpl", {
    region            = data.aws_region.current.region
    worker_mode       = each.key == "jobs" ? "jobs" : local.single_pool_mode
    shared_secret_arn = var.shared_secret_arn
    db_secret_arn     = var.db_secret_arn
    db_username       = var.db_username
    db_address        = var.db_address
    db_port           = var.db_port
    db_name           = var.db_name
    uploads_bucket    = var.bucket_names["uploads"]
    media_bucket      = var.bucket_names["media"]
    downloads_bucket  = var.bucket_names["downloads"]
    kms_key_alias     = var.kms_key_alias
    log_group         = aws_cloudwatch_log_group.worker.name
    extra_environment = var.extra_environment
  }))
}
