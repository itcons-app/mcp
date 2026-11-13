# Changelog

## 0.9.1 - 2026-11-09

- Advertise the reports-only ChatGPT endpoint in generic OAuth protected-resource discovery.
- Preserve path-specific OAuth metadata for both the general and reports-only MCP endpoints.
- Allow authorization form redirects to the registered ChatGPT and Claude callback origins.
- Accept general-resource tokens on the reports-only endpoint for cached ChatGPT OAuth connections, without granting reports tokens access to the general MCP.
- Advertise path-specific protected-resource metadata from unauthenticated requests to the general MCP endpoint.

## 0.9.0 - 2026-11-09

- Expand the reports-only ChatGPT profile with read-only calendar, holiday, working-day, leave-type, project and work-order queries.
- Cap public-profile project and work-order lists at 50 items.
- Remove notes, user identities, locations, attachments, client details and other unnecessary private fields from public-profile project and work-order results.
- Limit calendar calculations to valid inclusive date ranges of at most 366 days.
- Add official API v3 project and work-order filters.
- Extend automated tests for tool discovery, OAuth metadata, data minimization, holidays and working-day calculations.
- Move email-to-domain discovery from `auto.itcons.app` to `autov2.itcons.app` for both remote MCP profiles.

## 0.8.1 - 2026-11-04

- Persist encrypted OAuth sessions across service restarts.
- Hash OAuth tokens and dynamic-client secrets at rest.
- Add refresh rotation, exact resource binding, PKCE, issuer identification, revocation, rate limits and security headers.
- Keep the public ChatGPT profile restricted to five read-only work-report tools.
