# Contract change requests

Agents: do NOT edit `packages/shared` or `packages/db` directly. Add a request here and continue with a
local workaround. The owner applies approved changes on `main`; then rebase.

## Template
### [Lane X] Short title
- **Change:** what to add/modify (paste the exact type or Prisma field)
- **Why:** what breaks or is impossible without it
- **Workaround in use:** what you did meanwhile
- **Status:** open | applied | rejected

---

### [Lane C] Optional model env vars in `.env.example` / turbo `globalPassThroughEnv`
- **Change:** add these optional vars to `.env.example` and to `globalPassThroughEnv` in `turbo.json`:
  ```
  PLATFORM_MODEL=              # default claude-opus-5-5
  PLATFORM_EFFORT=             # low|medium|high|xhigh|max, default medium
  OPENAI_MODEL=                # platform fallback, default gpt-5
  CHATGPT_MODEL=               # codex_chatgpt, default gpt-5-codex
  ```
- **Why:** `@app/providers` reads them to override default models without a code change.
- **Workaround in use:** hard-coded defaults in `packages/providers` are used when the vars are unset.
- **Status:** open

### [Lane C] Pass the repo's model to providers
- **Change:** add `model?: string` to `ProviderContext` (or `ReviewChunkInput`) in `packages/shared/src/provider.ts`.
- **Why:** "Model from repo settings" otherwise needs a DB lookup inside the provider.
- **Workaround in use:** the `platform` provider looks up `repo.settings.model` via `@app/db` (`orgId` + `fullName`).
- **Status:** open
