/**
 * Settings ▸ Integrations — source-control (GitHub) dashboard.
 *
 * Org-level model: connect the Rova GitHub App once and its repositories are
 * discovered automatically (from `installation`/`installation_repositories`
 * webhooks) and back-filled. PRs/commits link to work items by their workspace-
 * unique key (Rally FormattedID) — no per-project mapping. A manual owner/name
 * fallback + copyable webhook URLs remain for repos outside an installation.
 */
import { useTranslation } from 'react-i18next'
import { SettingsTabHeader } from './settings-tab-header'

import { useAppContext } from '@/shared/lib/stores/app-context.store'
import { ConnectedOrgs } from './integrations/connected-orgs'
import { RepositoryList } from './integrations/repository-list'
import { WebhookSetup } from './integrations/webhook-setup'
import { ManualAddForm } from './integrations/manual-add-form'

export function IntegrationsTab() {
  const { t } = useTranslation('settings')
  const { workspace } = useAppContext()
  const workspaceId = workspace?.workspaceId

  return (
    <>
      <SettingsTabHeader
        contained
        title={t('nav.integrations')}
        description={t('tabDescriptions.integrations')}
      />
      <div className="flex-1 overflow-y-auto px-8 py-6">
        <div className="mx-auto max-w-3xl space-y-6">
          <ConnectedOrgs workspaceId={workspaceId} />
          <RepositoryList workspaceId={workspaceId} />
          <WebhookSetup />
          <ManualAddForm workspaceId={workspaceId} />
        </div>
      </div>
    </>
  )
}
