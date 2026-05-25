// ============================================
// search.js — Product identification + Brave Search
// ============================================

const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages';
const BRAVE_API = 'https://api.search.brave.com/res/v1/web/search';

/**
 * Quick Claude vision call to detect whether a full ingredient list is visible
 * in the image, or whether it is a product front / packaging shot.
 * Returns { isLabel: bool, productName: string|null }
 */
export async function identifyProduct(base64, mimeType, env) {
  try {
    console.log('[search] identifyProduct: calling Claude vision');
    const res = await fetch(ANTHROPIC_API, {
      method: 'POST',
      headers: {
        'x-api-key': env.ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 80,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: mimeType, data: base64 }
            },
            {
              type: 'text',
              text: 'Look at this image. Is the ingredient list (back or side panel with full ingredient text) visible? Reply with exactly one of:\nLABEL\nPRODUCT: [full product name and brand]'
            }
          ]
        }]
      })
    });

    console.log('[search] identifyProduct: Claude status', res.status);
    if (!res.ok) {
      const errText = await res.text();
      console.log('[search] identifyProduct: Claude error body', errText);
      return { isLabel: true, productName: null };
    }

    const data = await res.json();
    const text = (data.content?.[0]?.text || '').trim();
    console.log('[search] identifyProduct: Claude replied:', text);

    if (text.toUpperCase().startsWith('PRODUCT:')) {
      const productName = text.slice(8).trim();
      console.log('[search] identifyProduct: product front detected:', productName);
      return { isLabel: false, productName: productName || null };
    }
    console.log('[search] identifyProduct: label detected');
    return { isLabel: true, productName: null };

  } catch (err) {
    console.log('[search] identifyProduct error:', err.message);
    return { isLabel: true, productName: null };
  }
}

/**
 * Search Brave for ingredient information for a named product.
 * Returns a short text block with search snippets, or null if nothing useful found.
 */
export async function searchProductIngredients(productName, env) {
  try {
    console.log('[search] searchProductIngredients: searching for', productName);
    console.log('[search] BRAVE_API_KEY present:', !!env.BRAVE_API_KEY);

    const query = encodeURIComponent(`${productName} ingredients`);
    const res = await fetch(`${BRAVE_API}?q=${query}&count=3`, {
      headers: {
        'X-Subscription-Token': env.BRAVE_API_KEY,
        'Accept': 'application/json'
      }
    });

    console.log('[search] Brave status:', res.status);
    if (!res.ok) {
      const errText = await res.text();
      console.log('[search] Brave error body:', errText);
      return null;
    }

    const data = await res.json();
    const results = data?.web?.results || [];
    console.log('[search] Brave result count:', results.length);
    if (!results.length) return null;

    const snippets = results
      .filter(r => r.description)
      .slice(0, 3)
      .map(r => `${r.title}: ${r.description}`)
      .join('\n');

    console.log('[search] snippets length:', snippets.length);
    return snippets || null;

  } catch (err) {
    console.log('[search] searchProductIngredients error:', err.message);
    return null;
  }
}
