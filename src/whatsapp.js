// ============================================
// whatsapp.js — Meta WhatsApp API functions
// ============================================

export async function sendMessage(to, text, env) {
  if (!text || !text.trim()) {
    console.log(`[whatsapp] refused_empty_send to=${to}`);
    return;
  }
  await fetch(
    `https://graph.facebook.com/v18.0/${env.PHONE_NUMBER_ID}/messages`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.WHATSAPP_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to,
        type: 'text',
        text: { body: text }
      })
    }
  );
}

export async function sendReaction(to, messageId, env) {
  await fetch(
    `https://graph.facebook.com/v18.0/${env.PHONE_NUMBER_ID}/messages`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.WHATSAPP_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to,
        type: 'reaction',
        reaction: {
          message_id: messageId,
          emoji: '🙏'
        }
      })
    }
  );
}

export async function sendImage(to, imageUrl, caption, env) {
  await fetch(
    `https://graph.facebook.com/v18.0/${env.PHONE_NUMBER_ID}/messages`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.WHATSAPP_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to,
        type: 'image',
        image: {
          link: imageUrl,
          caption
        }
      })
    }
  );
}

export async function getImageAsBase64(imageId, mimeType, env) {
  const mediaRes = await fetch(
    `https://graph.facebook.com/v18.0/${imageId}`,
    { headers: { Authorization: `Bearer ${env.WHATSAPP_TOKEN}` } }
  );
  const mediaData = await mediaRes.json();

  const imgRes = await fetch(mediaData.url, {
    headers: { Authorization: `Bearer ${env.WHATSAPP_TOKEN}` }
  });

  const imgBuffer = await imgRes.arrayBuffer();
  const bytes = new Uint8Array(imgBuffer);
  let binary = '';
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return {
    base64: btoa(binary),
    mimeType: mimeType || 'image/jpeg'
  };
}
