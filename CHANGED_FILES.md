# Changed files

## Replace these existing files

- `app/room/[id]/page.tsx` — keeps old invite-link compatibility while using the revised room gate.
- `components/home-form.tsx` — safer room/name validation and cleaner room navigation.
- `components/room-gate.tsx` — normalized saved display names and improved entry behavior.
- `components/source-controls.tsx` — upload progress, disabled states and upload cancellation.
- `components/video-player.tsx` — safer source cleanup, HLS recovery, autoplay handling and bounded seeking.
- `components/watch-room.tsx` — persistent state/chat, upload/share flow, restore logic, drift fixes, cleanup and error handling.
- `hooks/use-room-channel.ts` — per-tab presence ID, payload validation, reconnect queue, ordered flush and stable return values.
- `lib/room.ts` — strict room codes, display-name normalization, URL validation and session-scoped client IDs.
- `lib/supabase/client.ts` — explicit environment validation and shared client usage.
- `lib/sync-types.ts` — extended source/state protocol types.
- `next.config.mjs` — build errors are no longer silently ignored.
- `package.json` — test/typecheck scripts.
- `tsconfig.json` — supports TypeScript test imports while keeping strict no-emit checking.

## Add these new files

- `.env.example`
- `README.md`
- `CHANGED_FILES.md`
- `TEST_REPORT.md`
- `lib/room-snapshot.ts`
- `lib/room-store.ts`
- `lib/storage-upload.ts`
- `lib/tus-upload.ts`
- `supabase/migrations/001_watch_rooms.sql`
- `tests/room.test.ts`
- `tests/room-snapshot.test.ts`
- `tests/tus-upload.test.ts`

## Required deployment step

Run `supabase/migrations/001_watch_rooms.sql` in the Supabase SQL Editor before deploying the revised frontend. Then verify that the production environment contains `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY`.
