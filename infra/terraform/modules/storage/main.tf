locals {
  buckets = {
    # Raw sources. Written by browsers via presigned POST, read once by a worker.
    uploads = { kms = true }
    # Encrypted HLS tree, posters, sprites. Segments are already AES-128
    # encrypted per video, so SSE-S3 suffices and CloudFront OAC needs no
    # KMS grant.
    media = { kms = false }
    # Processed MP4s. Unencrypted media, so SSE-KMS; served only by presigned GET.
    downloads = { kms = true }
  }
}

resource "aws_s3_bucket" "this" {
  #checkov:skip=CKV2_AWS_6:Public access block is attached per bucket via for_each below (checkov cannot follow it).
  #checkov:skip=CKV2_AWS_61:Lifecycle rules are attached per bucket via for_each below (toggle: enable_lifecycle).
  for_each      = local.buckets
  bucket        = "${var.name_prefix}-${each.key}"
  force_destroy = var.force_destroy
}

resource "aws_s3_bucket_public_access_block" "this" {
  for_each                = aws_s3_bucket.this
  bucket                  = each.value.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "this" {
  for_each = aws_s3_bucket.this
  bucket   = each.value.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "this" {
  for_each = aws_s3_bucket.this
  bucket   = each.value.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = local.buckets[each.key].kms && var.kms_key_arn != null ? "aws:kms" : "AES256"
      kms_master_key_id = local.buckets[each.key].kms && var.kms_key_arn != null ? var.kms_key_arn : null
    }
    bucket_key_enabled = local.buckets[each.key].kms && var.kms_key_arn != null
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "this" {
  for_each = var.enable_lifecycle ? aws_s3_bucket.this : {}
  bucket   = each.value.id

  rule {
    id     = "abort-incomplete-multipart"
    status = "Enabled"
    filter {}
    abort_incomplete_multipart_upload {
      days_after_initiation = 1
    }
  }

  dynamic "rule" {
    for_each = each.key == "uploads" ? [1] : []
    content {
      id     = "expire-sources"
      status = "Enabled"
      filter {}
      expiration {
        days = var.upload_expiration_days
      }
    }
  }
}

resource "aws_s3_bucket_cors_configuration" "uploads" {
  count  = length(var.cors_allowed_origins) > 0 ? 1 : 0
  bucket = aws_s3_bucket.this["uploads"].id
  cors_rule {
    allowed_methods = ["POST"]
    allowed_origins = var.cors_allowed_origins
    allowed_headers = ["*"]
    expose_headers  = ["ETag"]
    max_age_seconds = 3600
  }
}

resource "aws_s3_bucket_cors_configuration" "media" {
  count  = length(var.cors_allowed_origins) > 0 ? 1 : 0
  bucket = aws_s3_bucket.this["media"].id
  cors_rule {
    allowed_methods = ["GET", "HEAD"]
    allowed_origins = var.cors_allowed_origins
    allowed_headers = ["*"]
    max_age_seconds = 3600
  }
}

data "aws_iam_policy_document" "bucket" {
  for_each = aws_s3_bucket.this

  dynamic "statement" {
    for_each = var.enforce_tls ? [1] : []
    content {
      sid       = "DenyInsecureTransport"
      effect    = "Deny"
      actions   = ["s3:*"]
      resources = [each.value.arn, "${each.value.arn}/*"]
      principals {
        type        = "*"
        identifiers = ["*"]
      }
      condition {
        test     = "Bool"
        variable = "aws:SecureTransport"
        values   = ["false"]
      }
    }
  }

  dynamic "statement" {
    for_each = each.key == "media" && var.grant_cloudfront_access ? [1] : []
    content {
      sid       = "AllowCloudFrontOAC"
      actions   = ["s3:GetObject"]
      resources = ["${each.value.arn}/*"]
      principals {
        type        = "Service"
        identifiers = ["cloudfront.amazonaws.com"]
      }
      condition {
        test     = "StringEquals"
        variable = "AWS:SourceArn"
        values   = [var.cloudfront_distribution_arn]
      }
    }
  }
}

resource "aws_s3_bucket_policy" "this" {
  for_each = {
    for k, v in aws_s3_bucket.this : k => v
    if var.enforce_tls || (k == "media" && var.grant_cloudfront_access)
  }
  bucket     = each.value.id
  policy     = data.aws_iam_policy_document.bucket[each.key].json
  depends_on = [aws_s3_bucket_public_access_block.this]
}
