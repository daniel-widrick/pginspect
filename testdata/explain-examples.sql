-- Queries with instructive plans against testdata/seed.sql. Select one and
-- press Cmd/Ctrl+E for the estimated plan or Cmd/Ctrl+Shift+E to run it.

-- 1. Seq scan with most rows removed by filter (placed_at has no index).
select count(*) from shop.orders where placed_at > now() - interval '7 days';

-- 2. Same, but the planner can use an index and the estimate is good.
select count(*) from shop.orders where status = 'cancelled';

-- 3. Missing index on order_items.product_id: hash join over the whole table.
select p.name, sum(oi.quantity) as units
from shop.products p
join shop.order_items oi on oi.product_id = p.id
where p.id = 42
group by p.name;

-- 4. Correlated subquery view: nested loop, thousands of seq scans.
select * from shop.slow_top_products order by units_sold desc nulls last limit 10;

-- 5. Skewed key: this customer has far more orders than the planner's average guess.
select count(*) from shop.orders where customer_id = 1;

-- 6. Sort that spills to disk with the default work_mem, plus a hash aggregate.
select customer_id, count(*), sum(total)
from shop.orders
group by customer_id
order by sum(total) desc;

-- 7. JSONB filter with no index: estimate is off by orders of magnitude.
select count(*) from shop.events where payload->>'ua' = 'curl' and kind = 'checkout';

-- 8. Explain Analyze on a write is safe: it runs in a transaction that is rolled back.
update shop.orders set note = 'late' where status = 'paid' and placed_at < now() - interval '30 days';
