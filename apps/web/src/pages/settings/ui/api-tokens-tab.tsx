/**
 * Settings ▸ Personal ▸ API Tokens.
 *
 * The surface for the credentials a machine uses on your behalf: an integration, a CI job, a script,
 * or agent-forge driving Rova through the API. Personal rather than workspace, because a token
 * carries its owner's permissions and never more — the backend intersects the requested scopes with
 * whatever the owner holds, so "my tokens" is the honest unit.
 *
 * Three things this screen has to get right, and they are the reason it is not a generic list:
 *
 *  1. **The credential is shown once.** Minting is the only moment it exists in readable form. The
 *     create flow therefore ends in a panel the user must dismiss deliberately, and nothing in this
 *     list implies a token can be retrieved later — there is no "view" action anywhere.
 *  2. **Expiry is visible before it bites.** Every token has one (90 days by default, 365 at most),
 *     and a token that dies at 03:00 on a Sunday is an incident. `Expiring` is its own state inside
 *     a fortnight, so it can be renewed while somebody is awake.
 *  3. **Revoked tokens stay listed.** `revokedAt` exists for the audit trail; a row that vanishes
 *     takes the trail with it, and "was there ever a token for that leaked script?" is exactly the
 *     question a security review asks.
 *
 * Failure and emptiness are separate branches (`ListResource`): "you have no tokens" is a
 * measurement, and a 500 rendering as that sentence would invite someone to mint a second token they
 * already have.
 */
import { useTranslation } from 'react-i18next'
import { KeyRound, Plus, Trash2 } from 'lucide-react'

import { useMyApiTokens, useRevokeApiToken, type ApiToken } from '@/features/api-tokens/api'
import { TOKEN_STATE_STYLE } from '@/features/api-tokens/status-colors'
import { daysUntilExpiry, isRevocable, tokenState } from '@/features/api-tokens/token-state'
import { listResource } from '@/shared/lib/query/resource'
import { notify } from '@/shared/lib/toast'
import { formatDateIso, relativeTime } from '@/shared/lib/utils'
import { Button } from '@/shared/ui/button'
import { Card, CardBody, CardHeader } from '@/shared/ui/card'
import { ConfirmDialog } from '@/shared/ui/confirm-dialog'
import { EmptyState } from '@/shared/ui/empty-state'
import { IconButton } from '@/shared/ui/icon-button'
import { LoadErrorState } from '@/shared/ui/load-error-state'
import { StatusBadge } from '@/shared/ui/status-badge'
import { useDisclosure } from '@/shared/lib/hooks/use-disclosure'
import { CreateTokenModal } from './api-tokens/create-token-modal'
import { SettingsTabHeader } from './settings-tab-header'

