create extension if not exists postgis;

create table if not exists cities (
  id uuid primary key default gen_random_uuid(),
  slug text unique not null,
  name text not null,
  discovered_at timestamptz
);

create table if not exists pois (
  id uuid primary key default gen_random_uuid(),
  city_id uuid not null references cities(id) on delete cascade,
  wikidata_qid text not null,
  names jsonb not null,
  point geography(Point, 4326) not null,
  p31_types text[] not null default '{}',
  wiki_en_title text, wiki_local_title text,
  summary_en text, summary_local text,
  wheelchair text,
  fetched_at timestamptz not null default now(),
  unique (city_id, wikidata_qid)
);

create table if not exists tours (
  id uuid primary key,
  city_id uuid not null references cities(id) on delete cascade,
  language text not null,
  persona text not null,
  profile_text text not null,
  title text not null,
  route jsonb not null,
  estimated_duration_min integer not null,
  created_at timestamptz not null default now()
);

create table if not exists segments (
  id text primary key,
  tour_id uuid not null references tours(id) on delete cascade,
  "order" integer not null,
  kind text not null,
  title text not null,
  script text not null,
  audio_url text,
  duration_ms integer,
  trigger geography(Point, 4326),
  trigger_radius_m double precision not null,
  poi_ids text[] not null default '{}'
);

create table if not exists jobs (
  id uuid primary key default gen_random_uuid(),
  city_id uuid not null references cities(id) on delete cascade,
  status text not null,
  stage text,
  request jsonb not null,
  stage_output jsonb not null default '{}'::jsonb,
  tour_id uuid references tours(id) on delete set null,
  error text,
  cost_usd numeric(10,4) not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists jobs_created_at_idx on jobs (created_at);
create index if not exists pois_city_idx on pois (city_id);
create index if not exists segments_tour_order_idx on segments (tour_id, "order");
