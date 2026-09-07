import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'

import common from './locales/en/common.json'
import auth from './locales/en/auth.json'
import projects from './locales/en/projects.json'
import workItems from './locales/en/work-items.json'
import nav from './locales/en/nav.json'
import releases from './locales/en/releases.json'
import home from './locales/en/home.json'
import backlog from './locales/en/backlog.json'
import iterations from './locales/en/iterations.json'
import iterationStatus from './locales/en/iteration-status.json'
import quality from './locales/en/quality.json'
import portfolio from './locales/en/portfolio.json'
import capacity from './locales/en/capacity.json'
import reports from './locales/en/reports.json'
import releaseTracking from './locales/en/release-tracking.json'
import milestones from './locales/en/milestones.json'
import settings from './locales/en/settings.json'
import notifications from './locales/en/notifications.json'
import errors from './locales/en/errors.json'
import testCases from './locales/en/test-cases.json'

export const defaultNS = 'common'

i18n.use(initReactI18next).init({
  lng: 'en',
  fallbackLng: 'en',
  defaultNS,
  resources: {
    en: {
      common,
      auth,
      projects,
      'work-items': workItems,
      nav,
      releases,
      home,
      backlog,
      iterations,
      'iteration-status': iterationStatus,
      quality,
      portfolio,
      capacity,
      reports,
      'release-tracking': releaseTracking,
      milestones,
      settings,
      notifications,
      errors,
      'test-cases': testCases,
    },
  },
  interpolation: { escapeValue: false },
})

export default i18n
