-- Indexes for fast inbox and sent queries
create index if not exists emails_inbox_idx
  on emails (user_id, is_sent, received_at desc)
  where is_sent = false;

create index if not exists emails_sent_idx
  on emails (user_id, is_sent, received_at desc)
  where is_sent = true;

create index if not exists emails_thread_idx
  on emails (thread_id, received_at desc);
