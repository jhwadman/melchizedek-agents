# Security policy

## Reporting a vulnerability

Please report security issues **privately**, through GitHub's private
vulnerability reporting: open the repository's **Security** tab and choose
**Report a vulnerability**. Do not open a public issue for a vulnerability.

Include what you found, how to reproduce it, the version (`npm ls
melchizedek-agents` or the commit), and the impact you expect. You will get an
acknowledgement within 5 working days and a status update at least every 14
days until the issue is resolved. Fixed issues are disclosed in the CHANGELOG
and a GitHub security advisory once a release is available.

## Supported versions

The project is pre-1.0. Security fixes land on the latest minor release only;
upgrade to it to receive them.

## Scope

In scope: the package's own code — the A2A server (`melchizedek-serve`,
`createA2AApp`), the runtime, the tool contracts and built-in tools (notably
`web_extract`'s and the MCP and A2A clients' SSRF guard), the session and
memory services, and the SQL in `db/`.

Out of scope: vulnerabilities in model providers, in Supabase, or in
dependencies (report those upstream; we track advisories through Dependabot
and `npm audit`), and prompt-injection behaviour of a model that does not
cross a boundary the framework claims to enforce.

## Hardening a deployment

The security notes in DOCUMENTATION.md cover the deployment-side controls:
the bearer secret (`A2A_SERVER_SECRET`), `db/hardening.sql`, the served-agent
allowlist (`A2A_SERVED_AGENTS`), rate and step limits, and what is logged.
