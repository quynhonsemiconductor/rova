/**
 * Same-origin reverse proxy used by the Cloudflare Pages Function that fronts the rova SPA. It forwards `/v1/*`
 * (which includes the BFF auth routes `/v1/bff/*`) from the SPA origin (`rova-dev.qnsc.vn`) to the API origin
 * (`rova-api-dev.qnsc.vn`), so the browser sees a single origin. That is what lets the BFF issue a
 * `__Host-rova_session` cookie with `SameSite=Strict` and drop CORS entirely.
 *
 * The forwarding itself is `@quynhonsemiconductor/platform-http/edge`'s `forwardToOrigin`, shared by every product
 * (opshub's proxy is the same call), and this file is only rova's configuration of it. What it does that the
 * hand-written proxy this replaces did not:
 *
 *  - it SIGNS the visitor's address (`cf-connecting-ip`) with `EDGE_CLIENT_IP_SECRET`, covering the address, a
 *    timestamp, the method and the path. Behind a Pages Function the API's own `cf-connecting-ip` is a Cloudflare
 *    address shared by every visitor, and `x-forwarded-for` set by a Function is just a header: the old proxy set it
 *    from `cf-connecting-ip`, which is the Cloudflare address, so every visitor shared one rate-limit bucket. The API
 *    verifies the signature in `clientIp()`;
 *  - it forwards an ALLOW-LIST of headers (never `x-forwarded-for`, `x-real-ip`, `cf-*` or a visitor's own
 *    `x-qnsc-edge-*`), instead of a deny-list of the spoofable ones that missed whatever was not on it;
 *  - it does NOT follow redirects, and hands the API's response back as it is, every `Set-Cookie` included.
 *
 * It no longer sets `x-forwarded-proto` / `x-forwarded-host`. The API does not read them (its cookies are
 * `Secure` by construction, not by protocol sniffing) and Cloudflare's edge sets `X-Forwarded-Proto` itself on the
 * subrequest.
 *
 * Requires the Pages project to expose two variables: `API_ORIGIN` (e.g. `https://rova-api-dev.qnsc.vn`) and
 * `EDGE_CLIENT_IP_SECRET` (a Pages SECRET: the same value as the API's, at least 32 characters). A Function missing
 * either answers 500 naming it: a proxy that quietly forwards unsigned puts every visitor in one bucket.
 */
import { EDGE_SECRET_MIN_LENGTH, forwardToOrigin } from '@quynhonsemiconductor/platform-http/edge'

export interface ProxyEnv {
  API_ORIGIN?: string
  EDGE_CLIENT_IP_SECRET?: string
}

/**
 * Request headers the SPA sends that the shared allow-list does not name: the CSRF token (without it every write is
 * a 403), the SSE reconnect position (`Last-Event-ID`, for the notification stream) and its cache hint, and W3C
 * baggage. Same four as opshub.
 */
export const SPA_FORWARD_HEADERS: readonly string[] = [
  'x-csrf-token',
  'last-event-id',
  'cache-control',
  'baggage',
]

/**
 * Headers the API reads from INTEGRATIONS that call the SPA host rather than the API host. The in-app setup card
 * (`webhook-setup.tsx`) tells admins to register `${origin}/v1/scm/webhook/github`, i.e. this Function, and the GitHub
 * App's webhook URL may be the same. `ScmWebhookController` verifies `X-Hub-Signature-256` over the raw body and
 * dispatches on the other two: without them every delivery is a 401. (The Function the old proxy replaced forwarded
 * everything but a deny-list; an allow-list has to be told about each such header, and
 * `test/edge-forward-headers.ratchet.spec.ts` fails when the API starts reading one that nobody listed.)
 *
 * The body is streamed through untouched, so the HMAC still verifies.
 */
export const INTEGRATION_FORWARD_HEADERS: readonly string[] = [
  'x-hub-signature-256',
  'x-github-event',
  'x-github-delivery',
]

/** The API URL for this request: the API origin, with the incoming path and query as they are. */
export function buildTarget(requestUrl: string, apiOrigin: string): URL {
  const incoming = new URL(requestUrl)
  const target = new URL(apiOrigin)
  target.pathname = incoming.pathname
  target.search = incoming.search
  return target
}

/**
 * Proxy a request to the API origin. `fetcher` is injectable for testing; production uses the platform `fetch`.
 */
export async function proxyToApi(
  request: Request,
  env: ProxyEnv,
  fetcher: (request: Request) => Promise<Response> = (r) => fetch(r),
): Promise<Response> {
  if (!env.API_ORIGIN) {
    return new Response('Proxy misconfigured: API_ORIGIN is not set', { status: 500 })
  }
  const secret = env.EDGE_CLIENT_IP_SECRET?.trim() ?? ''
  if (secret.length < EDGE_SECRET_MIN_LENGTH) {
    return new Response(
      `Proxy misconfigured: EDGE_CLIENT_IP_SECRET is not set (at least ${EDGE_SECRET_MIN_LENGTH} characters)`,
      { status: 500 },
    )
  }
  return forwardToOrigin(
    request,
    {
      secret,
      target: buildTarget(request.url, env.API_ORIGIN),
      forwardHeaders: [...SPA_FORWARD_HEADERS, ...INTEGRATION_FORWARD_HEADERS],
    },
    fetcher,
  )
}
