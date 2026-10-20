-- Rally's PRIMARY team assignment for a Feature inside a capacity plan.
--
-- Rally: "you can assign the portfolio item to one primary team and then allocate points or
-- story counts to the additional teams that will contribute to the work." One team owns the
-- Feature; the others contribute. The Items tab's "Planned Project Assignment" column shows
-- that team, so it has to be recorded rather than inferred from the allocation list.
--
-- Modelled as a flag on the allocation because the primary is by definition one of the teams
-- that HAS an allocation. "In the plan with no team at all" already exists as `team_id IS NULL`
-- — Rally's unassigned state, which its Items tab flags with a warning icon.
alter table work.capacity_plan_allocations
  add column if not exists is_primary boolean not null default false;

-- ONE primary per (plan, Feature), enforced here rather than only in the service: two concurrent
-- "make this the primary" calls would otherwise both succeed and leave the Feature with two
-- owners, and no read could then say which one Rally's column should show.
create unique index if not exists uq_capacity_allocation_primary
  on work.capacity_plan_allocations (plan_id, portfolio_item_id)
  where is_primary;

-- An unallocated placeholder names no team, so it cannot be the team that owns the work.
alter table work.capacity_plan_allocations
  drop constraint if exists ck_capacity_primary_has_team;
alter table work.capacity_plan_allocations
  add constraint ck_capacity_primary_has_team
  check (not is_primary or team_id is not null);

-- Backfill: the EARLIEST team-assigned allocation for each (plan, Feature) becomes the primary.
--
-- Rally's own order of operations is assign-then-allocate, so the first team to receive work is
-- the one that was assigned it. Leaving existing rows with no primary would make every Feature
-- already in a plan read as unassigned, which is a different — and wrong — statement.
with first_team_allocation as (
  select distinct on (plan_id, portfolio_item_id) id
  from work.capacity_plan_allocations
  where team_id is not null
  order by plan_id, portfolio_item_id, created_at, id
)
update work.capacity_plan_allocations a
set is_primary = true
from first_team_allocation f
where a.id = f.id;
