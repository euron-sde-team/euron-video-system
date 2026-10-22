# ─────────────────────────────────────────────────────────────────────────────
# Local environment on the Floci AWS emulator.
#
# The same modules that build production run here unchanged; only the provider
# endpoints differ. `make up` applies this automatically (compose `terraform`
# one-shot). To run it by hand against a running emulator:
#
#   terraform -chdir=infra/terraform/envs/local-floci init
#   terraform -chdir=infra/terraform/envs/local-floci apply
# ─────────────────────────────────────────────────────────────────────────────

module "kms" {
  source                  = "../../modules/kms"
  name_prefix             = var.name_prefix
  deletion_window_in_days = 7
}

module "storage" {
  source               = "../../modules/storage"
  name_prefix          = var.name_prefix
  kms_key_arn          = null # SSE-S3 locally; content keys still use KMS
  cors_allowed_origins = var.cors_origins
  enforce_tls          = false # the emulator speaks plain HTTP
  enable_lifecycle     = false # source expiry is irrelevant locally; keeps `make up` fast
  force_destroy        = true
}

# Generated secrets are an AWS-deployment concern; locally compose reads
# deploy/compose/.env. Created here anyway so the module is exercised.
module "secrets" {
  source                  = "../../modules/secrets"
  name_prefix             = var.name_prefix
  recovery_window_in_days = 0
}

module "cdn" {
  count                             = var.enable_cdn ? 1 : 0
  source                            = "../../modules/cdn"
  name_prefix                       = var.name_prefix
  media_bucket_regional_domain_name = module.storage.media_bucket_regional_domain_name
  signing_public_key_pem            = module.secrets.cloudfront_public_key_pem
  cors_allowed_origins              = var.cors_origins
}
