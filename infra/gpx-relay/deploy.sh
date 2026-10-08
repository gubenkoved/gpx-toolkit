#!/usr/bin/env bash
# Interactive deployer for the Beeline full-track GPX relay (see README.md).
#
# Creates (or updates) the Lambda, sets a low reserved concurrency as the hard cost
# ceiling, exposes a public Function URL, and prints the resulting URL ready to paste
# into the app's GPX_RELAY_URL. CORS / the allowed-origin allow-list is enforced by
# the relay code itself (via the ALLOWED_ORIGINS env var), not the Function URL.
#
# Requirements: bash, zip, and the AWS CLI v2 configured with credentials
# (`aws configure`) for the account/region you want to deploy to.
#
# Safe to re-run: if the function already exists it updates the code + config
# instead of failing.

set -euo pipefail

cd "$(dirname "$0")"

FUNCTION_NAME_DEFAULT="beeline-gpx-relay"
REGION_DEFAULT="$(aws configure get region 2>/dev/null || echo "us-east-1")"
MEMORY_DEFAULT="256"
TIMEOUT_DEFAULT="15"
ARCH_DEFAULT="arm64"
DDB_TABLE_DEFAULT="beeline-gpx-relay-state"
# Set on create AND update, so re-running this moves an older function onto it.
RUNTIME="nodejs24.x"

bold() { printf '\033[1m%s\033[0m\n' "$1"; }
info() { printf '  %s\n' "$1"; }
err()  { printf '\033[31m%s\033[0m\n' "$1" >&2; }

# -- prompt helpers ----------------------------------------------------------

ask() { # ask <var> <prompt> <default>
  local __var="$1" __prompt="$2" __default="${3:-}" __reply
  if [[ -n "$__default" ]]; then
    read -r -p "$__prompt [$__default]: " __reply || true
    printf -v "$__var" '%s' "${__reply:-$__default}"
  else
    read -r -p "$__prompt: " __reply || true
    printf -v "$__var" '%s' "$__reply"
  fi
}

# -- preflight ---------------------------------------------------------------

command -v aws >/dev/null 2>&1 || { err "AWS CLI not found. Install it and run 'aws configure' first."; exit 1; }
command -v zip >/dev/null 2>&1 || { err "'zip' not found. Install it (e.g. 'brew install zip')."; exit 1; }

if ! aws sts get-caller-identity >/dev/null 2>&1; then
  err "AWS credentials are not configured or have expired. Run 'aws configure' (or set up SSO) and retry."
  exit 1
fi

ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
bold "Beeline GPX relay -- AWS deploy"
info "Account: $ACCOUNT_ID"
echo

# -- gather parameters -------------------------------------------------------

ask FUNCTION_NAME "Lambda function name" "$FUNCTION_NAME_DEFAULT"
ask REGION        "AWS region"            "$REGION_DEFAULT"
echo
info "ALLOWED_ORIGINS locks which browser origins may call the relay."
info "Comma-separated, no spaces -- e.g. https://you.github.io,http://localhost:5173"
ask ALLOWED_ORIGINS "Allowed origin(s)" ""
if [[ -z "$ALLOWED_ORIGINS" ]]; then
  err "Refusing to deploy with an empty ALLOWED_ORIGINS (that would allow any origin)."
  err "Pass at least your app's origin."
  exit 1
fi
# Normalize each entry to a bare ORIGIN (scheme://host[:port]) — that's all a
# browser ever sends in its `Origin` header. We drop spaces, then strip any path/
# query/fragment and trailing slash, because e.g. "https://site/gpx-toolkit" or
# "https://site/" would never equal the browser's "https://site" and CORS would
# silently fail (the #1 misconfiguration here — pasting the page URL, not the origin).
ALLOWED_ORIGINS="$(
  printf '%s\n' "$ALLOWED_ORIGINS" | tr ',' '\n' | while IFS= read -r o; do
    o="${o// /}"
    if [[ "$o" == *"://"* ]]; then
      proto="${o%%://*}"          # scheme
      rest="${o#*://}"            # host[:port]/path?query#frag
      rest="${rest%%/*}"          # cut at first '/'  -> host[:port][?query]
      rest="${rest%%\?*}"         # cut any leftover '?query'
      rest="${rest%%#*}"          # cut any leftover '#fragment'
      o="${proto}://${rest}"
    else
      o="${o%/}"
    fi
    [[ -n "$o" ]] && printf '%s,' "$o"
  done
)"
ALLOWED_ORIGINS="${ALLOWED_ORIGINS%,}"
echo
ask MEMORY      "Memory (MB)"                       "$MEMORY_DEFAULT"
ask TIMEOUT     "Timeout (seconds)"                 "$TIMEOUT_DEFAULT"

