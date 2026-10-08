# Full-track GPX relay (optional)

A tiny, stateless AWS Lambda (Node.js 24, no dependencies) that lets the web app
download a Beeline ride's **full** recorded GPX, with real per-point timestamps and
elevation.

You only need it if you host the app yourself and want full tracks. Without it the app
works the same, except that downloads fall back to a **route-only** GPX built from the
stored route shape.

## Why it exists

The last step of Beeline's GPX export, an authenticated Firebase Storage download,
redirects to a Google host that sends no `Access-Control-Allow-Origin` header, so the
browser refuses to read the file. The relay makes both export calls server-side, where
CORS doesn't apply, and returns the gzipped GPX to the page.

- **It does:** accept `POST {"rideId": "<id>"}` with the user's short-lived Beeline token
  (`Authorization: Bearer <idToken>`), ask Beeline to export the ride, download the
  `.gpx.gz`, and return it.
- **It never:** sees a password, accepts a URL from the client (so it can't be used as an
  open proxy), logs tokens, or stores rides or personal data. With durable counters
  enabled it stores a few numbers in DynamoDB, nothing else.

## Deploy

Needs the AWS CLI v2 with credentials (`aws configure`) and `zip`:

```bash
cd infra/gpx-relay
./deploy.sh
```

The script asks for a function name, region, the allowed origin(s) and a few sizes, then:

1. creates or updates the Lambda (re-running it updates in place),
2. offers to create a minimal execution role and the optional DynamoDB counters table,
3. sets **reserved concurrency** as the hard cost ceiling,
4. creates a public Function URL and prints it.

Then add an **AWS Budgets** alert (e.g. $1/month, alert at 80%) in the Billing console.
That is the one manual step.

## Connect the app

The build bakes the relay URL in from `GPX_RELAY_URL`; when it's empty (the default) the
app stays backend-free.

- **GitHub Pages:** repository **Settings → Secrets and variables → Actions → Variables**,
  add `GPX_RELAY_URL = https://<id>.lambda-url.<region>.on.aws/`, then re-run the
  **Deploy to GitHub Pages** workflow.
- **Local build:** `GPX_RELAY_URL=https://… npm run build`.

The first time someone downloads a full GPX, the app asks once for consent to route the
request through the relay, explaining what is sent.

## Cost and safety

A Function URL has no built-in rate limiter, so protection is layered:

1. **Reserved concurrency** caps how many copies can run at once. This is the main cost
   ceiling.
2. **Checks inside the relay**, before any upstream call: a kill switch (`ENABLED=0`), an
   origin allow-list, strict `rideId` validation, per-account rate limits (per IP when
   the token carries no account) and a global monthly download cap.
3. **A budget alert** as the tripwire. If it fires, set `ENABLED=0`; the app falls back to
   route-only GPX.

Rate-limit counters live in memory by default, so they reset on cold starts and are only
exact with reserved concurrency 1. With **durable counters** (`DDB_TABLE`) they live in a
DynamoDB table instead: exact across containers, so the script defaults to concurrency 2.
The table uses the always-free tier (provisioned 5/5, expired windows removed by TTL), and
the relay calls DynamoDB through the AWS SDK that ships with the Lambda runtime. If
DynamoDB is unreachable the relay **fails closed** (503) and the app falls back to
route-only GPX.

Typical single-operator use fits in the AWS free tier (each GPX is tens of KB). Check the
current free-tier terms for your account, especially data transfer out.

## Settings

All limits are environment variables, so changing one needs no redeploy.

| Variable | Default | Purpose |
|---|---|---|
| `ENABLED` | `1` | Kill switch. `0` returns 503 and the app falls back to route-only GPX. |
| `ALLOWED_ORIGINS` | _(empty)_ | Comma-separated browser origins allowed to call the relay, e.g. `https://<user>.github.io,http://localhost:5173`. Empty allows any origin: for local testing only. `deploy.sh` refuses to deploy without one. |
| `RL_PER_MIN` | `60` | Requests per minute per account (or IP). |
| `RL_PER_DAY` | `3000` | Requests per day per account (or IP); enough for a full backfill. |
| `RL_GLOBAL_PER_MONTH` | `10000` | Successful downloads per calendar month (UTC) across everyone. Exact with durable counters or reserved concurrency 1. |
| `DDB_TABLE` | _(empty)_ | DynamoDB table for durable counters. Empty keeps them in memory. |
| `MAX_BYTES` | `12582912` | Largest GPX accepted from upstream (12 MB). |
| `FUNCTIONS_BASE`, `STORAGE_BASE`, `STORAGE_BUCKET` | Beeline's | Override only if Beeline's backend moves. |

## Check it works

