-- Run this only if migration 002 reported that pg_cron was not enabled.
-- First enable Integrations > Cron in the Supabase Dashboard, then execute:

select cron.schedule(
  'watch-room-empty-cleanup',
  '*/5 * * * *',
  'select public.cleanup_empty_watch_rooms();'
);
