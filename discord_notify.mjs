/**
 * discord_notify.mjs — minimal Discord webhook poster for trade events.
 *
 * Reads $DISCORD_WEBHOOK from env (same env var discord_alert.sh uses).
 * If unset, all calls are silent no-ops so the trader never crashes due
 * to missing notification config. Network errors are logged but never
 * thrown — Discord pings must NEVER affect order placement flow.
 */
const WEBHOOK = process.env.DISCORD_WEBHOOK;

/** True iff DISCORD_WEBHOOK is set in env. Use to surface notify state at boot. */
export const DISCORD_ENABLED = !!WEBHOOK;

export async function discordNotify(content) {
  if (!WEBHOOK) return;
  try {
    const res = await fetch(WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.log(`   ⚠ Discord webhook returned ${res.status}: ${body.slice(0, 100)}`);
    }
  } catch (err) {
    console.log(`   ⚠ Discord webhook failed: ${err?.message || err}`);
  }
}
