/**
 * What each role may do, for shaping the screen only. The rule that holds is has_perm()
 * in supabase/migrations/0004_roles_and_reading.sql; tools/test-sql.mjs compares the two
 * line by line (FQC's LADDER trap: a role table that exists twice drifts).
 */
export type Role = 'director' | 'inventory' | 'chef' | 'staff' | 'driver';

export const PERMS = {
  view: ['director', 'inventory', 'chef', 'staff', 'driver'],
  loss_report: ['director', 'inventory', 'chef', 'staff', 'driver'],
  issue: ['director', 'inventory', 'chef', 'staff'],
  request: ['director', 'inventory', 'chef', 'staff'],
  count_entry: ['director', 'inventory', 'chef', 'staff'],
  receive: ['director', 'inventory'],
  adjust: ['director', 'inventory'],
  items_edit: ['director', 'inventory'],
  fulfil: ['director', 'inventory'],
  reports: ['director', 'inventory'],
  loss_decide: ['director'],
  people: ['director'],
} as const satisfies Record<string, readonly Role[]>;

export type Perm = keyof typeof PERMS;

export const can = (role: Role | null | undefined, perm: Perm): boolean =>
  !!role && (PERMS[perm] as readonly Role[]).includes(role);

export const ROLE_NAMES: Record<Role, string> = {
  director: 'Director', inventory: 'Inventory Manager', chef: 'Chef', staff: 'Staff', driver: 'Driver',
};
