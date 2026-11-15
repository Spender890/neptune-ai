## Summary of Changes
<!-- Describe what this PR changes and why. Link any related Issue (#123). -->

## Type of Change
- [ ] Bug fix (non-breaking)
- [ ] Security hardening
- [ ] New integration / FastPath intent
- [ ] Tests / CI / Tooling
- [ ] Documentation update

## Security & Reliability Check
- [ ] No real tokens, API keys, IPs, or SIP passwords committed.
- [ ] All Home Assistant service calls continue to enforce `PermissionsGateway.validate()`.
- [ ] Destructive/consequential actions (`lock`, `cover`, dialing) maintain confirmation or extension allowlist guards.
- [ ] New external HTTP clients use `performHttpRequest` with explicit timeouts.

## Verification Performed
> Check only what you actually ran locally. Clearly separate unit/mock checks from live hardware tests.

- [ ] `cd backend && npm run lint` passed
- [ ] `cd backend && npm run build && npm test` passed
- [ ] `python3 -m unittest discover -s tests -v` passed
- [ ] Live Docker Compose / physical hardware tested (specify which components below):
  - Hardware tested: *(none / list HA, LG TV, SIP phone, etc.)*
