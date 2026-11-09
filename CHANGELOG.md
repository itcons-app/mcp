# Changelog

## 0.9.0 - 2026-11-09

- Expand the reports-only ChatGPT profile with read-only calendar, holiday, working-day, leave-type, project and work-order queries.
- Cap public-profile project and work-order lists at 50 items.
- Remove notes, user identities, locations, attachments, client details and other unnecessary private fields from public-profile project and work-order results.
- Limit calendar calculations to valid inclusive date ranges of at most 366 days.
- Add official API v3 project and work-order filters.
- Extend automated tests for tool discovery, OAuth metadata, data minimization, holidays and working-day calculations.

## 0.8.1 - 2026-11-04

- Persist encrypted OAuth sessions across service restarts.
- Hash OAuth tokens and dynamic-client secrets at rest.
- Add refresh rotation, exact resource binding, PKCE, issuer identification, revocation, rate limits and security headers.
- Keep the public ChatGPT profile restricted to five read-only work-report tools.