export function ApiTokensTab() {
  const { t } = useTranslation('settings')
  const tokens = listResource(useMyApiTokens())
  const revoke = useRevokeApiToken()
  const create = useDisclosure()
  const confirm = useDisclosure<ApiToken>()

  async function onRevoke(token: ApiToken) {
    try {
      await revoke.mutateAsync(token.id)
      notify.success(t('apiTokens.revoked', { name: token.name }))
    } catch (error) {
      notify.error(error instanceof Error ? error.message : t('apiTokens.revokeFailed'))
    } finally {
      confirm.close()
    }
  }

  return (
    <>
      <SettingsTabHeader
        contained
        title={t('nav.apiTokens')}
        description={t('tabDescriptions.apiTokens')}
      />
      <div className="flex-1 overflow-y-auto px-8 py-6">
        <div className="mx-auto max-w-3xl space-y-6">
          <Card>
            <CardHeader
              title={t('apiTokens.list.title')}
              actions={
                <Button size="sm" type="button" onClick={() => create.open()}>
                  <Plus size={14} />
                  {t('apiTokens.list.new')}
                </Button>
              }
            />
            <CardBody className="p-0">
              {tokens.phase === 'loading' ? (
                <p className="px-4 py-6 text-ui-sm text-foreground-subtle">
                  {t('apiTokens.list.loading')}
                </p>
              ) : tokens.phase === 'error' ? (
                <LoadErrorState
                  error={tokens.error}
                  title={t('apiTokens.list.loadError')}
                  size="sm"
                />
              ) : tokens.phase === 'empty' ? (
                <div className="px-4 py-8">
                  <EmptyState
                    icon={<KeyRound size={22} className="text-border-strong" />}
                    title={t('apiTokens.list.empty.title')}
                    description={t('apiTokens.list.empty.description')}
                  />
                </div>
              ) : (
                <table className="w-full border-collapse text-ui-sm">
                  <thead className="bg-surface-subtle">
                    <tr className="text-left text-ui-xs text-foreground-subtle">
                      <th className="px-3 py-2 font-semibold">{t('apiTokens.col.name')}</th>
                      <th className="px-3 py-2 font-semibold">{t('apiTokens.col.status')}</th>
                      <th className="px-3 py-2 font-semibold">{t('apiTokens.col.lastUsed')}</th>
                      <th className="px-3 py-2" />
                    </tr>
                  </thead>
                  <tbody>
                    {tokens.rows.map((token) => (
                      <TokenRow
                        key={token.id}
                        token={token}
                        pendingId={revoke.isPending ? revoke.variables : undefined}
                        onRevoke={() => confirm.open(token)}
                      />
                    ))}
                  </tbody>
                </table>
              )}
            </CardBody>
          </Card>

          <p className="text-ui-sm text-foreground-subtle">{t('apiTokens.footnote')}</p>
        </div>
      </div>

      <CreateTokenModal open={create.isOpen} onClose={create.close} />

      <ConfirmDialog
        open={confirm.isOpen}
        title={t('apiTokens.revokeTitle', { name: confirm.data?.name ?? '' })}
        message={t('apiTokens.revokeMessage')}
        confirmLabel={t('apiTokens.revokeConfirm')}
        destructive
        pending={revoke.isPending}
        onConfirm={() => confirm.data && void onRevoke(confirm.data)}
        onCancel={confirm.close}
      />
    </>
  )
}

/**
 * One token. Its own component because the state derivation and the three date readings are the
 * substance of the row, and a page-level `.map` with all of it inline is where a table stops being
 * reviewable.
 */
function TokenRow({
  token,
  pendingId,
  onRevoke,
}: {
  token: ApiToken
  pendingId: string | undefined
  onRevoke: () => void
}) {
  const { t } = useTranslation('settings')
  const state = tokenState(token)
  const days = daysUntilExpiry(token)

  return (
    <tr className="border-t border-border-inner">
      <td className="px-3 py-2">
        <span className="block text-ui-md text-foreground" title={token.name}>
          {token.name}
        </span>
        {/* The prefix is how a token is identified in a log line, so it is the row's second
            identity rather than a detail hidden behind a hover. */}
        <span className="font-mono text-ui-xs text-foreground-subtle">{token.prefix}…</span>
      </td>
      <td className="px-3 py-2">
        <div className="flex flex-col gap-0.5">
          <StatusBadge style={TOKEN_STATE_STYLE[state]} className="w-fit" />
          <span className="text-ui-xs text-foreground-subtle">
            {state === 'revoked'
              ? t('apiTokens.revokedAt', { date: formatDateIso(token.revokedAt ?? '') })
              : state === 'expired'
                ? t('apiTokens.expiredAt', { date: formatDateIso(token.expiresAt) })
                : t('apiTokens.expiresIn', { count: days })}
          </span>
        </div>
      </td>
      <td className="px-3 py-2 text-foreground-subtle">
        {/* Never-used is worth saying plainly: it is the strongest signal that a token can be
            revoked without breaking anything. */}
        {token.lastUsedAt ? relativeTime(token.lastUsedAt) : t('apiTokens.neverUsed')}
      </td>
      <td className="px-3 py-2 text-right whitespace-nowrap">
        {isRevocable(token) && (
          <IconButton
            size="sm"
            variant="destructive"
            aria-label={t('apiTokens.revokeAria', { name: token.name })}
            title={t('apiTokens.revokeConfirm')}
            disabled={pendingId === token.id}
            onClick={onRevoke}
          >
            <Trash2 size={14} />
          </IconButton>
        )}
      </td>
    </tr>
  )
}
