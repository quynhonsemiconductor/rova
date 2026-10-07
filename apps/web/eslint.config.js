import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import boundaries from 'eslint-plugin-boundaries'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

// Feature-Sliced Design layers, highest → lowest.
// A layer may import only from layers below it (FRONTEND_STRUCTURE.md §4).
const FSD_LAYERS = ['app', 'pages', 'widgets', 'features', 'entities', 'shared']

// For each layer, the layers it may import from (itself + everything below).
const dependencyRules = FSD_LAYERS.map((layer, index) => ({
  from: [layer],
  allow: FSD_LAYERS.slice(index), // itself and all lower layers
}))

export default defineConfig([
  // `public/guide` is the BA's static User Guide (US-119), shipped as authored — not app code.
  globalIgnores(['dist', 'coverage', 'src/shared/api/generated/**', 'public/guide/**']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      globals: globals.browser,
    },
  },
  // ── Feature-Sliced Design boundary enforcement ──────────────────────────────
  {
    files: ['src/**/*.{ts,tsx}'],
    plugins: { boundaries },
    settings: {
      // Resolve the `@/` TS path alias so boundaries can classify aliased imports.
      'import/resolver': {
        typescript: { project: './tsconfig.app.json' },
      },
      'boundaries/include': ['src/**/*'],
      'boundaries/elements': FSD_LAYERS.map((layer) => ({
        type: layer,
        pattern: `src/${layer}/*`,
        mode: 'folder',
      })),
    },
    rules: {
      'boundaries/dependencies': [
        'error',
        {
          default: 'disallow',
          rules: dependencyRules,
        },
      ],
    },
  },
  // Entry files (main.tsx, App.tsx) sit above the layers — exempt them.
  {
    files: ['src/main.tsx', 'src/App.tsx'],
    rules: {
      'boundaries/dependencies': 'off',
    },
  },
  // shadcn/ui components co-export variant helpers (e.g. buttonVariants)
  // alongside the component — a deliberate convention, not a refresh hazard.
  {
    files: ['src/shared/ui/**/*.{ts,tsx}'],
    rules: {
      'react-refresh/only-export-components': 'off',
    },
  },
  // Grid pages must consume the shared DataTableFrame (via @/shared/ui/table),
  // never re-assemble grid chrome from the low-level DataTableHeader directly.
  // Keeps every grid's header/scroll/footer identical (audit §5.2 / §8.2).
  {
    files: ['src/pages/**/*.{ts,tsx}', 'src/widgets/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@/shared/ui/data-table-header',
              message:
                'Use DataTableFrame + DataTableHeaderColumn from @/shared/ui/table; do not assemble chrome from DataTableHeader directly.',
            },
          ],
        },
      ],
    },
  },
])
