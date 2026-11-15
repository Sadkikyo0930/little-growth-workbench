-- C0.1 040 ONLY; leaves every learning record, family progress row and
-- daily plan unchanged. Run separately after making a database snapshot.
BEGIN;
DROP FUNCTION IF EXISTS public.r5_auto_rollover_day(text);
COMMIT;
