-- Sample data for exercising pginspect, including plans worth looking at.
-- Load with:  psql -h localhost -p 5433 -U postgres -d inspect -f testdata/seed.sql
-- Takes about a minute. Re-running drops and recreates the "shop" schema.

\set ON_ERROR_STOP on
\timing off

drop schema if exists shop cascade;
create schema shop;
set search_path = shop, public;

create table countries (
  code char(2) primary key,
  name text not null,
  region text not null
);
insert into countries values
  ('US','United States','americas'), ('CA','Canada','americas'), ('MX','Mexico','americas'),
  ('GB','United Kingdom','europe'), ('DE','Germany','europe'), ('FR','France','europe'),
  ('JP','Japan','apac'), ('AU','Australia','apac'), ('BR','Brazil','americas'), ('IN','India','apac');

create table customers (
  id bigserial primary key,
  email text not null,
  full_name text not null,
  country char(2) not null references countries(code),
  tier text not null default 'free',
  signed_up_at timestamptz not null,
  attributes jsonb not null default '{}'
);
comment on table customers is 'One row per customer. tier is heavily skewed toward free.';

insert into customers (email, full_name, country, tier, signed_up_at, attributes)
select
  'user' || i || '@example.' || (array['com','net','org','io'])[1 + i % 4],
  (array['Ada','Grace','Linus','Ken','Dennis','Barbara','Margaret','Alan','Edsger','Donald'])[1 + i % 10]
    || ' ' || (array['Lovelace','Hopper','Torvalds','Thompson','Ritchie','Liskov','Hamilton','Turing','Dijkstra','Knuth'])[1 + (i / 10) % 10],
  case when random() < 0.6 then 'US' when random() < 0.5 then 'GB' when random() < 0.5 then 'DE'
       else (array['CA','MX','FR','JP','AU','BR','IN'])[1 + (random() * 6)::int] end,
  case when random() < 0.85 then 'free' when random() < 0.8 then 'pro' else 'enterprise' end,
  now() - (random() * 1500) * interval '1 day',
  jsonb_build_object('newsletter', random() < 0.3, 'source', (array['ads','organic','referral','partner'])[1 + (random() * 3)::int])
from generate_series(1, 50000) i;

-- Deliberately no unique index on email so the planner cannot use one.
create index customers_country_idx on customers (country);

create table categories (
  id serial primary key,
  name text not null,
  parent_id int references categories(id)
);
insert into categories (name, parent_id)
select 'Category ' || i, case when i > 10 then 1 + (i % 10) end from generate_series(1, 60) i;

create table products (
  id bigserial primary key,
  sku text not null unique,
  name text not null,
  category_id int not null references categories(id),
  price numeric(10,2) not null,
  active boolean not null default true,
  tags text[] not null default '{}'
);
insert into products (sku, name, category_id, price, active, tags)
select
  'SKU-' || lpad(i::text, 6, '0'),
  'Product ' || i,
  1 + (i % 60),
  round((random() * 400 + 1)::numeric, 2),
  random() < 0.9,
  array_remove(array[
    case when random() < 0.5 then 'sale' end,
    case when random() < 0.2 then 'new' end,
    case when random() < 0.1 then 'clearance' end], null)
from generate_series(1, 5000) i;

create table orders (
  id bigserial primary key,
  customer_id bigint not null references customers(id),
  status text not null,
  placed_at timestamptz not null,
  shipped_at timestamptz,
  total numeric(12,2) not null default 0,
  note text
);
comment on table orders is 'placed_at has no index on purpose: range queries seq scan.';

-- Customer ids follow a power-law distribution: a few customers order constantly.
insert into orders (customer_id, status, placed_at, shipped_at, note)
select
  least(50000, 1 + floor(power(random(), 3) * 50000))::bigint,
  case when r < 0.90 then 'shipped' when r < 0.97 then 'paid' when r < 0.99 then 'new' else 'cancelled' end,
  placed,
  case when r < 0.90 then placed + (random() * 5) * interval '1 day' end,
  case when random() < 0.02 then 'gift wrap please' end
from (
  select random() as r, now() - (random() * 730) * interval '1 day' as placed
  from generate_series(1, 300000)
) s;

create index orders_customer_id_idx on orders (customer_id);
create index orders_status_idx on orders (status);

create table order_items (
  order_id bigint not null references orders(id),
  line int not null,
  product_id bigint not null references products(id),
  quantity int not null,
  unit_price numeric(10,2) not null,
  primary key (order_id, line)
);
comment on table order_items is 'No index on product_id: joins from products are expensive.';

insert into order_items (order_id, line, product_id, quantity, unit_price)
select o.id, g.line,
  1 + floor(power(random(), 2) * 5000)::bigint,
  1 + floor(random() * 4)::int,
  round((random() * 200 + 1)::numeric, 2)
from orders o
cross join lateral generate_series(1, 1 + ((o.id * 7919 + o.customer_id) % 4)::int) as g(line);

update orders o set total = s.sum
from (select order_id, sum(quantity * unit_price) as sum from order_items group by order_id) s
where s.order_id = o.id;

create table events (
  id bigserial primary key,
  customer_id bigint not null,
  kind text not null,
  occurred_at timestamptz not null,
  payload jsonb not null
);
comment on table events is 'Wide append-only table with no secondary indexes.';

insert into events (customer_id, kind, occurred_at, payload)
select
  1 + floor(random() * 50000)::bigint,
  (array['page_view','page_view','page_view','page_view','add_to_cart','checkout','login','search'])[1 + floor(random() * 8)::int],
  now() - (random() * 90) * interval '1 day',
  jsonb_build_object(
    'path', '/p/' || (1 + floor(random() * 5000))::int,
    'ua', (array['Chrome','Safari','Firefox','curl'])[1 + floor(random() * 4)::int],
    'ms', floor(random() * 3000)::int)
from generate_series(1, 1000000);

create view customer_lifetime as
select c.id, c.full_name, c.country, c.tier,
       count(o.id) as orders,
       coalesce(sum(o.total), 0) as revenue,
       max(o.placed_at) as last_order_at
from customers c
left join orders o on o.customer_id = c.id
group by c.id;

create view slow_top_products as
select p.id, p.name,
       (select sum(quantity) from order_items oi where oi.product_id = p.id) as units_sold
from products p;
comment on view slow_top_products is 'Correlated subquery over an unindexed column: a classic bad plan.';

create function order_total(oid bigint) returns numeric
language sql stable as $$
  select coalesce(sum(quantity * unit_price), 0) from shop.order_items where order_id = oid
$$;

create function customer_summary(cid bigint)
returns table (orders bigint, revenue numeric, first_order timestamptz)
language sql stable as $$
  select count(*), coalesce(sum(total), 0), min(placed_at) from shop.orders where customer_id = cid
$$;

create materialized view daily_revenue as
select date_trunc('day', placed_at)::date as day, status, count(*) as orders, sum(total) as revenue
from orders group by 1, 2;
create unique index daily_revenue_day_status_idx on daily_revenue (day, status);

analyze;
