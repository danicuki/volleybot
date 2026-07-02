// Notification channels for "your agent needs you" pings.
//
// Telegram is the zero-friction default: set TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID
// and you get a tappable link on your phone. Everything also prints to the
// terminal with a scannable QR code so it works with no config at all.

import qrcode from 'qrcode-terminal';

/**
 * @param {{url: string, reason: string}} info
 */
export async function notifyHuman({ url, reason }) {
  // Always print to the terminal.
  console.log('\n' + '─'.repeat(60));
  console.log('🙋  AGENT NEEDS A HUMAN');
  console.log('    ' + reason);
  console.log('    Take over here: ' + url);
  console.log('─'.repeat(60));
  qrcode.generate(url, { small: true });
  console.log('─'.repeat(60) + '\n');

  // Telegram, if configured.
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (token && chatId) {
    try {
      const text = `🙋 *Your agent is stuck*\n${escapeMd(reason)}\n\n[Take over →](${url})`;
      const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text,
          parse_mode: 'MarkdownV2',
          disable_web_page_preview: false,
        }),
      });
      if (!res.ok) console.warn('   (telegram send failed:', res.status, await res.text(), ')');
      else console.log('   ✓ Telegram notification sent.');
    } catch (e) {
      console.warn('   (telegram error:', e.message, ')');
    }
  } else {
    console.log('   (set TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID to get a phone ping)');
  }
}

function escapeMd(s) {
  return String(s).replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
}
