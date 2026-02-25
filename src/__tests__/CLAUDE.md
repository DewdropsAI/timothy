# Tests — CLAUDE.md

## Running

```bash
npm test                   # Run all tests once
npx vitest                 # Watch mode
npx vitest run session     # Run tests matching "session"
```

Requires `--experimental-vm-modules` (already configured in `package.json` script).

## Patterns

- **Real filesystem I/O** — tests write to `os.tmpdir()`, no mocking. Cleaned up in `afterAll`.
- **Dependency injection** — modules expose `_setSessionsDir()`, `_setMemoryDir()` etc. to redirect I/O to temp dirs. Always call these in `beforeAll`.
- **ESM** — project uses `"type": "module"`. Use `import`, not `require`. Vitest handles this natively with the `--experimental-vm-modules` flag.
- **No snapshot tests** — tests assert on behavior and file contents directly.

## Adding a New Test

1. Create `src/__tests__/<module>.test.ts`
2. Use `mkdtemp(join(tmpdir(), 'timothy-test-'))` for isolation
3. Inject the temp dir via the module's `_set*Dir()` helper
4. Clean up in `afterAll` with `rm(dir, { recursive: true })`
