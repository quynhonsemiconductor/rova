import { BRAND } from '@/shared/config/brand'
import { useState } from 'react'
import { signInErrorFrom } from './sign-in-error'
import { useTranslation } from 'react-i18next'
import { Layers, ShieldCheck, Check, AlertCircle } from 'lucide-react'
import { ENV } from '@/shared/config/env'

// ── Microsoft logo SVG (official 4-square mark) ────────────────────────────
function MicrosoftLogo() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 21 21"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <rect x="1" y="1" width="9" height="9" fill="#f25022" />
      <rect x="11" y="1" width="9" height="9" fill="#7fba00" />
      <rect x="1" y="11" width="9" height="9" fill="#00a4ef" />
      <rect x="11" y="11" width="9" height="9" fill="#ffb900" />
    </svg>
  )
}

export function LoginPage() {
  const { t } = useTranslation('auth')
  const [ssoLoading, setSsoLoading] = useState(false)
  const [ssoError, setSsoError] = useState<string | null>(null)
  const [email, setEmail] = useState('')
  const [emailLoading, setEmailLoading] = useState(false)
  const [emailError, setEmailError] = useState<string | null>(null)
  /**
   * Defaults to the EDITOR, not the Workspace Admin — deliberately, and this one line is why.
   *
   * A Workspace Admin holds `workspace:*`, which satisfies every project-tier check, so developing and
   * demoing as one masks an entire class of defect. It is not hypothetical: `report:view` was missing
   * from two roles and every report 403'd for everyone except a WA until migration 0092;
   * `GET /work-items/by-key` carried an admin-only code so every notification click 403'd for both
   * non-admin roles; and gating the project roster made every Editor see `Unassigned` on every owned
   * item, because the roster was also the only owner feed. All three were invisible locally for the
   * same reason — the default principal could not fail.
   *
   * `dev@qnsc.dev` is a real per-project Editor on NXP and No Access on PAY (`db/seeds/demo.ts`), which
   * is the level most users actually have. `viewer@qnsc.dev` is a clean No Access principal, and
   * `admin@qnsc.dev` is still one keystroke away for admin surfaces.
   *
   * The systematic guard is `test/route-audience.ratchet.spec.ts`, which fails on every `vitest run`
   * rather than only when someone opens the affected screen. This default makes the same class visible
   * by accident, which is the half a test cannot cover.
   */
  const [devEmail, setDevEmail] = useState('dev@qnsc.dev')
  const signInError = signInErrorFrom(window.location.search)
  const [devLoading, setDevLoading] = useState(false)
  const [devError, setDevError] = useState<string | null>(null)

  /**
   * Start the Microsoft sign-in (identity 8, Better Auth): `POST /api/auth/sign-in/social` runs the Authorization-Code +
   * PKCE flow SERVER-side and answers the Microsoft authorize URL; the browser is handed to Microsoft and comes back to
   * `/api/auth/callback/microsoft`, which creates the session and sets the opaque cookie before redirecting to
   * `callbackURL`. No token reaches the SPA. `/api/auth/*` is same-origin with the SPA like `/v1/*` (the Vite proxy
   * locally, a Pages Function deployed): a requirement, not a preference, because the cookie is set on the response the
   * browser lands on.
   *
   * `callbackURL` is a same-site path only (Better Auth also validates it against its trusted origins), so a hostile
   * `returnTo` cannot bounce the browser off-site. `errorCallbackURL` brings a refused sign-in (a banned user, the wrong
   * tenant, no invitation) back to this page with `?error=<CODE>` instead of the API's own error page.
   *
   * `loginHint` pre-fills the address at Microsoft for the invited person who typed theirs (a vendor signs in as a guest
   * of the company tenant). It is a hint, never an authorization: the API decides who gets in.
   */
  async function startMicrosoftSignIn(loginHint?: string): Promise<boolean> {
    const requested = new URLSearchParams(window.location.search).get('returnTo') ?? '/'
    const callbackURL = requested.startsWith('/') && !requested.startsWith('//') ? requested : '/'
    const res = await fetch('/api/auth/sign-in/social', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: 'microsoft',
        callbackURL,
        errorCallbackURL: '/login',
        ...(loginHint ? { loginHint } : {}),
      }),
    })
    if (!res.ok) return false
    const { url } = (await res.json()) as { url?: string }
    if (!url) return false
    window.location.assign(url) // execution stops at the redirect
    return true
  }

  // ── One-click Microsoft sign-in (staff) ─────────────────────────────
  async function handleSsoLogin() {
    setSsoLoading(true)
    setSsoError(null)
    try {
      if (!(await startMicrosoftSignIn())) {
        setSsoError(t('errors.ssoInit'))
        setSsoLoading(false)
      }
    } catch {
      setSsoError(t('errors.ssoInit'))
      setSsoLoading(false)
    }
  }

  // ── Email-first sign-in (invited guests / vendors) ──────────────────
  // Same Microsoft sign-in with the address as a hint. Whether the person may come in is decided on the API (a profile or
  // a live invitation), not here, so an unknown address is learned from the `?error=` the sign-in returns with.
  async function handleEmailLogin(e: React.FormEvent) {
    e.preventDefault()
    setEmailLoading(true)
    setEmailError(null)
    try {
      if (!(await startMicrosoftSignIn(email))) {
        setEmailError(t('signInFailed'))
        setEmailLoading(false)
      }
    } catch {
      setEmailError(t('signInFailed'))
      setEmailLoading(false)
    }
  }

  // ── Dev sign-in (non-production only) ───────────────────────────────
  async function handleDevLogin(e: React.FormEvent) {
    e.preventDefault()
    setDevLoading(true)
    setDevError(null)
    try {
      // identity's passwordless `/api/auth/test-login`: it exists only when the API runs with IDENTITY_TEST_LOGIN=enabled
      // and NODE_ENV development/test. The session lands on the server; the browser holds no tokens.
      const res = await fetch('/api/auth/test-login', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: devEmail }),
      })
      if (!res.ok) {
        setDevError(t('errors.devLoginFailed'))
        setDevLoading(false)
        return
      }
      // Full reload — bootstrapAuth() restores the session from the cookie.
      window.location.assign('/')
    } catch {
      setDevError(t('errors.devApiUnreachable'))
      setDevLoading(false)
    }
  }

  const features = [t('features.control'), t('features.visibility'), t('features.governance')]

  return (
    <main
      className="grid min-h-svh bg-background lg:grid-cols-[minmax(420px,0.9fr)_minmax(560px,1.1fr)]"
      style={{ fontFamily: "'Inter', system-ui, sans-serif" }}
    >
      {/* ── Left panel ─────────────────────────────────────────────────────── */}
      <section className="relative hidden flex-col justify-between overflow-hidden bg-primary p-10 text-white lg:flex xl:p-14">
        <div
          className="absolute inset-0 opacity-20"
          style={{
            backgroundImage:
              'radial-gradient(circle at 15% 20%, #8cb3e8 0, transparent 28%), radial-gradient(circle at 85% 82%, #5b83bd 0, transparent 32%)',
          }}
        />
        {/* Logo */}
        <div className="relative flex items-center gap-3">
          <div
            className="flex h-9 w-9 items-center justify-center rounded-md"
            style={{
              backgroundColor: 'rgba(255,255,255,0.15)',
              border: '1px solid rgba(255,255,255,0.18)',
            }}
          >
            <Layers size={19} />
          </div>
          <div>
            <div className="text-base font-semibold tracking-tight">{t('common:appName')}</div>
            <div className="text-ui-xs" style={{ color: 'rgba(255,255,255,0.55)' }}>
              {t('common:platformTagline')}
            </div>
          </div>
        </div>

        {/* Hero copy */}
        <div className="relative max-w-xl">
          <div
            className="mb-5 inline-flex items-center gap-1.5 rounded px-2 py-1 text-ui-xs font-semibold tracking-widest uppercase"
            style={{ backgroundColor: 'rgba(255,255,255,0.12)', color: 'rgba(255,255,255,0.78)' }}
          >
            <ShieldCheck size={12} />
            {t('workspaceAdmin')}
          </div>
          <h1 className="text-3xl leading-tight font-semibold tracking-tight xl:text-4xl">
            {t('heroLine1')}
            <br />
            {t('heroLine2')}
          </h1>
          <p
            className="mt-4 max-w-md text-ui-xl leading-6"
            style={{ color: 'rgba(255,255,255,0.66)' }}
          >
            {t('taglineDesc')}
          </p>
          <div className="mt-8 grid max-w-lg grid-cols-3 gap-3">
            {features.map((f) => (
              <div
                key={f}
                className="flex items-center gap-2 text-ui-sm"
                style={{ color: 'rgba(255,255,255,0.74)' }}
              >
                <span
                  className="flex h-4 w-4 items-center justify-center rounded-full"
                  style={{ backgroundColor: 'rgba(255,255,255,0.12)' }}
                >
                  <Check size={9} />
                </span>
                {f}
              </div>
            ))}
          </div>
        </div>

        <div className="relative text-ui-xs" style={{ color: 'rgba(255,255,255,0.45)' }}>
          {t('copyright')}
        </div>
      </section>

      {/* ── Right panel ────────────────────────────────────────────────────── */}
      <section className="flex items-center justify-center px-5 py-10 sm:px-10">
        <div className="w-full max-w-[430px]">
          {/* Mobile logo */}
          <div className="mb-8 flex items-center gap-2 lg:hidden">
            <div className="flex h-8 w-8 items-center justify-center rounded bg-primary text-white">
              <Layers size={16} />
            </div>
            <div>
              <div className="text-ui-xl font-semibold text-foreground">{t('common:appName')}</div>
              <div className="text-ui-xs text-foreground-subtle">{t('common:platformTagline')}</div>
            </div>
          </div>

          {/* Card */}
          <div className="overflow-hidden rounded-md border border-border-strong bg-card shadow-sm">
            {/* Card header */}
            <div className="border-b border-border-inner px-7 pt-7 pb-5">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <p className="mb-1 text-ui-xs font-semibold tracking-widest text-foreground-subtle uppercase">
                    {t('adminAccess')}
                  </p>
                  <h2 className="text-xl font-semibold tracking-tight text-foreground">
                    {t('signIn')}
                  </h2>
                </div>
                <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary-lighter text-primary">
                  <ShieldCheck size={19} />
                </div>
              </div>
              <p className="mt-2 text-ui-md text-muted-foreground">{t('orgAccountPrompt')}</p>
            </div>

            <div className="px-7 py-6">
              {signInError && (
                <div
                  role="alert"
                  className="mb-4 flex items-start gap-2 rounded border border-destructive-border bg-destructive-bg px-3 py-2.5 text-ui-sm text-destructive"
                >
                  <AlertCircle size={14} className="mt-px shrink-0" />
                  <div>
                    <p>{signInError.message}</p>
                    <p className="mt-1 text-ui-xs text-foreground-subtle">
                      Error code: {signInError.code}
                    </p>
                  </div>
                </div>
              )}
              {/* ── Email-first sign-in (invited guests) ───────────────────── */}
              <form onSubmit={handleEmailLogin} className="mb-4 flex flex-col gap-3">
                {emailError && (
                  <div
                    role="alert"
                    className="flex items-start gap-2 rounded border border-destructive-border bg-destructive-bg px-3 py-2.5 text-ui-sm text-destructive"
                  >
                    <AlertCircle size={14} className="mt-px shrink-0" />
                    {emailError}
                  </div>
                )}
                <div className="flex flex-col gap-1.5">
                  <label
                    htmlFor="login-email"
                    className="text-ui-sm font-medium text-muted-foreground"
                  >
                    {t('email')}
                  </label>
                  <input
                    id="login-email"
                    type="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className="h-10 w-full rounded border border-border-strong px-3 text-ui-lg text-foreground outline-none"
                    placeholder={t('workEmailPlaceholder')}
                  />
                </div>
                <button
                  type="submit"
                  disabled={emailLoading}
                  className="flex w-full items-center justify-center gap-2 rounded bg-primary py-3 text-ui-lg font-medium text-white transition-colors disabled:opacity-60"
                >
                  {emailLoading ? t('continuing') : t('continueWithEmail')}
                </button>
              </form>

              {/* divider */}
              <div className="mb-4 flex items-center gap-3 text-ui-xs text-foreground-subtle">
                <span className="h-px flex-1 bg-border" />
                {t('orDivider')}
                <span className="h-px flex-1 bg-border" />
              </div>

              {/* ── SSO sign-in ──────────────────────────────────────────── */}
              {ssoError && (
                <div
                  role="alert"
                  className="mb-4 flex items-start gap-2 rounded border border-destructive-border bg-destructive-bg px-3 py-2.5 text-ui-sm text-destructive"
                >
                  <AlertCircle size={14} className="mt-px shrink-0" />
                  {ssoError}
                </div>
              )}

              <button
                type="button"
                onClick={handleSsoLogin}
                disabled={ssoLoading}
                className="flex w-full items-center justify-center gap-3 rounded border border-border-strong bg-card py-3 text-ui-lg font-medium text-foreground transition-colors disabled:opacity-60"
                style={{ boxShadow: '0 1px 2px rgba(0,0,0,0.06)' }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.backgroundColor = BRAND.surfaceSubtle
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.backgroundColor = BRAND.surface
                }}
              >
                {ssoLoading ? (
                  <span
                    className="h-5 w-5 animate-spin rounded-full border-2 border-border-strong border-t-primary"
                    aria-label="Signing in…"
                  />
                ) : (
                  <MicrosoftLogo />
                )}
                {ssoLoading ? t('redirectingToMicrosoft') : t('signInWithMicrosoft')}
              </button>
              {/* ── Dev sign-in ─────────────────────────────────────────────
                  Shown when VITE_DEV_LOGIN=true (any non-prod deployment), so QA
                  exercises the identical same-origin session flow without an
                  Entra tenant. Never enabled in production. */}
              {ENV.DEV_LOGIN_ENABLED && (
                <form onSubmit={handleDevLogin} className="flex flex-col gap-4">
                  <p className="text-ui-md text-muted-foreground">{t('devOnlyPrompt')}</p>

                  {devError && (
                    <div
                      role="alert"
                      className="flex items-start gap-2 rounded border border-destructive-border bg-destructive-bg px-3 py-2.5 text-ui-sm text-destructive"
                    >
                      <AlertCircle size={14} className="mt-px shrink-0" />
                      {devError}
                    </div>
                  )}

                  <div className="flex flex-col gap-1.5">
                    <label
                      htmlFor="dev-email"
                      className="text-ui-sm font-medium text-muted-foreground"
                    >
                      {t('devEmailLabel')}
                    </label>
                    <input
                      id="dev-email"
                      type="email"
                      required
                      value={devEmail}
                      onChange={(e) => setDevEmail(e.target.value)}
                      className="h-10 w-full rounded border border-border-strong px-3 text-ui-lg text-foreground outline-none"
                      placeholder="you@qnsc.dev"
                    />
                  </div>

                  <button
                    type="submit"
                    disabled={devLoading}
                    className="flex w-full items-center justify-center gap-2 rounded bg-primary py-3 text-ui-lg font-medium text-white transition-colors disabled:opacity-60"
                  >
                    {devLoading ? t('signingIn') : t('signInButton')}
                  </button>
                </form>
              )}
            </div>
          </div>

          <p className="mt-5 text-center text-ui-xs text-foreground-subtle">
            {t('needAccess')}{' '}
            <a href="mailto:admin@minirallyapp.com" className="font-medium text-primary-light">
              {t('contactAdmin')}
            </a>
          </p>
        </div>
      </section>
    </main>
  )
}
