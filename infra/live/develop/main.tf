// rova · develop
//
// This file is deliberately thin. The entire stack lives in ../../modules/stack, so
// develop and production cannot drift structurally — only the values below differ.
// Develop leans on SHARED, cheap infrastructure (Fargate Spot, small RDS, short
// retention); production takes the dedicated, durable settings. Adding a resource
// means editing the module once, not both environments.
terraform {
  required_version = ">= 1.9"
  required_providers {
    aws        = { source = "hashicorp/aws", version = "~> 5.0" }
    cloudflare = { source = "cloudflare/cloudflare", version = "~> 4.0" }
    grafana    = { source = "grafana/grafana", version = "~> 3.0" }
  }

  backend "s3" {
    bucket         = "qnsc-tofu-state"
    key            = "rova/develop/terraform.tfstate"
    region         = "ap-southeast-1"
    encrypt        = true
    dynamodb_table = "qnsc-tofu-locks"
  }
}

provider "aws" {
  region = "ap-southeast-1"
  default_tags {
    tags = {
      Project     = "rova"
      Environment = "develop"
      ManagedBy   = "opentofu"
    }
  }
}

// Reads CLOUDFLARE_API_TOKEN (or TF_VAR_cloudflare_api_token). DNS/Pages resources exist when
// `dns_enabled` is true; the zone id comes from the _shared stack and must be valid or the plan fails.
provider "cloudflare" {
  api_token = var.cloudflare_api_token != "" ? var.cloudflare_api_token : null
}

// Configured UNCONDITIONALLY, like the cloudflare provider above — providers
// can't be conditional — but touches nothing at all while
// grafana_alerting_auth is empty: module.alerts (inside module.stack) is
// count-gated to zero in that state, so this config is simply never used
// for an actual API call. See modules/stack/variables.tf's
// grafana_alerting_auth for the full reasoning.
provider "grafana" {
  url  = var.grafana_alerting_url
  auth = var.grafana_alerting_auth
}

// Route 53 publishes health-check metrics ONLY to us-east-1, so the ingress alarm in
// module.stack has to be created there. Everything else stays in ap-southeast-1.
provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"
  default_tags {
    tags = {
      Project     = "rova"
      Environment = "develop"
      ManagedBy   = "opentofu"
    }
  }
}

// ============================================================================
// AWS EXIT (E1, 2026-10-31): this develop stack is being destroyed.
//
// Everything below the provider blocks was removed so that `tofu plan` shows
// exactly the destroy set for the whole state — nothing is hidden behind a
// directory deletion (a deleted directory plans nothing and proves nothing).
//
// Order of operations, all in product-docs/platform/runbooks/aws-exit-teardown.md:
//   1. copy-out checklist done (secrets → kv-qnsc-dev, files, DNS export)
//   2. final manual RDS snapshot taken and verified `available`
//   3. merge with the `allow-dns-destroy` label (this stack owns rova dev
//      Cloudflare records + the rova-develop tunnel)
//   4. apply runs on the merge; this branch is a DRAFT until the owner's "go"
//
// rova prod and infra/live/_shared (deploy roles, SES, ECR) are NOT touched:
// prod lives until its own cutover (E2, ≈ 2026-11-17).
// ============================================================================
