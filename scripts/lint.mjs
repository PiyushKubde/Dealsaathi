// Syntax-checks every JavaScript file and fails if a secret-looking literal is committed in source.
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const roots = ['server', 'public', 'test', 'scripts']
const files = []
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) walk(path)
    else if (/\.(m?js)$/.test(name)) files.push(path)
  }
}
roots.forEach(walk)

let failed = 0
for (const file of files) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' })
  } catch (error) {
    failed += 1
    console.error(`SYNTAX ${file}\n${error.stderr}`)
  }
  const source = readFileSync(file, 'utf8')
  if (/VIASOCKET_EMBED_SECRET\s*[:=]\s*['"][^'"]{8,}/.test(source) && !file.startsWith('test')) {
    failed += 1
    console.error(`SECRET ${file}: a literal embed secret`)
  }
}
console.log(`${files.length} files checked, ${failed} problem(s)`)
process.exit(failed ? 1 : 0)
