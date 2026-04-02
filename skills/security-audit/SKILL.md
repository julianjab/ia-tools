---
name: security-audit
description: Scan the codebase for common security vulnerabilities and hardcoded secrets
allowed-tools: Bash, Read, Grep, Glob
---

Run a security audit on the current project:

1. **Hardcoded secrets**: Search for patterns that look like API keys, passwords, tokens, or credentials
   ```bash
   grep -rn --include="*.py" --include="*.ts" --include="*.js" --include="*.vue" --include="*.env*" -iE "(password|secret|api_key|token|credential|auth).*=.*['\"]" . || true
   ```

2. **Exposed .env files**: Check if .env files are tracked by git
   ```bash
   git ls-files | grep -i "\.env" || echo "No .env files tracked (good)"
   ```

3. **SQL injection**: Search for string concatenation in SQL queries
   ```bash
   grep -rn --include="*.py" -E "(execute|raw|text)\(.*\+|f['\"].*SELECT|f['\"].*INSERT|f['\"].*UPDATE|f['\"].*DELETE" . || echo "No obvious SQL injection patterns found"
   ```

4. **Missing input validation**: Check API endpoints for missing validation
5. **Dependency vulnerabilities**: Run `pnpm audit` or `pip audit` if available

6. **Report findings** with severity (critical/warning/info) and file locations
