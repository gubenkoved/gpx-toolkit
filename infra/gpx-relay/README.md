# Beeline full-track GPX relay (AWS Lambda)

A tiny, **stateless** AWS Lambda (Node 20, **zero dependencies**) that lets the
browser app download a ride's **full** recorded GPX (real per-point timestamps +
elevation).

Deploying it is **optional** and only relevant to operators who self-host the app
and want the full recorded track. The app works without it.

## Why it exists

The app is otherwise backend-free. But the final hop of the full-GPX export — the
authenticated `firebasestorage.googleapis.com/…?alt=media` GET — **302-redirects to
a Google download host that returns no `Access-Control-Allow-Origin` header**, so the
browser blocks the cross-origin read. JavaScript cannot work around a missing CORS
header. This relay performs both export hops **server-side** (where CORS does not
apply) and returns the gzipped GPX to the page with permissive CORS headers.

If no relay is configured (or it's unreachable), the app falls back to a
**route-only** GPX synthesized from the cached polyline — no real timestamps or
elevation, but nothing breaks.

## What it does and does not do

- **Does:** accept `POST { "rideId": "<id>" }` with the user's short-lived Beeline
  `Authorization: Bearer <idToken>`, call `exportRide`, download the rendered
  `.gpx.gz` from Storage, and return those gzipped bytes.
- **Never:** sees or stores a password; persists anything at all (no database, no
  disk); accepts a URL/path from the client (only a `rideId`, so it can't be turned
  into an open proxy).
- The id token is short-lived (~1 h) and only **passes through** in transit. Tokens
  are never logged.

## Safety model (read before exposing a public URL)

A Lambda **Function URL has no built-in rate limiter**. Defense is layered, and all
of it stays within the AWS free tier:

1. **Reserved concurrency = 2** (the real hard ceiling) — caps parallel executions
   at the AWS level so abuse can't fan out. This is the most important knob.
2. **AWS Budgets alert** (e.g. **$1/mo**) — the tripwire. If it ever fires, set
   `ENABLED=0` (kill switch) and the app degrades to route-only GPX.
3. **In-relay gates** (before any upstream call / data egress): kill switch, origin
   allow-list, strict `rideId` validation, and a best-effort per-account + per-IP
   rate limit (in warm-container memory — effective when paired with low concurrency,
   not a hard guarantee).

> **Cost:** typical single-operator use sits comfortably inside the AWS
> **always-free** tier (Lambda 1M requests + 400k GB-s/month; each GPX is tens of KB
> gzipped). Confirm the **current** free-tier data-transfer-out (egress) allowance
> for the deployment account — AWS has changed it — and keep the budget alert low so
> charges are caught early.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `ENABLED` | `1` | Kill switch. `0` → relay returns 503 (app falls back to route-only). |
| `ALLOWED_ORIGINS` | _(empty)_ | Comma-separated browser origins allowed to call it. Empty = reflect any (dev only). **Set this in production.** |
| `RL_PER_MIN` | `60` | Per-account/IP requests per minute. |
| `RL_PER_DAY` | `3000` | Per-account/IP requests per day (generous enough for a full backfill). |
| `MAX_BYTES` | `12582912` | Reject upstream GPX larger than this (defensive). |
| `FUNCTIONS_BASE` / `STORAGE_BASE` / `STORAGE_BUCKET` | Beeline defaults | Override only if Beeline's backend moves. |

In the commands below, replace `https://<your-site>` with the origin the app is
served from (e.g. a GitHub Pages URL like `https://<user>.github.io`) and
`http://localhost:5173` with the local dev origin, if used.

---

## Deploy — scripted (easiest)

[`deploy.sh`](./deploy.sh) does the whole thing: it prompts for the function name,
region, allowed origin(s) and a few sizing options, then creates (or updates) the
Lambda, sets the reserved-concurrency cost ceiling, exposes a public Function URL
with CORS locked to your origin(s), and prints the URL to paste into `GPX_RELAY_URL`.
Re-running it updates an existing deployment in place.

```bash
cd infra/gpx-relay
./deploy.sh
```

Requires the AWS CLI v2 configured with credentials (`aws configure`) and `zip`. If
you don't supply an execution role ARN, the script offers to create a minimal one
(`AWSLambdaBasicExecutionRole`). It still leaves the **budget alert** to you (one
manual step in the Billing console — see the Console steps below).

---

## Deploy — AWS Console (quickest)

1. **Lambda → Create function → Author from scratch.**
   - Function name: `beeline-gpx-relay`
   - Runtime: **Node.js 20.x** · Architecture: `arm64` (cheapest) → **Create**.
2. **Add the code.** In the code editor, replace `index.mjs` with the contents of
   [`index.mjs`](./index.mjs) (the handler export is `handler`). **Deploy.**
   - The default handler `index.handler` matches (file `index.mjs`, export
     `handler`).
3. **Configuration → Environment variables → Edit → Add:**
   - `ALLOWED_ORIGINS = https://<your-site>,http://localhost:5173`
   - leave the rest at defaults to start. **Save.**
4. **Configuration → General configuration → Edit:** Timeout **15 sec**, Memory
   **256 MB**. **Save.**
5. **Configuration → Concurrency → Edit → Reserve concurrency = `2`. Save.**
   _(This is the hard cost ceiling — don't skip it.)_
6. **Configuration → Function URL → Create function URL:**
   - Auth type: **NONE**
   - Configure CORS: **off** here (the function sets CORS headers itself; enabling
     the Function URL's own CORS too can duplicate the headers). To let the platform
     handle CORS instead, leave the function's headers and turn this on with the same
     origins — but don't do both.
   - **Save** and **copy the Function URL** (looks like
     `https://<id>.lambda-url.<region>.on.aws/`).
7. **Budget alert (tripwire).** Billing → **Budgets → Create budget** → Cost budget
   → amount **$1/month** → add an email alert at 80%. **Create.**

Then wire the URL into the web app (see **Connect the app** below).

---

## Deploy — AWS CLI (reproducible)

Requires the AWS CLI configured and an execution role ARN (any role with the basic
`AWSLambdaBasicExecutionRole` is enough — this function needs no AWS permissions).

```bash
cd infra/gpx-relay

# 1. Package
npm run zip            # -> function.zip

# 2. Create the function (replace ROLE_ARN, REGION and the origins)
aws lambda create-function \
  --function-name beeline-gpx-relay \
  --runtime nodejs20.x --architectures arm64 \
  --handler index.handler \
  --role <ROLE_ARN> \
  --timeout 15 --memory-size 256 \
  --zip-file fileb://function.zip \
  --environment "Variables={ALLOWED_ORIGINS=https://<your-site>\,http://localhost:5173}"

# 3. Hard ceiling: reserved concurrency
aws lambda put-function-concurrency \
  --function-name beeline-gpx-relay --reserved-concurrent-executions 2

# 4. Public Function URL with CORS
aws lambda create-function-url-config \
  --function-name beeline-gpx-relay \
  --auth-type NONE \
  --cors 'AllowOrigins=https://<your-site>,http://localhost:5173,AllowMethods=POST,AllowHeaders=authorization,content-type'

# 5. Allow the public to invoke the URL. Since October 2025 a public (auth-type
#    NONE) Function URL needs BOTH of these statements, or every call 403s.
aws lambda add-permission \
  --function-name beeline-gpx-relay \
  --statement-id FunctionURLAllowPublicAccess \
  --action lambda:InvokeFunctionUrl \
  --principal '*' --function-url-auth-type NONE
aws lambda add-permission \
  --function-name beeline-gpx-relay \
  --statement-id FunctionURLInvokeAllowPublicAccess \
  --action lambda:InvokeFunction \
  --principal '*' --invoked-via-function-url

# Print the URL
aws lambda get-function-url-config --function-name beeline-gpx-relay --query FunctionUrl --output text
```

Update the code later: `npm run zip && aws lambda update-function-code
--function-name beeline-gpx-relay --zip-file fileb://function.zip`.

Change a limit without redeploying code: edit the env vars
(`aws lambda update-function-configuration --function-name beeline-gpx-relay
--environment …`).

---

## Connect the app

The web build reads the relay URL from an env var at build time and bakes it in
(`__GPX_RELAY_URL__`). When it's empty (the default), the app uses the direct
in-browser path — i.e. it stays fully backend-free for local dev / native shells.

- **GitHub Pages deploy:** in the repo, **Settings → Secrets and variables →
  Actions → Variables → New repository variable**:
  - `GPX_RELAY_URL = https://<id>.lambda-url.<region>.on.aws/`

  Re-run the **Deploy to GitHub Pages** workflow.

- **Local build:** `GPX_RELAY_URL=https://… npm run build`.

When set, the first time a user downloads a **full** GPX the app shows a one-time
consent dialog explaining that the request is routed through the relay and what is
(and isn't) sent. They can tick "Don't ask again" to remember it.

---

## Quick test

Replace `<FUNCTION_URL>`, `<your-site>`, `<ID_TOKEN>` (a live Beeline id token, e.g.
from the app's network tab) and `<PUSH_ID>`:

```bash
# Preflight should return 204 with Access-Control-Allow-* headers:
curl -i -X OPTIONS "<FUNCTION_URL>" -H "Origin: https://<your-site>"

# A real call needs a live Beeline idToken:
curl -i -X POST "<FUNCTION_URL>" \
  -H "Origin: https://<your-site>" \
  -H "Authorization: Bearer <ID_TOKEN>" \
  -H "Content-Type: application/json" \
  --data '{"rideId":"<PUSH_ID>"}' --output ride.gpx.gz
gunzip -c ride.gpx.gz | head   # -> GPX with <trkpt><ele><time>
```
