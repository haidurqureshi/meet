export async function isLimited(db: D1Database, key: string, max: number, windowMs: number): Promise<boolean> {
  const since = Date.now() - windowMs;
  // Tidy up old rows now and then rather than on every request.
  if (Math.random() < 0.05) await db.prepare("DELETE FROM rate_limits WHERE ts < ?1").bind(Date.now() - 48 * 3600_000).run();
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM rate_limits WHERE key = ?1 AND ts >= ?2")
    .bind(key, since)
    .first<{ n: number }>();
  return (row?.n ?? 0) >= max;
}

export async function recordHit(db: D1Database, key: string): Promise<void> {
  await db.prepare("INSERT INTO rate_limits (key, ts) VALUES (?1, ?2)").bind(key, Date.now()).run();
}

export async function clearHits(db: D1Database, key: string): Promise<void> {
  await db.prepare("DELETE FROM rate_limits WHERE key = ?1").bind(key).run();
}
