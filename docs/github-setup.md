# GitHub Setup (Step-by-step)

Use this checklist to make GitHub work for you without surprises.

## 1) Branch Protection (main)
- Settings → Branches → Add rule
  - Branch name pattern: `main`
  - Require a pull request before merging (1 approval)
  - Require status checks to pass
    - Select checks from CI: lint, typecheck, build, test
  - Require review from Code Owners (after you set CODEOWNERS)
  - Require linear history or enforce squash merges
  - Do not allow bypassing PRs; block force pushes

## 2) CODEOWNERS
- Edit `.github/CODEOWNERS` and set your GitHub handle(s)
- Tip: assign areas to future collaborators (e.g., `src/ml/ @you`)

## 3) Labels and Milestones
- Create labels: `type:feature`, `type:bug`, `priority:p0/p1/p2`, `area:camera/ml/api/ui`
- Use milestones for weekly goals (e.g., `v0.1.0`) and close it on release

## 4) Secrets and Environments
- Settings → Secrets and variables → Actions
  - Add repo secrets used by CI (if any)
- Settings → Environments → `staging`, `production`
  - Add environment secrets (e.g., `SSH_HOST`, `SSH_USER`, `SSH_KEY`, `DEPLOY_PATH`)
  - Require reviewers for `production` deployments

## 5) Dependabot & Scanning (optional but recommended)
- Settings → Code security and analysis → enable Dependency and Secret scanning
- Add `.github/dependabot.yml` (I can scaffold this when you’re ready)
- Enable CodeQL (JavaScript/TypeScript) weekly if you want deeper scans

## 6) PRs and Reviews
- Use the prefilled PR template (`.github/pull_request_template.md`)
- Keep PRs small and focused (<300 LOC change)
- Stop-the-line if CI is red; fix then re-run

## 7) Releases
- Tag `v0.1.0` when you’re ready
- Draft release notes from merged PR titles

