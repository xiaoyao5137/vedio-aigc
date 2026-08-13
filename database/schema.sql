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
  schema_version integer not null default 1,
  updated_at timestamptz not null default now()
);

alter table workflow_configs add column if not exists schema_version integer not null default 1;

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

create table if not exists model_execution_records (
  id text primary key,
  channel text not null,
  model_id text not null,
  model_name text not null,
  provider text not null,
  capability text not null,
  status text not null,
  http_status integer,
  task_id text,
  workflow_id text,
  workflow_name text,
  node_id text,
  node_name text,
  request_data jsonb not null default '{}'::jsonb,
  response_data jsonb,
  error text,
  duration_ms integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists model_execution_records_created_idx
  on model_execution_records (created_at desc);

create index if not exists model_execution_records_filters_idx
  on model_execution_records (channel, model_id, status, created_at desc);

create index if not exists model_execution_records_task_idx
  on model_execution_records (task_id) where task_id is not null;

create table if not exists knowledge_documents (
  id text primary key,
  title text not null,
  source text not null,
  edition text not null default '',
  url text not null default '',
  metadata jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists knowledge_chunks (
  id text primary key,
  document_id text not null references knowledge_documents(id) on delete cascade,
  ordinal integer not null default 0,
  content text not null,
  embedding jsonb not null default '[]'::jsonb,
  metadata jsonb not null default '{}'::jsonb
);

create index if not exists knowledge_chunks_document_idx
  on knowledge_chunks (document_id, ordinal);

create table if not exists character_assets (
  id text primary key,
  workflow_id text,
  character_name text not null,
  asset_type text not null,
  uri text not null,
  prompt text not null default '',
  version integer not null default 1,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table character_assets add column if not exists workflow_id text;

create index if not exists character_assets_lookup_idx
  on character_assets (character_name, asset_type, updated_at desc);

create index if not exists character_assets_workflow_idx
  on character_assets (workflow_id, updated_at desc);
