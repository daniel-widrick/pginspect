-- Small fixture used by the Go tests (internal/db). Load into a database
-- named "inspect" reachable at localhost:5433 as postgres/postgres:
--   psql -h localhost -p 5433 -U postgres -d inspect -f testdata/test-schema.sql
-- testdata/seed.sql adds the larger "shop" dataset on top of this.

\set ON_ERROR_STOP on

drop schema if exists app cascade;
create schema app;

create table app.customers (
  id bigserial primary key,
  email text not null unique,
  name text not null,
  created_at timestamptz not null default now(),
  tags text[] default '{}',
  meta jsonb
);
create table app.orders (
  id bigserial primary key,
  customer_id bigint not null references app.customers(id),
  total numeric(12,2) not null,
  status text not null default 'new' check (status in ('new','paid','shipped')),
  placed_at timestamptz not null default now()
);
create index orders_customer_idx on app.orders(customer_id);
create view app.customer_totals as
  select c.id, c.name, count(o.id) as orders, coalesce(sum(o.total),0) as spent
  from app.customers c left join app.orders o on o.customer_id=c.id group by c.id, c.name;
create function app.order_count(cid bigint) returns bigint language sql as $$ select count(*) from app.orders where customer_id=cid $$;
insert into app.customers(email,name,tags,meta)
  select 'user'||i||'@example.com', 'User '||i, array['t'||(i%3)], jsonb_build_object('n',i) from generate_series(1,500) i;
insert into app.orders(customer_id,total,status)
  select (random()*499+1)::bigint, (random()*1000)::numeric(12,2), (array['new','paid','shipped'])[floor(random()*3+1)] from generate_series(1,5000);

drop table if exists public.kitchen_sink;
create table public.kitchen_sink (id serial primary key, b bytea, u uuid default gen_random_uuid(), d date, t time, iv interval, n numeric, f float8, bl boolean, ip inet, nul text);
insert into public.kitchen_sink(b,d,t,iv,n,f,bl,ip) values ('\xdeadbeef', '2024-01-02', '13:45', '1 day 2 hours', 1234567.891, 3.14159, true, '10.0.0.1');

create extension if not exists pg_stat_statements;
