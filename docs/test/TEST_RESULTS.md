# Test Report — 2026-06-02

## Summary

| Layer | Framework | Tests | Passed | Rate |
|-------|-----------|-------|--------|------|
| Backend | Jest + Supertest + PG15 | 56 | 52 | 93% |
| Frontend | Vitest + Testing Library | 37 | 37 | 100% |
| **Total** | | **93** | **89** | **96%** |

## Remaining Failures (Backend: 4)

| ID | Issue | Severity |
|----|-------|----------|
| IT-SV-06 | Duplicate vote returns 404 instead of 409 | Medium |
| IT-SV-07 | Rate limit state bleeds across test cases | Low (test infra) |
| IT-SV-08 | Non-UUID option_id causes PG error → 500 | Medium |
| IT-RL-02 | Rate limiter window edge case | Low (test infra) |

## Key Decisions
- Real PG 15 only — no mock databases
- Real Redis on localhost:6380
- Test isolation via table cleanup + rate key reset
- Dev tokens use URL-encoded Chinese characters + underscore-free IDs

## CI Status
- ✅ Pipeline updated with PG/Redis services
- ✅ Test reports uploaded as artifacts
- ✅ Test failure blocks image build
