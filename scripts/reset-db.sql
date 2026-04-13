-- Reset: clears all rows without dropping tables
TRUNCATE TABLE read_receipts, scheduled_sends, emails, voice_profiles RESTART IDENTITY CASCADE;
