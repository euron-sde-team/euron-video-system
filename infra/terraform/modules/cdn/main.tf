# Own policies instead of the AWS-managed ones: explicit, reviewable, and
# portable to emulators that do not ship the managed set.
#
# Query strings are NOT part of the cache key: CloudFront validates the
# signature (Policy/Signature/Key-Pair-Id) at the edge, then serves one cached
# copy of each immutable segment to every authorized viewer.
resource "aws_cloudfront_cache_policy" "media" {
  name        = "${var.name_prefix}-media"
  comment     = "Immutable media: long TTL, no query/cookie/header in the key"
  min_ttl     = 0
  default_ttl = 86400
  max_ttl     = 31536000

  parameters_in_cache_key_and_forwarded_to_origin {
    enable_accept_encoding_gzip   = true
    enable_accept_encoding_brotli = true
    cookies_config {
      cookie_behavior = "none"
    }
    headers_config {
      header_behavior = "none"
    }
    query_strings_config {
      query_string_behavior = "none"
    }
  }
}

resource "aws_cloudfront_origin_request_policy" "media" {
  name    = "${var.name_prefix}-media"
  comment = "Forward CORS request headers to S3"
  cookies_config {
    cookie_behavior = "none"
  }
  headers_config {
    header_behavior = "whitelist"
    headers {
      items = ["Origin", "Access-Control-Request-Method", "Access-Control-Request-Headers"]
    }
  }
  query_strings_config {
    query_string_behavior = "none"
  }
}

resource "aws_cloudfront_origin_access_control" "media" {
  name                              = "${var.name_prefix}-media"
  description                       = "SigV4 access from CloudFront to the private media bucket"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

# Signed delivery: the API signs one custom policy per playlist request
# (wildcard over that video's segment path), so every segment URL carries a
# short-lived signature without one RSA operation per segment.
resource "aws_cloudfront_public_key" "signer" {
  name        = "${var.name_prefix}-signer"
  comment     = "Verifies playback policies signed by the API"
  encoded_key = var.signing_public_key_pem
}

resource "aws_cloudfront_key_group" "signer" {
  name    = "${var.name_prefix}-signers"
  items   = [aws_cloudfront_public_key.signer.id]
  comment = "Trusted signers for media delivery"
}

resource "aws_cloudfront_response_headers_policy" "media" {
  name = "${var.name_prefix}-media"

  cors_config {
    access_control_allow_credentials = false
    access_control_max_age_sec       = 3600
    origin_override                  = true
    access_control_allow_headers {
      items = ["*"]
    }
    access_control_allow_methods {
      items = ["GET", "HEAD", "OPTIONS"]
    }
    access_control_allow_origins {
      items = length(var.cors_allowed_origins) > 0 ? var.cors_allowed_origins : ["*"]
    }
  }

  security_headers_config {
    content_type_options {
      override = true
    }
    strict_transport_security {
      access_control_max_age_sec = 63072000
      include_subdomains         = true
      preload                    = true
      override                   = true
    }
  }
}

resource "aws_cloudfront_distribution" "media" {
  #checkov:skip=CKV_AWS_305:Media-only distribution; there is no index document to serve.
  #checkov:skip=CKV_AWS_374:Audience is global by default; geo restriction is a business decision.
  #checkov:skip=CKV_AWS_68:WAF is opt-in via web_acl_arn.
  #checkov:skip=CKV_AWS_86:Access logging is opt-in via logging_bucket_domain_name.
  enabled         = true
  is_ipv6_enabled = true
  comment         = "${var.name_prefix} media delivery"
  price_class     = var.price_class
  aliases         = var.aliases
  http_version    = "http2and3"
  web_acl_id      = var.web_acl_arn

  origin {
    origin_id                = "media"
    domain_name              = var.media_bucket_regional_domain_name
    origin_access_control_id = aws_cloudfront_origin_access_control.media.id
  }

  default_cache_behavior {
    target_origin_id           = "media"
    viewer_protocol_policy     = "https-only"
    allowed_methods            = ["GET", "HEAD", "OPTIONS"]
    cached_methods             = ["GET", "HEAD"]
    compress                   = true
    cache_policy_id            = aws_cloudfront_cache_policy.media.id
    origin_request_policy_id   = aws_cloudfront_origin_request_policy.media.id
    response_headers_policy_id = aws_cloudfront_response_headers_policy.media.id
    trusted_key_groups         = [aws_cloudfront_key_group.signer.id]
  }

  dynamic "logging_config" {
    for_each = var.logging_bucket_domain_name != null ? [1] : []
    content {
      bucket          = var.logging_bucket_domain_name
      include_cookies = false
      prefix          = "cloudfront/"
    }
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    cloudfront_default_certificate = var.acm_certificate_arn == null
    acm_certificate_arn            = var.acm_certificate_arn
    ssl_support_method             = var.acm_certificate_arn == null ? null : "sni-only"
    minimum_protocol_version       = var.acm_certificate_arn == null ? "TLSv1" : "TLSv1.2_2021"
  }
}