```bash
# CORS preflight: expect 204 with Access-Control-Allow-* headers
curl -i -X OPTIONS "<FUNCTION_URL>" -H "Origin: https://<your-site>"

# A real download needs a live Beeline id token (e.g. from the app's network tab)
curl -X POST "<FUNCTION_URL>" \
  -H "Origin: https://<your-site>" \
  -H "Authorization: Bearer <ID_TOKEN>" \
  -H "Content-Type: application/json" \
  --data '{"rideId":"<RIDE_ID>"}' --output ride.gpx.gz
gunzip -c ride.gpx.gz | head   # <trkpt> points with <ele> and <time>

# Liveness and counters (no auth; answers even when ENABLED=0)
curl -s "<FUNCTION_URL>" | jq
```

The GET reports `persistence` (`memory` or `dynamodb`), `downloads`, `monthlyDownloads`
against `monthlyLimit`, `enabled`, and the container's `instanceId`, `startedAt` and
`uptimeSeconds` (a new `instanceId` means a cold start). With DynamoDB it also reports
`containerDownloads`, and `storeError: true` after a failed read.

## Manual deploy

<details>
<summary>AWS Console</summary>

1. **Lambda → Create function → Author from scratch:** name `beeline-gpx-relay`, runtime
   **Node.js 24.x**, architecture `arm64`.
2. Replace `index.mjs` in the code editor with [`index.mjs`](./index.mjs) and **Deploy**.
   The default handler `index.handler` is correct.
3. **Configuration → Environment variables:** set `ALLOWED_ORIGINS` (and `DDB_TABLE` if
   you do step 6).
4. **Configuration → General configuration:** timeout **15 s**, memory **256 MB**.
5. **Configuration → Concurrency:** reserve **1** (or **2** with durable counters).
6. _(Optional, durable counters)_ **DynamoDB → Create table** `beeline-gpx-relay-state`,
   partition key `pk` (String), provisioned capacity 5/5. Turn on **Time to Live** for
   attribute `ttl`. Give the execution role `dynamodb:GetItem` and `dynamodb:UpdateItem`
   on that table.
7. **Configuration → Function URL → Create:** auth type **NONE**, CORS **off** (the relay
   sends its own CORS headers; setting them in both places duplicates them and browsers
   reject the response). Copy the URL.
8. Add the budget alert (see [Deploy](#deploy)).

</details>

<details>
<summary>AWS CLI</summary>

Replace `<ROLE_ARN>` (any role with `AWSLambdaBasicExecutionRole`), `<ROLE_NAME>`,
`<REGION>`, `<ACCOUNT>` and `<your-site>`.

```bash
cd infra/gpx-relay
npm run zip   # -> function.zip

aws lambda create-function \
  --function-name beeline-gpx-relay \
  --runtime nodejs24.x --architectures arm64 \
  --handler index.handler --role <ROLE_ARN> \
  --timeout 15 --memory-size 256 \
  --zip-file fileb://function.zip \
  --environment '{"Variables":{"ALLOWED_ORIGINS":"https://<your-site>,http://localhost:5173"}}'

aws lambda put-function-concurrency \
  --function-name beeline-gpx-relay --reserved-concurrent-executions 1

# No --cors here: the relay sends its own CORS headers.
aws lambda create-function-url-config \
  --function-name beeline-gpx-relay --auth-type NONE

# A public Function URL needs both statements, or every call returns 403.
aws lambda add-permission --function-name beeline-gpx-relay \
  --statement-id FunctionURLAllowPublicAccess \
  --action lambda:InvokeFunctionUrl --principal '*' --function-url-auth-type NONE
aws lambda add-permission --function-name beeline-gpx-relay \
  --statement-id FunctionURLInvokeAllowPublicAccess \
  --action lambda:InvokeFunction --principal '*' --invoked-via-function-url

aws lambda get-function-url-config --function-name beeline-gpx-relay \
  --query FunctionUrl --output text
```

Durable counters (optional): create the table, turn on TTL, grant the role access, then
add `"DDB_TABLE":"beeline-gpx-relay-state"` to the environment and raise concurrency to 2.

```bash
aws dynamodb create-table --table-name beeline-gpx-relay-state \
  --attribute-definitions AttributeName=pk,AttributeType=S \
  --key-schema AttributeName=pk,KeyType=HASH \
  --provisioned-throughput ReadCapacityUnits=5,WriteCapacityUnits=5
aws dynamodb wait table-exists --table-name beeline-gpx-relay-state
aws dynamodb update-time-to-live --table-name beeline-gpx-relay-state \
  --time-to-live-specification 'Enabled=true,AttributeName=ttl'
aws iam put-role-policy --role-name <ROLE_NAME> --policy-name gpx-relay-ddb \
  --policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":["dynamodb:GetItem","dynamodb:UpdateItem"],"Resource":"arn:aws:dynamodb:<REGION>:<ACCOUNT>:table/beeline-gpx-relay-state"}]}'
```

Later updates: `npm run zip && aws lambda update-function-code --function-name
beeline-gpx-relay --zip-file fileb://function.zip`. A function created on Node.js 20
moves to 24 with `aws lambda update-function-configuration --function-name
beeline-gpx-relay --runtime nodejs24.x` (or by re-running `deploy.sh`).

</details>
