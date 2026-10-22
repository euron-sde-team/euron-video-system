# ─────────────────────────────────────────────────────────────────────────────
# Transcode worker AMI: Amazon Linux 2023, arm64 (Graviton).
#
#   pnpm --filter @evs/worker build            # produces apps/worker/dist/index.js
#   packer init infra/packer
#   packer build -var region=us-east-1 infra/packer/worker.pkr.hcl
#
# The image holds code and tools only. No secrets, no environment: the
# instance reads both from Secrets Manager at boot (worker-fleet user data).
# ─────────────────────────────────────────────────────────────────────────────
packer {
  required_plugins {
    amazon = {
      source  = "github.com/hashicorp/amazon"
      version = "~> 1.3"
    }
  }
}

variable "region" {
  type    = string
  default = "us-east-1"
}

variable "name_prefix" {
  type    = string
  default = "evs"
}

variable "instance_type" {
  type    = string
  default = "c7g.2xlarge" # whisper.cpp compiles in ~2 min here
}

variable "subnet_id" {
  type        = string
  default     = null
  description = "Build in a specific subnet (needs outbound internet). Null = default VPC."
}

variable "node_major" {
  type    = string
  default = "22"
}

variable "whisper_version" {
  type    = string
  default = "v1.9.5"
}

variable "whisper_model" {
  type        = string
  default     = "small"
  description = "tiny | base | small | medium. Larger = more accurate, slower."
}

variable "ffmpeg_version" {
  type        = string
  default     = "7.1"
  description = "Static FFmpeg build (AL2023 does not package ffmpeg)."
}

locals {
  timestamp = formatdate("YYYYMMDDhhmmss", timestamp())
}

source "amazon-ebs" "worker" {
  region        = var.region
  instance_type = var.instance_type
  subnet_id     = var.subnet_id
  ssh_username  = "ec2-user"
  ami_name      = "${var.name_prefix}-worker-${local.timestamp}"

  source_ami_filter {
    owners      = ["amazon"]
    most_recent = true
    filters = {
      name                = "al2023-ami-2023.*-kernel-*-arm64"
      architecture        = "arm64"
      root-device-type    = "ebs"
      virtualization-type = "hvm"
    }
  }

  # IMDSv2 for the build instance and as the AMI default.
  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
  }
  imds_support = "v2.0"

  launch_block_device_mappings {
    device_name           = "/dev/xvda"
    volume_size           = 30
    volume_type           = "gp3"
    encrypted             = true
    delete_on_termination = true
  }

  tags = {
    Name           = "${var.name_prefix}-worker"
    Project        = "euron-video-system"
    WhisperVersion = var.whisper_version
    WhisperModel   = var.whisper_model
    BuiltAt        = local.timestamp
  }
}

build {
  sources = ["source.amazon-ebs.worker"]

  provisioner "shell" {
    inline = ["sudo install -d -o ec2-user /tmp/evs-build"]
  }

  provisioner "file" {
    source      = "${path.root}/../../apps/worker/dist/"
    destination = "/tmp/evs-build/"
  }

  provisioner "file" {
    source      = "${path.root}/files/evs-worker.service"
    destination = "/tmp/evs-build/evs-worker.service"
  }

  provisioner "shell" {
    environment_vars = [
      "NODE_MAJOR=${var.node_major}",
      "WHISPER_VERSION=${var.whisper_version}",
      "WHISPER_MODEL=${var.whisper_model}",
      "FFMPEG_VERSION=${var.ffmpeg_version}",
    ]
    execute_command = "chmod +x {{ .Path }}; sudo -E bash -euo pipefail {{ .Path }}"
    script          = "${path.root}/files/provision.sh"
  }
}
