import { CloudOff, RefreshCw } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/shared/ui/button'

/**
 * The recovery screen for a session check that failed for a TRANSIENT reason.
 *
 * `/login` is wrong here: the session cookie may still be valid, so signing in again is a detour
 * that lands the user back in the same 429/5xx. A reload re-runs `bootstrapAuth`, which retries
 * with Retry-After backoff before it ever reaches this page again.
 */
export function AuthUnavailablePage() {
  const { t } = useTranslation('auth')

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 bg-background py-24">
      <div className="flex h-16 w-16 items-center justify-center rounded-full bg-primary-lighter">
        <CloudOff size={30} className="text-primary-light" />
      </div>
      <div className="max-w-md text-center">
        <p className="text-ui-xl font-medium text-foreground">{t('sessionUnavailable.title')}</p>
        <p className="mt-1 text-ui-md text-foreground-subtle">
          {t('sessionUnavailable.description')}
        </p>
      </div>
      <Button className="mt-2" onClick={() => window.location.reload()}>
        <RefreshCw size={14} />
        {t('sessionUnavailable.retry')}
      </Button>
    </div>
  )
}
