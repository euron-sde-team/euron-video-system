# `cdn` module

CloudFront distribution in front of the private media bucket via Origin Access Control. Delivery is signed: a public key + key group are trusted on the default behavior, the API signs one wildcard custom policy per playlist. Own cache / origin-request / response-headers (CORS, HSTS) policies; optional custom domain, WAF and logging.

## Inputs

| Name | Description | Type | Default |
|---|---|---|---|
| `name_prefix` | Prefix for every resource name. | `string` | required |
| `media_bucket_regional_domain_name` | Origin: the media bucket's regional domain name. | `string` | required |
| `signing_public_key_pem` | RSA public key (PEM) whose private half the API uses to sign CloudFront policies. | `string` | required |
| `cors_allowed_origins` | Player origins allowed to fetch segments cross-origin. Empty = any origin (segments are signed regardless). | `list(string)` | `[]` |
| `aliases` | Custom domain names, e.g. ["media.example.com"]. Requires acm_certificate_arn. | `list(string)` | `[]` |
| `acm_certificate_arn` | ACM certificate in us-east-1 covering every alias. | `string` | `null` |
| `price_class` | PriceClass_All \| PriceClass_200 \| PriceClass_100. | `string` | `"PriceClass_100"` |
| `logging_bucket_domain_name` | Optional <bucket>.s3.amazonaws.com for standard access logs. | `string` | `null` |
| `web_acl_arn` | Optional WAFv2 web ACL (scope CLOUDFRONT) to attach. | `string` | `null` |

## Outputs

| Name | Description |
|---|---|
| `distribution_id` | CloudFront distribution id (for invalidations). |
| `distribution_arn` | Distribution ARN, granted read on the media bucket via OAC. |
| `domain_name` | Distribution domain, e.g. dxxxx.cloudfront.net. |
| `media_public_base` | MEDIA_PUBLIC_BASE for the API. |
| `key_pair_id` | CLOUDFRONT_KEY_PAIR_ID for the API (the public key id). |
