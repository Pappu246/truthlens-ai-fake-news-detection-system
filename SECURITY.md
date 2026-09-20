# Security Policy

## Supported versions

Security fixes are applied to the current `main` branch and the currently deployed application.

## Reporting a vulnerability

Please do not open a public issue for a security vulnerability.

Report suspected vulnerabilities privately to the repository maintainer through GitHub. Include:

- A clear description of the issue
- Steps to reproduce it
- The affected file, endpoint, or component
- Any relevant logs or screenshots
- The potential security impact

Do not include API keys, passwords, session tokens, personal data, or other secrets in a report.

## Secrets

Never commit credentials or API keys to the repository. Use environment variables such as `GEMINI_API_KEY` for local and deployed configuration.

## Scope

Security reports are especially useful for:

- SSRF or unsafe URL fetching
- Authentication or authorization bypasses
- Secret exposure
- Injection vulnerabilities
- Unsafe file or command execution
- Dependency vulnerabilities
- Data exposure through API endpoints
