-- Add HTML body and attachment metadata to emails table
alter table emails
  add column if not exists body_html text not null default '',
  add column if not exists attachments jsonb not null default '[]';
