create table if not exists model_configs (
  id text primary key,
  name text not null,
  provider text not null,
  capability text not null,
  settings jsonb not null default '{}'::jsonb,
  test_input text not null default '',
  test_result text not null default '',
  updated_at timestamptz not null default now()
);

create table if not exists workflow_configs (
  id text primary key,
  name text not null,
  description text not null default '',
  nodes jsonb not null default '[]'::jsonb,
  edges jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists execution_records (
  id text primary key,
  workflow_id text not null,
  workflow_name text not null,
  mode text not null,
  title text not null,
  runtime_inputs jsonb not null default '{}'::jsonb,
  result jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists execution_records_workflow_created_idx
  on execution_records (workflow_id, created_at desc);
