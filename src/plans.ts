// Plans and what each one allows.
//
//   Free        up to 4 people, direct (peer-to-peer) calls only, group calls (3-4 people) end after 45 minutes
//   Pro         up to 15 people, larger calls through Cloudflare's media servers, vanity link, waiting room, after-call page
//   Business    per seat: up to 50 people, plus logo and colours, the API and embedding; the owner invites team members
//   Enterprise  arranged by hand (see README): 100 people, everything, no large-call allowance limit

import type { Env } from "./env";

export type Plan = "free" | "pro" | "business" | "enterprise";
export type PaidPlan = "pro" | "business";
export const RANK: Record<Plan, number> = { free: 0, pro: 1, business: 2, enterprise: 3 };
export const PLAN_NAME: Record<Plan, string> = { free: "Free", pro: "Pro", business: "Business", enterprise: "Enterprise" };

export const live = (status: string) => status === "active" || status === "trialing";

export type Caps = {
  maxPeople: number;
  sfu: boolean; // calls of 5+ people through Cloudflare RealtimeKit
  sfuMinutes: number | null; // participant-minutes a month included; null = no limit
  groupLimitMin: number; // 3+ people calls end after this many minutes; 0 = no limit
  vanity: boolean;
  waiting: boolean; // waiting room and after-call page
  branding: boolean;
  api: boolean; // API keys and embedding
};

function int(v: string | undefined, fallback: number, min: number): number {
  const n = Number.parseInt(v ?? "", 10);
  return Number.isFinite(n) && n >= min ? n : fallback;
}

export function capsOf(env: Env, plan: Plan, seats: number): Caps {
  switch (plan) {
    case "enterprise":
      return { maxPeople: 100, sfu: true, sfuMinutes: null, groupLimitMin: 0, vanity: true, waiting: true, branding: true, api: true };
    case "business":
      return { maxPeople: 50, sfu: true, sfuMinutes: 10_000 * Math.max(1, seats), groupLimitMin: 0, vanity: true, waiting: true, branding: true, api: true };
    case "pro":
      return { maxPeople: 15, sfu: true, sfuMinutes: 3_000, groupLimitMin: 0, vanity: true, waiting: true, branding: false, api: false };
    default:
      return { maxPeople: 4, sfu: false, sfuMinutes: 0, groupLimitMin: int(env.FREE_GROUP_MINUTES, 45, 1), vanity: false, waiting: false, branding: false, api: false };
  }
}

export const proPricePence = (env: Env) => int(env.PRO_PRICE_PENCE, 700, 30);
export const businessPricePence = (env: Env) => int(env.BUSINESS_PRICE_PENCE, 1500, 30);
const pounds = (pence: number) => {
  const p = pence / 100;
  return `£${Number.isInteger(p) ? p : p.toFixed(2)}`;
};
export const proPriceLabel = (env: Env) => `${pounds(proPricePence(env))}/month`;
export const businessPriceLabel = (env: Env) => `${pounds(businessPricePence(env))}/user/month`;

export type Account = {
  plan: Plan; // what this person can use: their own plan, or their team's
  seats: number; // seats on the plan they're using
  billingId: number; // whose plan it is (themselves, or the team owner): large-call minutes count against this account
  ownPlan: Plan; // the plan they pay for themselves
  ownSeats: number;
  teamOwnerId: number | null; // set when they're a member of someone's Business team
  caps: Caps;
};

type AccountRow = {
  sub_status: string;
  plan: string | null;
  seats: number | null;
  owner_id: number | null;
  o_status: string | null;
  o_plan: string | null;
  o_seats: number | null;
};

const asPlan = (plan: string | null, status: string | null): Plan => {
  if (plan === "enterprise") return "enterprise"; // invoiced by hand, no Stripe subscription
  if ((plan === "pro" || plan === "business") && live(status ?? "")) return plan;
  return "free";
};

/** Works out which plan a person is on, counting a Business team they belong to. */
export async function accountFor(env: Env, userId: number): Promise<Account> {
  const r = await env.DB
    .prepare(
      `SELECT u.sub_status, ap.plan, ap.seats, tm.owner_id, ou.sub_status AS o_status, oap.plan AS o_plan, oap.seats AS o_seats
       FROM users u
       LEFT JOIN account_plan ap ON ap.user_id = u.id
       LEFT JOIN team_members tm ON tm.user_id = u.id
       LEFT JOIN users ou ON ou.id = tm.owner_id
       LEFT JOIN account_plan oap ON oap.user_id = tm.owner_id
       WHERE u.id = ?1`
    )
    .bind(userId)
    .first<AccountRow>();
  const ownPlan = r ? asPlan(r.plan, r.sub_status) : "free";
  const ownSeats = ownPlan === "business" || ownPlan === "enterprise" ? Math.max(1, r?.seats ?? 1) : 1;
  const teamPlan = r?.owner_id ? asPlan(r.o_plan, r.o_status) : "free";
  const viaTeam = (teamPlan === "business" || teamPlan === "enterprise") && RANK[teamPlan] > RANK[ownPlan];
  const plan = viaTeam ? teamPlan : ownPlan;
  const seats = viaTeam ? Math.max(1, r!.o_seats ?? 1) : ownSeats;
  return { plan, seats, billingId: viaTeam ? r!.owner_id! : userId, ownPlan, ownSeats, teamOwnerId: r?.owner_id ?? null, caps: capsOf(env, plan, seats) };
}

/* ---------- large-call (SFU) minutes ---------- */

export const monthKey = (d = new Date()) => d.toISOString().slice(0, 7);

export async function sfuUsed(env: Env, billingId: number): Promise<number> {
  const r = await env.DB.prepare("SELECT minutes FROM sfu_usage WHERE owner_id = ?1 AND month = ?2").bind(billingId, monthKey()).first<{ minutes: number }>();
  return r?.minutes ?? 0;
}

export async function addSfuMinutes(env: Env, billingId: number, minutes: number): Promise<void> {
  if (minutes <= 0 || !billingId) return;
  await env.DB
    .prepare("INSERT INTO sfu_usage (owner_id, month, minutes) VALUES (?1, ?2, ?3) ON CONFLICT(owner_id, month) DO UPDATE SET minutes = minutes + ?3")
    .bind(billingId, monthKey(), Math.round(minutes))
    .run();
}
