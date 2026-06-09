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
