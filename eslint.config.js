import js from '@eslint/js'
import globals from 'globals'

export default [
  { ignores: ['node_modules/', 'data/', 'viasocket-integrations/'] },
  js.configs.recommended,
  { files: ['server/**/*.js', 'test/**/*.js', 'scripts/**/*.js', 'scripts/**/*.mjs', 'eslint.config.js'], languageOptions: { globals: globals.node } },
  // Browser journeys: Node code that also runs functions inside the page.
  { files: ['scripts/e2e-*.mjs'], languageOptions: { globals: { ...globals.node, ...globals.browser } } },
  { files: ['public/**/*.js'], languageOptions: { globals: globals.browser } },
  { rules: { 'no-control-regex': 'off' } }
]
