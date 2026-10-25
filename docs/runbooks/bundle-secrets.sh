#!/usr/bin/env bash
# Populate a bundled Secrets Manager secret from the standalone set it replaces.
#
# Step 2 of the four-step migration in rova/infra/modules/stack/variables.tf
# (`secrets_bundle_name`). Reads each standalone secret and writes ONE JSON object
# keyed by the same logical names.
#
# Values are piped between AWS APIs and never printed. The only output is key names
# and lengths, so a wrong or empty value is visible without exposing material. The
# assembled JSON is passed to put-secret-value via a file descriptor, not argv, so it
# does not appear in `ps` output.
#
# Usage:  ./bundle-secrets.sh <env>            # env = develop | production
#         ./bundle-secrets.sh develop --verify # compare bundle against standalone
set -euo pipefail

ENV="${1:?usage: $0 <develop|production> [--verify]}"
MODE="${2:-write}"
REGION="${AWS_REGION:-ap-southeast-1}"
PREFIX="rally/${ENV}"
BUNDLE="${PREFIX}/app"

# The key set is read from the BUNDLE'S OWN DESCRIPTION, which Terraform generates from
# `secret_names` ("Expected keys: a, b, c."). That makes this script follow the module
# rather than carry a second, drifting copy of the list.
DESC=$(aws secretsmanager describe-secret --secret-id "$BUNDLE" --region "$REGION" \
         --query 'Description' --output text)
KEYS=$(printf '%s' "$DESC" | sed -n 's/.*Expected keys: \([^.]*\)\..*/\1/p' | tr -d ' ' | tr ',' '\n')

if [ -z "$KEYS" ]; then
  echo "Could not parse expected keys from the bundle description. Got: $DESC" >&2
  exit 1
fi

echo "Bundle : $BUNDLE"
echo "Keys   : $(printf '%s' "$KEYS" | tr '\n' ' ')"
echo

if [ "$MODE" = "--verify" ]; then
  # Compare every key in the bundle against its standalone counterpart WITHOUT
  # printing either. Equality is checked via sha256 of each value.
  MISMATCH=0
  BUNDLE_JSON=$(aws secretsmanager get-secret-value --secret-id "$BUNDLE" \
                  --region "$REGION" --query 'SecretString' --output text)
  while IFS= read -r k; do
    [ -n "$k" ] || continue
    a=$(printf '%s' "$BUNDLE_JSON" | KEY="$k" python3 -c '
import json,os,sys,hashlib
v=json.load(sys.stdin).get(os.environ["KEY"])
print("MISSING" if v is None else hashlib.sha256(v.encode()).hexdigest()[:16])')
    # rstrip the SAME way the write path does: `aws --output text` appends a newline
    # that is not part of the secret, so hashing raw stdin compares 65 bytes against
    # the 64 that were bundled and reports a mismatch for every single key.
    b=$(aws secretsmanager get-secret-value --secret-id "${PREFIX}/${k}" \
          --region "$REGION" --query 'SecretString' --output text 2>/dev/null \
        | python3 -c 'import sys,hashlib; print(hashlib.sha256(sys.stdin.read().rstrip("\n").encode()).hexdigest()[:16])')
    if [ "$a" = "$b" ]; then
      printf '  %-32s OK\n' "$k"
    else
      printf '  %-32s MISMATCH (bundle=%s standalone=%s)\n' "$k" "$a" "$b"
      MISMATCH=1
    fi
  done <<<"$KEYS"
  [ "$MISMATCH" -eq 0 ] && echo && echo "All keys match." || { echo; echo "Mismatches found."; exit 1; }
  exit 0
fi

# ── Assemble ────────────────────────────────────────────────────────────────────
# Built in python from a key list on stdin; each value is fetched inside the process
# so it never becomes a shell variable or a command argument.
JSON=$(KEYS="$KEYS" PREFIX="$PREFIX" REGION="$REGION" python3 - <<'PY'
import json, os, subprocess, sys

keys   = [k for k in os.environ["KEYS"].split("\n") if k]
prefix = os.environ["PREFIX"]
region = os.environ["REGION"]

out, report = {}, []
for k in keys:
    r = subprocess.run(
        ["aws", "secretsmanager", "get-secret-value",
         "--secret-id", f"{prefix}/{k}", "--region", region,
         "--query", "SecretString", "--output", "text"],
        capture_output=True, text=True)
    if r.returncode != 0:
        report.append(f"  {k:32} FAILED to read — {r.stderr.strip().splitlines()[-1]}")
        continue
    v = r.stdout.rstrip("\n")
    if v in ("", "None"):
        report.append(f"  {k:32} EMPTY — refusing to bundle an unpopulated secret")
        continue
    out[k] = v
    report.append(f"  {k:32} {len(v):6} chars")

print("\n".join(report), file=sys.stderr)
if len(out) != len(keys):
    print(f"\nOnly {len(out)}/{len(keys)} keys resolved — not writing.", file=sys.stderr)
    sys.exit(1)
print(json.dumps(out))
PY
)

echo
echo "Writing $(printf '%s' "$JSON" | python3 -c 'import json,sys; print(len(json.load(sys.stdin)))') keys to $BUNDLE"

# --secret-string file:///dev/stdin keeps the material off the argument list.
printf '%s' "$JSON" | aws secretsmanager put-secret-value \
  --secret-id "$BUNDLE" --region "$REGION" \
  --secret-string file:///dev/stdin \
  --query '[Name,VersionId]' --output text

echo
echo "Done. Verify with: $0 $ENV --verify"
