export type AppRole = "view" | "push" | "admin";

const ROLE_RANK: Record<AppRole, number> = {
  admin: 3,
  push: 2,
  view: 1,
};

export const parseAppRole = (role: string): AppRole | null => {
  if (role === "view" || role === "push" || role === "admin") {
    return role;
  }
  return null;
};

export const roleAtLeast = (have: AppRole, need: AppRole): boolean =>
  ROLE_RANK[have] >= ROLE_RANK[need];
