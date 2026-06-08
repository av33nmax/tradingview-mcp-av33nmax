/**
 * asia/lib/discord_hsi.mjs — Discord webhook poster for HSI / HSTECH events.
 *
 * Reads $DISCORD_WEBHOOK_HSI (separate channel from US's $DISCORD_WEBHOOK so
 * Asia signals don't pollute US #setups during the trader's sleep hours).
 *
 * Silent no-op if unset. Network errors logged but never thrown — Discord
 * pings must NEVER affect order placement flow.
 */

const WEBHOOK = process.env.DISCORD_WEBHOOK_HSI;

export const DISCORD_HSI_ENABLED = !!WEBHOOK;

export async function discordHSI(content) {
  if (!WEBHOOK) return;
  try {
    const res = await fetch(WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.log(`   ⚠ Discord HSI webhook returned ${res.status}: ${body.slice(0, 100)}`);
    }
  } catch (err) {
    console.log(`   ⚠ Discord HSI webhook failed: ${err?.message || err}`);
  }
}
