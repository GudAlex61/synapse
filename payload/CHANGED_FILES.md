# Изменённые файлы P2P-версии

Список относительно предыдущей R2-версии проекта.

## Изменены

- `.env.example`
- `README.md`
- `CHANGED_FILES.md`
- `TEST_REPORT.md`
- `app/api/rooms/leave/route.ts`
- `components/source-controls.tsx`
- `components/video-player.tsx`
- `components/watch-room.tsx`
- `hooks/use-room-channel.ts`
- `lib/room-snapshot.ts`
- `lib/sync-types.ts`
- `tests/room-snapshot.test.ts`

## Добавлены

- `hooks/use-p2p-stream.ts`
- `lib/file-handle-store.ts`
- `lib/webrtc-core.ts`
- `lib/webrtc-signaling.ts`
- `supabase/migrations/003_p2p_streaming.sql`
- `tests/webrtc-core.test.ts`

## Удалены

- `app/api/videos/abort/route.ts`
- `app/api/videos/complete/route.ts`
- `app/api/videos/delete/route.ts`
- `app/api/videos/part/route.ts`
- `app/api/videos/playback/route.ts`
- `app/api/videos/start/route.ts`
- `cloudflare/R2_SETUP.md`
- `cloudflare/r2-cors.example.json`
- `lib/r2-s3.ts`
- `lib/r2-upload.ts`
- `tests/r2-s3.test.ts`
- `tests/r2-upload.test.ts`

Удаления обязательны: P2P-версия не должна содержать серверные R2 credentials или API загрузки файлов.
