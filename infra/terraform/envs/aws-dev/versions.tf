terraform {
  required_version = ">= 1.10.0"
  required_providers {
    aws     = { source = "hashicorp/aws", version = "~> 6.70" }
    random  = { source = "hashicorp/random", version = "~> 3.9" }
    tls     = { source = "hashicorp/tls", version = "~> 4.4" }
    archive = { source = "hashicorp/archive", version = "~> 2.8" }
  }
}

provider "aws" {
  region = var.region
  default_tags {
    tags = merge({
      Project     = "euron-video-system"
      Environment = var.environment
      ManagedBy   = "terraform"
    }, var.extra_tags)
  }
}
