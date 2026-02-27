# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.3.x   | Yes       |
| < 0.3.0 | No        |

## Security Model

mcp-doctor reads your Claude Code configuration (`~/.claude.json`) which contains MCP server definitions including environment variables (API keys, tokens). Here's how we protect them:

### Secret Redaction (v0.3.0+)

All output passes through `redactSecrets()` which:
1. **Known values**: Replaces any env var value (>6 chars) with `[REDACTED:KEY_NAME]`
2. **Pattern matching**: Catches common API key formats even if not in config:
   - Google/Gemini keys (`AIzaSy...`)
   - Anthropic keys (`sk-ant-api...`)
   - OpenAI keys (`sk-...`)
   - Resend keys (`re_...`)
   - GitHub tokens (`ghp_...`, `gho_...`)
   - npm tokens (`npm_...`)
   - xAI keys (`xai-...`)
   - JWTs (`eyJ...`)

### Safe Environment Inheritance

When spawning MCP server processes for health checks, only safe system variables are inherited (`PATH`, `HOME`, `SHELL`, etc.). Your `AWS_SECRET_ACCESS_KEY`, `GITHUB_TOKEN`, and similar sensitive env vars are **never** passed to spawned processes.

### What We Don't Do

- We never write secrets to disk
- We never send data to any remote server
- We never modify your configuration files
- We have zero runtime dependencies

## Reporting a Vulnerability

If you discover a security vulnerability, please report it responsibly:

1. **Email**: friemerx@gmail.com
2. **Subject**: `[mcp-doctor security]` followed by a brief description
3. **Do not** open a public GitHub issue for security vulnerabilities

I aim to respond within 48 hours and provide a fix within 7 days for confirmed vulnerabilities.
