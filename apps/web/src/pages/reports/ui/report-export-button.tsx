/**
 * Export CSV (Phase 7 rulings R1/R4, plan D11 / Task 11.3).
 *
 * Rendered only for a reader holding `report:export` on the project (Workspace Admin, Project
 * Admin) — the server enforces the same code, this only avoids offering a control that would 403.
 * Rendered inside each report's own controls, because the export must carry that report's LIVE scope
 * (selected Iteration, window, Direction), which only the report holds.
 */
import { useState } from 'react'
import { Download } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { useProjectPermissions } from '@/features/access/api'
import { downloadReportCsv, type ReportExportRequest } from '@/features/reporting/api'
import { PERMISSION } from '@/shared/config/permissions'
import { notify } from '@/shared/lib/toast'
import { Button } from '@/shared/ui/button'

export function ReportExportButton({ request }: { request: ReportExportRequest | null }) {
  const { t } = useTranslation('carryover')
  const { can } = useProjectPermissions(request?.projectId)
  const [busy, setBusy] = useState(false)
  if (!request || !can(PERMISSION.REPORT_EXPORT)) return null

  async function exportCsv(req: ReportExportRequest) {
    setBusy(true)
    try {
      await downloadReportCsv(req)
    } catch (err) {
      notify.error(err instanceof Error ? err.message : t('export.error'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Button variant="outline" size="sm" disabled={busy} onClick={() => void exportCsv(request)}>
      <Download size={14} aria-hidden />
      {t('export.button')}
    </Button>
  )
}