# Durable persistence (optional) keeps the rate-limit counters + download stats in a
# DynamoDB table so they survive cold starts AND stay exact across concurrent
# containers (which makes reserved concurrency > 1 safe). It uses the AWS always-free
# tier (provisioned 5/5). Declined -> the relay keeps best-effort in-memory counters,
# which are only exact at reserved concurrency = 1.
echo
info "Durable persistence stores rate-limit counters + stats in DynamoDB (always-free"
info "5/5) so they survive cold starts and stay exact across containers. Without it the"
info "relay uses in-memory counters (exact only at reserved concurrency = 1)."
ask PERSIST "Enable durable persistence (DynamoDB)? (Y/n)" "Y"
if [[ "$PERSIST" =~ ^[Nn]$ ]]; then
  PERSIST=0
  DDB_TABLE=""
  CONCURRENCY_DEFAULT="1"
else
  PERSIST=1
  ask DDB_TABLE "DynamoDB table name" "$DDB_TABLE_DEFAULT"
  CONCURRENCY_DEFAULT="2"
fi
echo
ask CONCURRENCY "Reserved concurrency (cost ceiling)" "$CONCURRENCY_DEFAULT"
ask ARCH        "Architecture (arm64/x86_64)"       "$ARCH_DEFAULT"

# An execution role is required to create a function. Offer to create a minimal one.
ROLE_ARN=""
ask ROLE_ARN "Execution role ARN (blank to create a minimal one)" ""

export AWS_DEFAULT_REGION="$REGION"

echo
bold "About to deploy:"
info "function        $FUNCTION_NAME"
info "region          $REGION"
info "allowed origins $ALLOWED_ORIGINS"
info "memory/timeout  ${MEMORY}MB / ${TIMEOUT}s"
info "concurrency     $CONCURRENCY"
info "architecture    $ARCH"
if [[ "$PERSIST" == "1" ]]; then
  info "persistence     DynamoDB table '$DDB_TABLE' (always-free 5/5)"
else
  info "persistence     in-memory (no DynamoDB)"
fi
echo
ask CONFIRM "Proceed? (y/N)" "N"
[[ "$CONFIRM" =~ ^[Yy]$ ]] || { info "Aborted."; exit 0; }

# -- minimal execution role (only if none supplied) --------------------------

if [[ -z "$ROLE_ARN" ]]; then
  ROLE_NAME="${FUNCTION_NAME}-role"
  if aws iam get-role --role-name "$ROLE_NAME" >/dev/null 2>&1; then
    info "Reusing existing role $ROLE_NAME"
  else
    bold "Creating execution role ${ROLE_NAME}..."
    TRUST='{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]}'
    aws iam create-role \
      --role-name "$ROLE_NAME" \
      --assume-role-policy-document "$TRUST" >/dev/null
    aws iam attach-role-policy \
      --role-name "$ROLE_NAME" \
      --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
    info "Waiting for IAM role to propagate..."
    sleep 10
  fi
  ROLE_ARN="arn:aws:iam::${ACCOUNT_ID}:role/${ROLE_NAME}"
fi

# -- durable persistence: DynamoDB table + TTL + runtime IAM (if enabled) -----
# All idempotent / safe to re-run: the table is created only if absent, TTL is enabled
# only when not already on, and the inline role policy is overwritten in place.

