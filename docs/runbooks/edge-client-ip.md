# Runbook: the visitor's real address (signed edge client IP)

## Why

Behind the Cloudflare Tunnel `req.ip` is `cloudflared`'s own address, so everything keyed by the client address
(rate limiting, the access log, idempotency fingerprints, the address recorded on a session) saw **one client**: every
visitor shared the `AUTH_LOGIN` bucket (5 attempts per 15 minutes) and the `DEFAULT` bucket (100 per minute).

Behind a Pages Function it is worse: the Function's request to the API carries a Cloudflare-internal
`cf-connecting-ip` that is the same for everyone, and an `x-forwarded-for` the Function sets is only a header that
anyone who reaches the API without the Function can set too. So the Function **signs** the address it saw
(`@quynhonsemiconductor/platform-http/edge`, HMAC-SHA256 over `timestamp|ip|METHOD|path` with a key only the Function
and the API hold), and the API believes the address only if the signature verifies for that request (`clientIp()`,
`@quynhonsemiconductor/platform-http`). A forged, replayed-elsewhere or stale (more than 60 s) signature is ignored
and counted, never trusted.

`clientIp()` resolves, in order: a **verified** signed edge address (only when `EDGE_CLIENT_IP_SECRET` is set) →
`cf-connecting-ip` → the first `x-forwarded-for` entry → the socket. Opshub does the same (opshub#364); the secret
names, the Pages variables and the steps below are aligned with it.

## PRODUCTION: set the Pages secret BEFORE "go release"

> **The production Pages secret must exist before the release PR that contains this change is released.** Otherwise the
> new Function reaches production with no `EDGE_CLIENT_IP_SECRET`, answers **500 to every `/v1/*` request on
> `rova.qnsc.vn`**, and the production deploy gate fails: its post-deploy check requests `APP_URL/v1/readyz`, and
> `APP_URL` is the SPA host, so that request goes through the Function. The release then rolls back the API while the
> broken Function stays published.

```sh
KEY=$(openssl rand -base64 48)      # production's OWN key: never the develop one
printf '%s' "$KEY" | wrangler pages secret put EDGE_CLIENT_IP_SECRET --project-name rova-prod-web
```

Do that, and confirm it is listed (`wrangler pages secret list --project-name rova-prod-web`), before saying "go release".
The API side for production (the key in the `rova/production/app` bundle and `edge_client_ip_secret_set = true`) follows
the same steps 3 and 4 below, after the release, in a window of its own.

## The two secrets, and what happens with each half missing

| State                                                    | Function (Pages)                                                 | API                                                                |
| -------------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------ |
| Pages secret **unset** (after this change is deployed)   | answers **500** naming `EDGE_CLIENT_IP_SECRET`, forwards nothing | n/a                                                                |
| API secret **unset** (`edge_client_ip_secret_set=false`) | signs                                                            | ignores the signed headers, uses `cf-connecting-ip` (as before)    |
| Both set, **same** value                                 | signs                                                            | verifies, and uses the visitor's address                           |
| Both set, **different** values                           | signs                                                            | every signature is `bad_signature`: falls back, and logs a warning |

The 500 in the first row is deliberate: a proxy that quietly forwards unsigned puts every visitor back in one bucket
with nothing to say so. It is also why **step 1 comes before the merge**.

## Owner steps, in order (develop first; production repeats them with its own key)

**Never reuse a key across environments, and never paste a key into a command line that is logged or into the PR.**

1. **Before merging the adoption PR** — generate a key and set it as the Pages secret. The currently deployed
   Function ignores it, so this changes nothing yet.

   ```sh
   KEY=$(openssl rand -base64 48)          # 64 characters; keep it in your shell only
   printf '%s' "$KEY" | wrangler pages secret put EDGE_CLIENT_IP_SECRET --project-name rova-develop-web
   ```

   A Pages secret reaches a Function only on its **next deployment**, which the merge of the adoption PR performs
   (`Web · Deploy`). Do not merge before this step: the new Function would answer 500 for every `/v1/*` request.

2. **Merge the adoption PR.** `Infrastructure · Apply` adds the key `edge-client-ip-secret` to the expected keys of the
   app bundle `rova/develop/app` (develop and production both run with `secrets_use_bundle = true`: the secret is a
   KEY of that JSON object, not a container of its own). It is **not** injected into the API: `edge_client_ip_secret_set`
   is `false`. The API deploys without it and ignores the signed headers, so behaviour is unchanged (still
   `cf-connecting-ip`); the Function starts signing.

3. **Put the same key into the bundle.** A read-modify-write of the bundle's JSON; the values are piped between
   processes and never printed, and the key reaches the script through the environment, not argv (so it is not in
   `ps`). The key is still in `$KEY` from step 1; otherwise generate a new one and repeat step 1 with it.

   ```sh
   export KEY AWS_PROFILE=qnsc-admin AWS_REGION=ap-southeast-1
   aws secretsmanager get-secret-value --secret-id rova/develop/app --query SecretString --output text \
     | python3 -c 'import json,os,sys; d=json.load(sys.stdin); d["edge-client-ip-secret"]=os.environ["KEY"]; print(json.dumps(d))' \
     | aws secretsmanager put-secret-value --secret-id rova/develop/app --secret-string file:///dev/stdin
   # Verify WITHOUT printing the value: the key exists and has the right length
   aws secretsmanager get-secret-value --secret-id rova/develop/app --query SecretString --output text \
     | python3 -c 'import json,sys; v=json.load(sys.stdin)["edge-client-ip-secret"]; print("edge-client-ip-secret:", len(v), "chars")'
   unset KEY
   ```

4. **Switch the API on:** a one-line PR setting `edge_client_ip_secret_set = true` in `infra/live/develop/main.tf`.
   Its apply registers the task definition with `EDGE_CLIENT_IP_SECRET`; the deploy's preflight refuses to proceed if
   the secret is empty, which is what step 3 prevents.

5. **Check (below).**

Production: the same, with `--project-name rova-prod-web` and the bundle `rova/production/app`, in a window of its own,
with its own key.

## Post-deploy check: the request log's `ip` is the tester's real address

Do it twice: after step 2 (expect the **old** behaviour) and after step 4 (expect the real address).

1. The tester learns their public address: `curl -s https://api.ipify.org`.
2. They make a request through the SPA origin, e.g. open the app or `curl -s https://rova-dev.qnsc.vn/v1/config`.
3. CloudWatch Logs Insights on `/ecs/rova-develop-api`, last 15 minutes:

   ```
   fields @timestamp, ip, url, statusCode
   | filter url like /\/v1\/config/
   | sort @timestamp desc
   | limit 20
   ```

   - After step 2 `ip` is a Cloudflare or `cloudflared` address, the same for every visitor.
   - After step 4 `ip` is **the tester's address** from (1). If it is still a Cloudflare address, go to the table above.

4. No refusals: the API logs `Refused signed edge client IPs since the last report: ...` (at most once a minute) and
   counts `edge_client_ip.rejected{reason}`. `bad_signature` means the two ends hold different keys (surrounding
   whitespace is ignored on both), a rotation is half done, or the Function signs a different path than the API
   receives. `stale` means a clock more than 60 s apart.
5. Rate limiting is per visitor: two testers on different networks each make one request to a route with the strict
   tier and each see their own `RateLimit-Remaining`, rather than sharing one count.
6. Sign-in still works end to end (cookie set, `GET /v1/auth/me` 200): the Function no longer sets `x-forwarded-proto`
   or `x-forwarded-host`, and the API reads neither.

## Rotation

The API verifies against the current key **and** `EDGE_CLIENT_IP_SECRET_PREVIOUS`, so rotation has no window in which
signatures fail:

1. API: set the NEW key as `EDGE_CLIENT_IP_SECRET` and the OLD one as `EDGE_CLIENT_IP_SECRET_PREVIOUS` (both >= 32
   characters; the API refuses to start with a previous key and no current one) and deploy. It now accepts both.
2. Pages: set the NEW key as the Pages secret and redeploy the Function. It signs with the new key.
3. API: remove `EDGE_CLIENT_IP_SECRET_PREVIOUS` and deploy.

`EDGE_CLIENT_IP_SECRET_PREVIOUS` is not wired in Terraform (it exists for these few minutes): it is a task-definition
environment edit, and the PR that does it should say so.

## Rollback

Set `edge_client_ip_secret_set = false` (the API ignores the signature and behaves exactly as before the change), or
unset the Pages secret **only together with** reverting the Function (an unset secret makes it answer 500).
