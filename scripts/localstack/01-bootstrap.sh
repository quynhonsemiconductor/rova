#!/usr/bin/env bash
#
# LocalStack bootstrap — provisions the S3 buckets the Rally API and worker expect.
#
# Runs automatically via the /etc/localstack/init/ready.d hook every time
# LocalStack becomes ready (mounted from ./scripts/localstack in
# docker-compose.dev.yml). Mirrors how db/init/ bootstraps Postgres.
#
# Idempotent: create-bucket's BucketAlreadyOwnedByYou is swallowed explicitly, so
# re-runs are safe.
#
#   S3 buckets (mirrors the Cloudflare R2 buckets in platform/storage-*):
#     rova-attachments    — PRIVATE. Every permission-gated upload.
#     rova-public-assets  — PUBLIC. Avatars / logos only.
#
#   Without these, attachment upload could not be exercised locally at all,
#   which is how a frontend/backend contract mismatch went unnoticed.
#
# THIS SCRIPT USED TO PROVISION AN SNS TOPIC AND FOUR SQS QUEUES, and that is the
# cautionary tale worth keeping: it subscribed all four queues, unfiltered, with
# RawMessageDelivery=true, while the Terraform subscribed ONE, filtered on event
# types the code never emits, with envelope delivery. Local dev therefore worked
# perfectly and every deployed environment dropped 100% of domain events, unseen,
# for as long as the pipeline existed. The audit projection is a DB-to-DB relay now
# (apps/worker/src/audit/audit-projection.relay.ts) so there is no second topology
# to keep in agreement. If a queue is ever reintroduced, DERIVE this file from the
# Terraform or test against the deployed topology — a hand-written local
# approximation that is more permissive than production is worse than none.
#
# Names / region are kept in sync with .env (S3_ATTACHMENTS_BUCKET,
# S3_PUBLIC_ASSETS_BUCKET).
set -euo pipefail

REGION="ap-southeast-1"
PRIVATE_BUCKET="rova-attachments"
PUBLIC_BUCKET="rova-public-assets"
# Vite dev server origin — the SPA PUTs directly to the bucket from here.
WEB_ORIGIN="http://localhost:5173"

echo "[localstack-init] provisioning S3 buckets…"

for bucket in "$PRIVATE_BUCKET" "$PUBLIC_BUCKET"; do
  # create-bucket is not idempotent in the way create-queue is: it returns
  # BucketAlreadyOwnedByYou on re-run, which is harmless under `set -e` only if
  # we swallow it explicitly.
  awslocal s3api create-bucket \
    --bucket "$bucket" \
    --region "$REGION" \
    --create-bucket-configuration "LocationConstraint=$REGION" \
    >/dev/null 2>&1 || true

  # CORS must mirror the R2 rules in platform/qnsc-infra/live/storage-*.
  # x-amz-checksum-sha256 is required: the presigned PUT binds the checksum into
  # its signature, so the browser must be allowed to send that header or every
  # upload fails preflight.
  awslocal s3api put-bucket-cors --bucket "$bucket" --cors-configuration "{
    \"CORSRules\": [{
      \"AllowedMethods\": [\"PUT\"],
      \"AllowedOrigins\": [\"${WEB_ORIGIN}\"],
      \"AllowedHeaders\": [\"Content-Type\", \"Content-Disposition\", \"x-amz-checksum-sha256\"],
      \"ExposeHeaders\": [\"ETag\"],
      \"MaxAgeSeconds\": 3600
    }]
  }" >/dev/null

  echo "[localstack-init]   bucket ready: $bucket"
done

# Abort incomplete multipart uploads so abandoned uploads don't accrue storage.
# Mirrors the lifecycle rule on the real R2 buckets.
awslocal s3api put-bucket-lifecycle-configuration --bucket "$PRIVATE_BUCKET" \
  --lifecycle-configuration '{
    "Rules": [{
      "ID": "abort-incomplete-multipart",
      "Status": "Enabled",
      "Filter": {"Prefix": ""},
      "AbortIncompleteMultipartUpload": {"DaysAfterInitiation": 7}
    }]
  }' >/dev/null

echo "[localstack-init] done."
