# ─────────────────────────────────────────────────────────────────────────────
# Euron Video System: prod environment on AWS.
#
#   cp terraform.tfvars.example terraform.tfvars    # fill in placeholders
#   pnpm --filter @evs/orchestrator build           # produces the Lambda bundle
#   terraform init && terraform plan
#
# See docs/guides/deploy-aws-terraform.md for the full runbook.
# ─────────────────────────────────────────────────────────────────────────────

module "network" {
  source             = "../../modules/network"
  name_prefix        = var.name_prefix
  single_nat_gateway = false
}

module "kms" {
  source      = "../../modules/kms"
  name_prefix = var.name_prefix
}

module "secrets" {
  source                  = "../../modules/secrets"
  name_prefix             = var.name_prefix
  kms_key_arn             = module.kms.key_arn
  recovery_window_in_days = 30
}

module "storage" {
  source                      = "../../modules/storage"
  name_prefix                 = var.name_prefix
  kms_key_arn                 = module.kms.key_arn
  cors_allowed_origins        = var.console_origins
  grant_cloudfront_access     = true
  cloudfront_distribution_arn = module.cdn.distribution_arn
  force_destroy               = false
}

module "cdn" {
  source                            = "../../modules/cdn"
  name_prefix                       = var.name_prefix
  media_bucket_regional_domain_name = module.storage.media_bucket_regional_domain_name
  signing_public_key_pem            = module.secrets.cloudfront_public_key_pem
  cors_allowed_origins              = var.console_origins
  aliases                           = var.media_aliases
  acm_certificate_arn               = var.media_certificate_arn
}

module "database" {
  source              = "../../modules/database"
  name_prefix         = var.name_prefix
  vpc_id              = module.network.vpc_id
  subnet_ids          = module.network.private_subnet_ids
  kms_key_arn         = module.kms.key_arn
  instance_class      = "db.m7g.large"
  multi_az            = true
  deletion_protection = true
  skip_final_snapshot = false
}

module "api" {
  source                 = "../../modules/api-service"
  name_prefix            = var.name_prefix
  vpc_id                 = module.network.vpc_id
  public_subnet_ids      = module.network.public_subnet_ids
  private_subnet_ids     = module.network.private_subnet_ids
  certificate_arn        = var.api_certificate_arn
  image_tag              = var.api_image_tag
  desired_count          = 2
  min_count              = 2
  public_api_base        = "https://${var.api_domain}"
  cors_allowed_origins   = var.console_origins
  bucket_names           = module.storage.bucket_names
  bucket_arns            = module.storage.bucket_arns
  kms_key_arn            = module.kms.key_arn
  kms_key_alias          = module.kms.alias_name
  shared_secret_arn      = module.secrets.shared_secret_arn
  api_secret_arn         = module.secrets.api_secret_arn
  db_address             = module.database.address
  db_port                = module.database.port
  db_name                = module.database.database_name
  db_secret_arn          = module.database.master_user_secret_arn
  db_username            = module.database.master_username
  db_security_group_id   = module.database.security_group_id
  delivery_driver        = "cloudfront-signed"
  deletion_protection    = true
  media_public_base      = module.cdn.media_public_base
  cloudfront_key_pair_id = module.cdn.key_pair_id
}

module "workers" {
  source               = "../../modules/worker-fleet"
  name_prefix          = var.name_prefix
  vpc_id               = module.network.vpc_id
  ami_id               = var.worker_ami_id
  enable_jobs_pool     = var.enable_jobs_pool
  bucket_names         = module.storage.bucket_names
  bucket_arns          = module.storage.bucket_arns
  kms_key_arn          = module.kms.key_arn
  kms_key_alias        = module.kms.alias_name
  shared_secret_arn    = module.secrets.shared_secret_arn
  db_address           = module.database.address
  db_port              = module.database.port
  db_name              = module.database.database_name
  db_secret_arn        = module.database.master_user_secret_arn
  db_username          = module.database.master_username
  db_security_group_id = module.database.security_group_id
}

module "orchestrator" {
  source                    = "../../modules/orchestrator"
  name_prefix               = var.name_prefix
  vpc_id                    = module.network.vpc_id
  private_subnet_ids        = module.network.private_subnet_ids
  lambda_source_dir         = "${path.root}/../../../../apps/orchestrator/dist/lambda"
  db_address                = module.database.address
  db_port                   = module.database.port
  db_name                   = module.database.database_name
  db_secret_arn             = module.database.master_user_secret_arn
  db_username               = module.database.master_username
  db_security_group_id      = module.database.security_group_id
  kms_key_arn               = module.kms.key_arn
  worker_subnet_ids         = module.network.private_subnet_ids
  worker_role_arn           = module.workers.role_arn
  launch_template_name      = module.workers.launch_template_name
  jobs_launch_template_name = module.workers.jobs_launch_template_name
  role_tag                  = module.workers.role_tag
  jobs_role_tag             = module.workers.jobs_role_tag
  max_workers               = var.max_workers
}

module "observability" {
  source                     = "../../modules/observability"
  name_prefix                = var.name_prefix
  alarm_email                = var.alarm_email
  alb_arn_suffix             = module.api.alb_arn_suffix
  target_group_arn_suffix    = module.api.target_group_arn_suffix
  ecs_cluster_name           = module.api.cluster_name
  ecs_service_name           = module.api.service_name
  db_instance_identifier     = module.database.instance_identifier
  orchestrator_function_name = module.orchestrator.function_name
  orchestrator_dlq_name      = module.orchestrator.dlq_name
}
