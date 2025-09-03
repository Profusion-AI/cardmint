const { danger, fail, warn, message } = require('danger')
const isTSorJS = (f) => f.match(/\.(ts|tsx|js|jsx)$/)
const changed = [...(danger.git.created_files || []), ...(danger.git.modified_files || [])]
const title = danger.github.pr.title || ''
if (!/^(feat|fix|chore|docs|refactor|test|build|perf|ci)\([^)]+\):\s.+/.test(title)) {
  warn('PR title should follow conventional commits, e.g., `feat(api): add OCR endpoint`.')
}
const forbiddenPaths = changed.filter((f) => f.startsWith('dist/') || f.match(/^\.env(\..*)?$/) || f.includes('secrets'))
if (forbiddenPaths.length) {
  fail(`Forbidden files in PR: ${forbiddenPaths.join(', ')}`)
}
const todoFiles = []
const checkTodos = async () => {
  for (const f of changed.filter(isTSorJS)) {
    const content = await danger.github.utils.fileContents(f)
    if (/\/\/\s*TODO/.test(content)) todoFiles.push(f)
  }
}
const archViolations = []
const checkArchitecture = async () => {
  for (const f of changed.filter((p) => p.startsWith('src/') && isTSorJS(p))) {
    const content = await danger.github.utils.fileContents(f)
    if (/from\s+['"](?:\.{1,2}\/)*legacy\//.test(content)) archViolations.push(`${f}: imports from legacy/`)
    if (f.startsWith('src/core/')) {
      if (/from\s+['"](?:@\/)?adapters\//.test(content)) archViolations.push(`${f}: core -> adapters import`)
      if (/from\s+['"](?:@\/)?app\//.test(content)) archViolations.push(`${f}: core -> app import`)
    }
  }
}
const srcChanged = changed.filter((p) => p.startsWith('src/'))
const testsChanged = changed.some((p) => p.match(/(\.test\.ts|\.spec\.ts)$/) || p.startsWith('test/'))
;(async function main() {
  await checkTodos()
  await checkArchitecture()
  if (todoFiles.length) fail(`Remove TODO comments from: ${todoFiles.join(', ')}`)
  if (archViolations.length) fail(`Architecture violations:\n- ${archViolations.join('\n- ')}`)
  if (srcChanged.length && !testsChanged) warn('Source files changed without accompanying tests. Please add or justify.')
  if (!changed.length) message('No file changes detected.')
})()
