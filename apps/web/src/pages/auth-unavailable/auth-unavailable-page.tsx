import { useState } from 'react'
import { CloudOff, RefreshCw } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { retrySession } from './retry'
import { Button } from '@/shared/ui/button'

export function AuthUnavailablePage() {
  const { t } = useTranslation('auth')
  const [retrying, setRetrying] = useState(false)

  const retry = async () => {
    setRetrying(true)
    try {
      // A full navigation drops every in-memory query of the failed attempt; bootstrap has
      // already proved the session works, so the next load starts clean.
      const restored = await retrySession(window.location.search, (target) =>
        window.location.assign(target),
      )
      if (restored) return
    } catch {
      // Treated exactly like a failed retry: the screen stays and the button comes back.
    }
    setRetrying(false)
  }

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
      <Button className="mt-2" onClick={() => void retry()} disabled={retrying}>
        <RefreshCw size={14} />
        {t('sessionUnavailable.retry')}
      </Button>
    </div>
  )
}
