data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}

locals {
  account_root = "arn:${data.aws_partition.current.partition}:iam::${data.aws_caller_identity.current.account_id}:root"
}

data "aws_iam_policy_document" "key" {
  #checkov:skip=CKV_AWS_109:Key policies always use Resource "*" (the key itself); root access delegates to IAM.
  #checkov:skip=CKV_AWS_111:As above; usage is constrained by per-role IAM policies with encryption-context conditions.
  #checkov:skip=CKV_AWS_356:As above.
  # The account root keeps control so the key can never become unmanageable.
  # Usage is then granted per role by IAM policies (api, worker), each scoped
  # to the operations and encryption context that role needs.
  statement {
    sid       = "AccountRoot"
    actions   = ["kms:*"]
    resources = ["*"]
    principals {
      type        = "AWS"
      identifiers = [local.account_root]
    }
  }

  dynamic "statement" {
    for_each = length(var.admin_principal_arns) > 0 ? [1] : []
    content {
      sid = "KeyAdministrators"
      actions = [
        "kms:Create*", "kms:Describe*", "kms:Enable*", "kms:List*", "kms:Put*", "kms:Update*",
        "kms:Revoke*", "kms:Disable*", "kms:Get*", "kms:Delete*", "kms:TagResource",
        "kms:UntagResource", "kms:ScheduleKeyDeletion", "kms:CancelKeyDeletion",
      ]
      resources = ["*"]
      principals {
        type        = "AWS"
        identifiers = var.admin_principal_arns
      }
    }
  }
}

# One customer-managed key wraps per-video content keys and encrypts the
# uploads/downloads buckets, RDS storage and Secrets Manager secrets.
resource "aws_kms_key" "this" {
  description             = "${var.name_prefix}: content-key wrapping and data at rest"
  enable_key_rotation     = true
  rotation_period_in_days = 365
  deletion_window_in_days = var.deletion_window_in_days
  policy                  = data.aws_iam_policy_document.key.json
}

resource "aws_kms_alias" "this" {
  name          = "alias/${var.name_prefix}"
  target_key_id = aws_kms_key.this.key_id
}