if [[ "$PERSIST" == "1" ]]; then
  bold "Provisioning DynamoDB table ${DDB_TABLE}..."
  if aws dynamodb describe-table --table-name "$DDB_TABLE" >/dev/null 2>&1; then
    info "Table already exists -- reusing"
  else
    # Provisioned 5/5 sits inside the account-wide always-free 25/25 pool; this
    # workload uses a tiny fraction of it, so it stays $0 with no throttle risk.
    aws dynamodb create-table \
      --table-name "$DDB_TABLE" \
      --attribute-definitions AttributeName=pk,AttributeType=S \
      --key-schema AttributeName=pk,KeyType=HASH \
      --provisioned-throughput ReadCapacityUnits=5,WriteCapacityUnits=5 >/dev/null
    info "Waiting for table to become active..."
    aws dynamodb wait table-exists --table-name "$DDB_TABLE"
  fi

  # Enable TTL on `ttl` so DynamoDB reaps expired rate-limit windows for free. Guard
  # on status: enabling when already enabled errors out.
  TTL_STATUS="$(aws dynamodb describe-time-to-live --table-name "$DDB_TABLE" \
    --query 'TimeToLiveDescription.TimeToLiveStatus' --output text 2>/dev/null || echo UNKNOWN)"
  if [[ "$TTL_STATUS" == "ENABLED" || "$TTL_STATUS" == "ENABLING" ]]; then
    info "TTL already enabled"
  else
    aws dynamodb update-time-to-live \
      --table-name "$DDB_TABLE" \
      --time-to-live-specification "Enabled=true,AttributeName=ttl" >/dev/null
    info "Enabled TTL on attribute 'ttl'"
  fi

  # Least-privilege runtime access: the role only needs GetItem + UpdateItem on this
  # one table. Derive the role NAME from the (possibly user-supplied) role ARN.
  DDB_ARN="arn:aws:dynamodb:${REGION}:${ACCOUNT_ID}:table/${DDB_TABLE}"
  POLICY_DOC="{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Action\":[\"dynamodb:GetItem\",\"dynamodb:UpdateItem\"],\"Resource\":\"${DDB_ARN}\"}]}"
  POLICY_ROLE="${ROLE_ARN##*/}"
  bold "Attaching DynamoDB access policy to role ${POLICY_ROLE}..."
  if aws iam put-role-policy \
      --role-name "$POLICY_ROLE" \
      --policy-name gpx-relay-ddb \
      --policy-document "$POLICY_DOC" >/dev/null 2>&1; then
    info "done"
  else
    err "Could not attach the DynamoDB policy to role '$POLICY_ROLE' automatically."
    err "Add this inline policy to the function's execution role manually:"
    err "$POLICY_DOC"
    info "Continuing -- the relay fails closed (503) until the role can read/write the table."
  fi
fi

# -- package -----------------------------------------------------------------

bold "Packaging function.zip..."
rm -f function.zip
zip -j function.zip index.mjs >/dev/null
info "done"

# Build JSON for the function environment. JSON (not the CLI's `Key=Val` shorthand)
# is required because ALLOWED_ORIGINS contains commas, which the shorthand parser
# would read as separators between key/value pairs.
#
# CORS is intentionally NOT set on the Function URL: the relay code emits its own
# CORS headers (reflecting the matching allowed origin). Setting it in both places
# duplicates `Access-Control-Allow-Origin`, which browsers reject. The relay owns it.
if [[ "$PERSIST" == "1" ]]; then
  ENV_JSON="{\"Variables\":{\"ALLOWED_ORIGINS\":\"${ALLOWED_ORIGINS}\",\"DDB_TABLE\":\"${DDB_TABLE}\"}}"
else
  ENV_JSON="{\"Variables\":{\"ALLOWED_ORIGINS\":\"${ALLOWED_ORIGINS}\"}}"
fi

# -- create or update --------------------------------------------------------

if aws lambda get-function --function-name "$FUNCTION_NAME" >/dev/null 2>&1; then
  bold "Function exists -- updating code + configuration..."
  aws lambda update-function-code \
    --function-name "$FUNCTION_NAME" \
    --zip-file fileb://function.zip >/dev/null
  aws lambda wait function-updated --function-name "$FUNCTION_NAME"
  aws lambda update-function-configuration \
    --function-name "$FUNCTION_NAME" \
    --runtime "$RUNTIME" \
    --memory-size "$MEMORY" --timeout "$TIMEOUT" \
    --environment "$ENV_JSON" >/dev/null
  aws lambda wait function-updated --function-name "$FUNCTION_NAME"
