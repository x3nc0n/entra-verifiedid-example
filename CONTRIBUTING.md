# Contributing to Entra Verified ID Onboarding Portal

Thank you for your interest in contributing! This project welcomes bug reports, documentation improvements, and code contributions.

---

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Getting Started (Development Setup)](#getting-started-development-setup)
- [Project Structure](#project-structure)
- [Code Style](#code-style)
- [Making Changes](#making-changes)
- [Pull Request Process](#pull-request-process)
- [Reporting Bugs](#reporting-bugs)
- [Security Vulnerabilities](#security-vulnerabilities)

---

## Code of Conduct

This project follows the [Contributor Covenant Code of Conduct](https://www.contributor-covenant.org/version/2/1/code_of_conduct/). By participating, you agree to uphold this standard. Unacceptable behavior can be reported to the maintainer via GitHub.

---

## Getting Started (Development Setup)

### 1. Fork and clone

```bash
git clone https://github.com/<your-username>/entra-verifiedid-example.git
cd entra-verifiedid-example
```

### 2. Install dependencies

```bash
npm install
```

### 3. Set up your environment

```bash
cp .env.example .env
```

For a quick local loop without a real Entra Verified ID tenant, enable demo mode:

```bash
# .env
DEMO_MODE=true
SESSION_SECRET=local-dev-secret-change-me-32chars
WEBAUTHN_RP_ID=localhost
WEBAUTHN_ORIGIN=http://localhost:3000
PORT=3000
```

### 4. Run the development server

```bash
npm run dev     # nodemon with hot reload
# or
npm start       # plain Node.js
```

The portal is available at `http://localhost:3000`.

### 5. (Optional) Full Entra Verified ID setup

To test real credential issuance and presentation, complete the tenant bootstrap:

```powershell
Connect-AzAccount
Connect-MgGraph -Scopes "Application.ReadWrite.All", "Directory.ReadWrite.All"
.\scripts\bootstrap.ps1 -TenantId "<your-tenant-id>" -SubscriptionId "<your-sub-id>" -DemoMode $false
```

Then update `.env` with the values output by the script.

---

## Project Structure

```
entra-verifiedid-example/
├── infra/                  # Bicep/ARM infrastructure templates
│   └── modules/            # Reusable Bicep modules
├── scripts/                # PowerShell bootstrap and setup scripts
├── src/
│   ├── middleware/         # Express middleware (auth, error handling, etc.)
│   ├── public/             # Static assets (CSS, JS, images)
│   │   ├── css/
│   │   ├── js/
│   │   └── images/
│   ├── routes/             # Express route handlers
│   ├── services/           # Business logic and external API clients
│   └── views/              # EJS templates
│       └── partials/       # Shared template partials
├── docs/                   # Architecture and reference documentation
├── .github/
│   └── workflows/          # GitHub Actions (lint, test, etc.)
├── .env.example            # Environment variable template
├── README.md
├── CONTRIBUTING.md
├── SECURITY.md
└── LICENSE
```

---

## Code Style

This project uses the following conventions. Please follow them in your contributions.

### JavaScript / Node.js

- **ES Modules** where supported; CommonJS (`require`) for Express and existing patterns
- `const` / `let` — no `var`
- 2-space indentation
- Single quotes for strings
- Trailing commas in multi-line arrays/objects
- Async/await preferred over raw promise chains
- Error handling: always `try/catch` around `await` calls; propagate errors to Express error middleware with `next(err)`

### EJS Templates

- 2-space indentation
- Partials for any repeated UI elements (header, footer, nav)
- No inline styles — use CSS classes

### PowerShell

- Follow [PSScriptAnalyzer](https://github.com/PowerShell/PSScriptAnalyzer) conventions
- `PascalCase` for functions; `camelCase` for local variables; `$PascalCase` for parameters
- Use `Write-Verbose` for debug output; `Write-Host` only for user-facing progress
- Always include `[CmdletBinding()]` on script-level functions
- Require confirmation (`-Confirm` / `ShouldProcess`) on destructive operations

### Bicep

- Follow [Azure Bicep best practices](https://learn.microsoft.com/en-us/azure/azure-resource-manager/bicep/best-practices)
- Use `camelCase` for parameter and variable names
- Extract reusable resources into `infra/modules/`
- Add `@description()` decorators to all parameters

### Commits

- [Conventional Commits](https://www.conventionalcommits.org/) format preferred:
  ```
  feat: add YubiKey attestation verification
  fix: correct callback API key validation
  docs: expand troubleshooting section
  refactor: extract verified-id service client
  ```
- Keep commits focused; one logical change per commit
- Reference issues in commit messages when relevant: `fix: resolve QR code expiry (#42)`

---

## Making Changes

1. **Open or find an issue** before starting significant work. This avoids duplicate effort.

2. **Create a branch** from `main`:
   ```bash
   git checkout -b feat/your-feature-name
   # or
   git checkout -b fix/issue-42-short-description
   ```

3. **Write your changes.** Keep PRs focused — smaller PRs are reviewed faster.

4. **Test your changes:**
   ```bash
   # Run tests (if present)
   npm test

   # Run linter
   npm run lint

   # Manual smoke test in demo mode
   DEMO_MODE=true npm start
   ```

5. **Update documentation** if your change affects setup, configuration, or behavior documented in `README.md` or `docs/`.

6. **Commit and push:**
   ```bash
   git push origin feat/your-feature-name
   ```

---

## Pull Request Process

1. **Open a PR** targeting the `main` branch.

2. **Fill out the PR template** (if present). At minimum, include:
   - What problem does this solve?
   - How was it tested?
   - Any relevant issue numbers (`Closes #42`)

3. **Ensure checks pass** — the GitHub Actions CI workflow must be green.

4. **Address review feedback** — the maintainer may request changes. Please respond or push updates within 2 weeks to keep the PR active.

5. **Squash merge** is preferred for feature branches to keep the commit history clean.

### What Makes a Good PR

- ✅ Solves one well-defined problem
- ✅ Includes tests or clear manual test instructions
- ✅ Doesn't break existing demo flows in `DEMO_MODE=true`
- ✅ Documentation updated if behavior changed
- ✅ No hardcoded secrets or credentials (ever)
- ✅ `npm audit` clean (no new high/critical vulnerabilities)

---

## Reporting Bugs

Open a [GitHub Issue](https://github.com/x3nc0n/entra-verifiedid-example/issues/new) with:

- **Environment:** OS, Node.js version, `DEMO_MODE` setting, deployment context (local / App Service)
- **Steps to reproduce:** Exact steps to reproduce the bug
- **Expected behavior:** What you expected to happen
- **Actual behavior:** What actually happened
- **Logs:** Relevant console output or App Service logs

---

## Security Vulnerabilities

**Do not open a public GitHub issue for security vulnerabilities.** See [SECURITY.md](SECURITY.md) for the responsible disclosure process.
