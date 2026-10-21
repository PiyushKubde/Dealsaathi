import js from '@eslint/js'
import globals from 'globals'

export default [
  { ignores: ['node_modules/', 'data/', 'viasocket-integrations/'] },
  js.configs.recommended,
  { files: ['server/**/*.js', 'test/**/*.js', 'eslint.config.js'], languageOptions: { globals: globals.node } },
  { files: ['public/**/*.js'], languageOptions: { globals: globals.browser } },
  { rules: { 'no-control-regex': 'off' } }
]
