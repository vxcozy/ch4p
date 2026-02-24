# Security Policy

## Supported versions

| Version | Supported |
|---------|-----------|
| 0.1.x   | Yes       |

## Reporting a vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

Please use [GitHub's private vulnerability reporting](https://github.com/vxcozy/ch4p/security/advisories/new) to disclose security issues responsibly. This keeps the report confidential until a fix is available.

### What to include

- Description of the vulnerability
- Steps to reproduce
- Affected versions and components
- Impact assessment (if known)

### Response timeline

- **Acknowledgement** — within 48 hours
- **Initial assessment** — within 1 week
- **Fix or mitigation** — depends on severity, but we aim for patches within 30 days for critical issues

## Security architecture

ch4p ships with nine defense layers enabled by default:

1. Filesystem scoping with symlink escape detection
2. Command allowlist with shell metacharacter blocking
3. AES-256-GCM encrypted secrets with PBKDF2 key derivation
4. Output sanitization (25 regex patterns)
5. Input validation (prompt injection and data exfiltration detection)
6. Autonomy levels (readonly / supervised / full)
7. SSRF protection (private IP blocking, DNS checks, cloud metadata guards)
8. Secure file permissions (transcripts `0o600`, log dirs `0o700`)
9. Pairing token expiration (30-day TTL)

For full details, see:

- [Security Model](docs/explanation/security-model.md)
- [Security Reference](docs/reference/security.md)
- [Configure Security](docs/how-to/configure-security.md)
