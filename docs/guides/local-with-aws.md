# Local containers against real AWS

Run the same local containers, but point them at real S3, KMS and CloudFront instead of
the emulator. Use this to exercise IAM, KMS encryption context and CloudFront signed
delivery before deploying the full stack, or to develop against production-shaped
infrastructure.

- [What changes compared to the emulator](#what-changes-compared-to-the-emulator)
- [1. Provision the AWS resources](#1-provision-the-aws-resources)
- [2. Fill in `.env.aws`](#2-fill-in-envaws)
- [3. Start the stack](#3-start-the-stack)
- [4. Verify](#4-verify)
- [Costs and cleanup](#costs-and-cleanup)

## What changes compared to the emulator

[`deploy/compose/compose.aws.yaml`](../../deploy/compose/compose.aws.yaml) replaces the
emulator overlay. The application code is identical; only configuration differs.

| | `make up` (emulator) | `make up-aws` (real AWS) |
| --- | --- | --- |
| Object storage | Floci S3, `evs-local-*` buckets | Your S3 buckets from Terraform |
| KMS | Floci KMS, `alias/evs-local` | Your customer managed key |
| Credentials | `test` / `test` | Your AWS CLI profile, mounted read-only from `~/.aws` |
| Endpoint override | `AWS_ENDPOINT_URL=http://floci:4566` | none: the SDK talks to AWS |
| Segment delivery | `proxy` (or `presigned`) | `cloudfront-signed` |
| IAM enforcement | none (emulators do not enforce policies) | real |
| Database | local Postgres container | local Postgres container (unchanged) |
| `EVS_CLOUD` | `floci` | `aws` (demo-only flags such as `WEBHOOK_ALLOW_PRIVATE_TARGETS` are refused) |

> [!NOTE]
> Postgres stays local in this mode, so your data stays on your machine. Only object
> storage, keys and delivery move to AWS. To run the whole platform in AWS, follow
> [deploy-aws.md](deploy-aws.md).

## 1. Provision the AWS resources

The `aws-dev` environment creates everything, including the network, database and fleet.
For this mode you only need its buckets, KMS key, secrets and CloudFront distribution, but
applying the full environment is the supported path:

```bash
cd infra/terraform/envs/aws-dev
cp terraform.tfvars.example terraform.tfvars        # set name_prefix, api_domain, certificate, AMI, image tag
pnpm --filter @evs/orchestrator build               # the orchestrator Lambda bundle Terraform zips
terraform init
terraform apply
terraform output
```

See [deploy-aws.md § variables](deploy-aws.md#3-configure-the-environment) for every input.

## 2. Fill in `.env.aws`

```bash
cp deploy/compose/.env.aws.example deploy/compose/.env.aws   # git-ignored
```

| Variable | Where it comes from |
| --- | --- |
| `UPLOADS_BUCKET`, `MEDIA_BUCKET`, `DOWNLOADS_BUCKET` | `terraform output bucket_names` |
| `KMS_KEY_ID` | `terraform output kms_key_alias` (for example `alias/evs-dev`) |
| `MEDIA_PUBLIC_BASE` | `terraform output media_public_base` (the CloudFront domain) |
| `CLOUDFRONT_KEY_PAIR_ID` | `terraform output cloudfront_key_pair_id` |
| `CLOUDFRONT_PRIVATE_KEY` | The `CLOUDFRONT_PRIVATE_KEY` field of the API secret (`terraform output api_secret_arn`), with newlines written as literal `\n` |

Fetch the private key without printing it to your terminal history:

```bash
SECRET_ARN=$(terraform -chdir=infra/terraform/envs/aws-dev output -raw api_secret_arn)
aws secretsmanager get-secret-value --secret-id "$SECRET_ARN" --query SecretString --output text \
  | jq -r '.CLOUDFRONT_PRIVATE_KEY' | awk '{printf "%s\\n", $0}' \
  | sed 's/^/CLOUDFRONT_PRIVATE_KEY=/' >> deploy/compose/.env.aws
```

> [!WARNING]
> `.env.aws` holds a signing private key. Keep it git-ignored (it is by default), readable
> only by you (`chmod 600`), and delete it when you are done.

## 3. Start the stack

```bash
AWS_PROFILE=your-profile AWS_REGION=us-east-1 make up-aws
```

The profile needs permission to use the buckets and the KMS key. In AWS the API and
workers run with tightly scoped IAM roles. Locally they run as *you*, so an administrator
profile will hide least-privilege mistakes. Prefer a profile that mirrors the API task role.

## 4. Verify

`make key` targets the emulator stack, so create the key through the AWS overlay instead:

```bash
AWS=(docker compose -f deploy/compose/compose.yaml -f deploy/compose/compose.aws.yaml)
EVS_API_KEY=$("${AWS[@]}" run --rm -T migrate pnpm --silent evs keys:create --name aws-smoke --scopes '*' \
  | grep -oE 'evs_[A-Za-z0-9_-]+' | head -1)
scripts/demo/fetch-sample.sh >/dev/null
EVS_API_KEY=$EVS_API_KEY scripts/demo/upload.sh samples/big-buck-bunny-1080p.mp4 "AWS smoke test"
```

Open the console at `http://localhost:3000` and play the video. In your browser's network
panel, segment requests should go to the CloudFront domain with `Policy`, `Signature`,
`Key-Pair-Id` and `Hash-Algorithm` query parameters, and the key request should go to
`localhost:8080/v1/play/…/key`.

> [!TIP]
> Postgres is local in this mode, so keys you create here are not valid against a deployed
> stack, and the reverse is also true.

## Costs and cleanup

This mode is billed for S3 storage and requests, KMS requests, CloudFront transfer, and
whatever else `aws-dev` provisioned (NAT, RDS, ALB). Stop the local containers with
`make down`. Remove the AWS resources with `terraform destroy` in `envs/aws-dev`, where
`force_destroy` is enabled on the dev buckets.
