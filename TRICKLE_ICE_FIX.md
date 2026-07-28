# Trickle ICE fix

This patch replaces the previous wait-for-complete ICE exchange with standard Trickle ICE.

## Required deployment steps

1. Copy the changed files into the repository.
2. Run `supabase/migrations/004_trickle_ice.sql` in Supabase SQL Editor.
3. Commit and deploy all changed files together.
4. Hard-refresh both devices or open a new room so no stale SDP signals remain.

## Changed files

- `hooks/use-p2p-stream.ts`
- `lib/webrtc-core.ts`
- `lib/webrtc-signaling.ts`
- `lib/sync-types.ts`
- `tests/webrtc-core.test.ts`
- `supabase/migrations/004_trickle_ice.sql`

## Validation

- Node tests: 16/16 passed.
- `lib/webrtc-core.ts` strict TypeScript check passed with DOM libraries.
- `hooks/use-p2p-stream.ts` strict isolated TypeScript check passed with typed React/signaling stubs.
- Full Next.js build was not run in this environment because project dependencies are not installed here.