else
  bold "Creating function..."
  aws lambda create-function \
    --function-name "$FUNCTION_NAME" \
    --runtime "$RUNTIME" --architectures "$ARCH" \
    --handler index.handler \
    --role "$ROLE_ARN" \
    --timeout "$TIMEOUT" --memory-size "$MEMORY" \
    --zip-file fileb://function.zip \
    --environment "$ENV_JSON" >/dev/null
  aws lambda wait function-active --function-name "$FUNCTION_NAME"
fi

# -- hard cost ceiling -------------------------------------------------------

bold "Setting reserved concurrency = ${CONCURRENCY}..."
aws lambda put-function-concurrency \
  --function-name "$FUNCTION_NAME" \
  --reserved-concurrent-executions "$CONCURRENCY" >/dev/null

# -- public Function URL (CORS is handled by the relay code, not here) --------

if aws lambda get-function-url-config --function-name "$FUNCTION_NAME" >/dev/null 2>&1; then
  bold "Updating Function URL..."
  # Clear any Function-URL CORS so it doesn't duplicate the relay's own headers.
  aws lambda update-function-url-config \
    --function-name "$FUNCTION_NAME" \
    --auth-type NONE --cors '{}' >/dev/null
else
  bold "Creating public Function URL..."
  aws lambda create-function-url-config \
    --function-name "$FUNCTION_NAME" \
    --auth-type NONE >/dev/null
fi

# Always ensure the public-invoke resource policy (NOT just on first create). Since
# October 2025, a public (auth-type NONE) Function URL needs BOTH statements or every
# invoke returns 403 AccessDeniedException:
#   * lambda:InvokeFunctionUrl  (condition FunctionUrlAuthType = NONE)
#   * lambda:InvokeFunction     (condition InvokedViaFunctionUrl = true)
# Run them every time; treat an already-present statement as OK but surface any other
# failure (don't silently swallow it).
grant_permission() { # grant_permission <statement-id> <action> [extra aws flags...]
  local sid="$1" action="$2"
  shift 2
  local out
  out="$(
    aws lambda add-permission \
      --function-name "$FUNCTION_NAME" \
      --statement-id "$sid" \
      --action "$action" \
      --principal '*' "$@" 2>&1 >/dev/null
  )" || true
  if [[ -n "$out" ]] && ! grep -qi "ResourceConflictException" <<<"$out"; then
    err "Failed to grant $action ($sid):"
    err "$out"
    err "Re-run this script, or add it manually (see README)."
    exit 1
  fi
}

bold "Granting public invoke permissions..."
grant_permission FunctionURLAllowPublicAccess \
  lambda:InvokeFunctionUrl --function-url-auth-type NONE
grant_permission FunctionURLInvokeAllowPublicAccess \
  lambda:InvokeFunction --invoked-via-function-url

FUNCTION_URL="$(aws lambda get-function-url-config --function-name "$FUNCTION_NAME" --query FunctionUrl --output text)"

# -- done --------------------------------------------------------------------

rm -f function.zip

echo
bold "Deployed."
info "Function URL:  $FUNCTION_URL"
echo
bold "Next steps:"
info "1. Set the app build variable so it routes full-GPX through the relay:"
info "     GitHub Pages -> repo Settings -> Secrets and variables -> Actions -> Variables"
info "     GPX_RELAY_URL = $FUNCTION_URL"
info "   ...then re-run the Deploy to GitHub Pages workflow."
info "2. Add a low AWS Budgets alert (e.g. \$1/month) as a cost tripwire."
info "3. Quick check (should print 204):"
info "     curl -i -X OPTIONS \"$FUNCTION_URL\" -H \"Origin: ${ALLOWED_ORIGINS%%,*}\""
if [[ "$PERSIST" == "1" ]]; then
  echo
  info "Persistence is ON (DynamoDB '$DDB_TABLE'). A plain GET reports durable counts:"
  info "     curl -s \"$FUNCTION_URL\" | jq '{persistence,downloads,monthlyDownloads}'"
fi
echo
info "To disable later without deleting: set ENABLED=0 in the function's env vars"
info "(the app then falls back to route-only GPX)."
