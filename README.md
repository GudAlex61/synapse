# Watch Together

A two-person synchronized video room built with Next.js and Supabase Realtime, Postgres and Storage.

## Required Supabase setup

1. Create or open a Supabase project.
2. Run `supabase/migrations/001_watch_rooms.sql` in the Supabase SQL Editor.
3. Copy `.env.example` to `.env.local` and fill in the project URL and anon/publishable key.
4. Install and run:

```bash
pnpm install
pnpm dev
```

The migration creates:

- persistent room playback state;
- the latest 500 chat messages per room;
- restricted RPC functions used by the browser;
- a public `room-videos` Storage bucket with a 5 GB bucket limit;
- Storage policies for resumable room video uploads and cleanup.

Your Supabase project or plan can impose a lower per-file limit than the bucket setting. Uploaded files use random object names. Room codes act as the access secret; for a public production service, add authentication and stricter ownership policies.

## Verification commands

```bash
pnpm test
pnpm lint
pnpm build
```

## Persistence behavior

- Chat and playback state are saved in Supabase and mirrored in localStorage as an offline fallback.
- A refreshed client restores the source, playback position, play/pause state and chat history.
- Local files play immediately for the uploader, then upload to Supabase Storage using resumable 6 MB TUS chunks. The partner automatically switches to the shared Storage URL when upload finishes.
- The previous uploaded room video is removed after a replacement upload succeeds.
