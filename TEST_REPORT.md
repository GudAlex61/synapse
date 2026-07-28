# Test report

## Passed

- 9 Node automated tests:
  - 2,000 generated room codes validated;
  - strict room-code, name and video-URL validation;
  - malformed snapshot handling;
  - chat deduplication and ordering;
  - newest-state snapshot merging;
  - 6 MB TUS chunk boundaries and progress;
  - resumable upload recovery after a lost PATCH response.
- Strict TypeScript static check of all project TypeScript/TSX sources using local declaration stubs because dependency installation was unavailable in the review environment.
- Additional no-unused-locals and no-unused-parameters check.
- Manual code-path review for:
  - refresh restoration;
  - partner source replacement;
  - upload cancellation/failure/resume;
  - object URL cleanup;
  - source-change races before metadata loads;
  - play/pause/seek/buffer synchronization;
  - presence overflow and reconnect event ordering;
  - malformed realtime payloads;
  - Supabase RPC and Storage policy boundaries.

## Commands run

```bash
npm test
# 9 passed, 0 failed

tsc -p <temporary-review-tsconfig> --noEmit
# passed

tsc -p <temporary-review-tsconfig> --noEmit --noUnusedLocals --noUnusedParameters
# passed
```

## Environment limitation

A real `next build` and live two-browser Supabase test could not be executed in the review container because the uploaded archive did not contain `node_modules`, package-registry access timed out, and no Supabase project URL/key was supplied. The included migration must be applied to the target Supabase project; after dependencies are installed, run:

```bash
pnpm test
pnpm lint
pnpm build
```

Then perform one production smoke test with two separate browsers or incognito profiles using the actual Supabase project.
