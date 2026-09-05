# Workspace implementation rules

- Follow the existing folder structure. Put feature behavior in its owning feature/module directory; shared components and providers are for shared concerns.
- Always inspect `.gitkeep` files before implementation and again before handoff. Run `bun run check:structure` and inspect the affected scope. A placeholder is an explicit reminder of unfinished structure, not proof of implemented functionality.
- Remove a `.gitkeep` only after its directory contains the real implementation. Do not delete empty folders or add filler files just to hide missing work.
- Keep repeatable tests in the existing test directories. Report remaining placeholders and missing behavior accurately; do not claim full parity from visual checks alone.
