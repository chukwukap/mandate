# Directory structure audit — September 5, 2026

The web implementation now follows its feature directories and has zero `.gitkeep`
files. Forty redundant markers were removed where real implementation or documents
already occupied the directory. They were not removed from empty folders.

The following 42 non-web directories still contain `.gitkeep`. This is a structural
backlog, not proof that every corresponding runtime behavior is missing: some API,
worker and shared-package code is still grouped outside its planned subdirectories.
Infrastructure, compatibility migration and wider test coverage also have placeholders.
Those areas were not reorganized as part of the web/onboarding change.

Run `bun run check:structure` to refresh this list. Follow the existing structure
when working on these areas; do not delete placeholders just to make the audit pass.

```text
.github/workflows/.gitkeep
apps/api/src/modules/auth/.gitkeep
apps/api/src/modules/executions/.gitkeep
apps/api/src/modules/health/.gitkeep
apps/api/src/modules/instances/.gitkeep
apps/api/src/modules/market/.gitkeep
apps/api/src/modules/permissions/.gitkeep
apps/api/src/plugins/.gitkeep
apps/worker/src/jobs/.gitkeep
apps/worker/src/recovery/.gitkeep
apps/worker/src/scheduler/.gitkeep
infra/docker/.gitkeep
infra/monitoring/.gitkeep
infra/postgres/.gitkeep
packages/auth/src/sessions/.gitkeep
packages/auth/src/signatures/.gitkeep
packages/config/test/.gitkeep
packages/contracts/src/schemas/.gitkeep
packages/contracts/src/types/.gitkeep
packages/contracts/test/.gitkeep
packages/database/src/transactions/.gitkeep
packages/evm/src/abis/.gitkeep
packages/evm/src/feeds/.gitkeep
packages/evm/src/venues/.gitkeep
packages/execution/src/admission/.gitkeep
packages/execution/src/keys/.gitkeep
packages/execution/src/reconciliation/.gitkeep
packages/execution/src/submission/.gitkeep
packages/observability/test/.gitkeep
packages/strategy/src/enforcement/.gitkeep
packages/strategy/src/evaluation/.gitkeep
packages/strategy/src/machines/.gitkeep
packages/strategy/src/review/.gitkeep
packages/strategy/src/validation/.gitkeep
scripts/migration/.gitkeep
tests/contract/.gitkeep
tests/e2e/.gitkeep
tests/fixtures/chain/.gitkeep
tests/fixtures/strategies/.gitkeep
tests/integration/api/.gitkeep
tests/integration/database/.gitkeep
tests/integration/execution/.gitkeep
```
