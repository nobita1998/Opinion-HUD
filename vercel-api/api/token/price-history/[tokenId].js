/**
 * Opinion HUD - Token Price History API
 *
 * Fetches price history for a given token ID from Opinion.Trade OpenAPI
 *
 * Endpoint: /api/token/price-history/:tokenId
 * Method: GET
 * Query Params:
 *   - interval: 1m | 1h | 1d | 1w | max (default: max)
 *
 * Example:
 * GET /api/token/price-history/68227038457866748595233145251243944054564947305383894629176574093714476769147?interval=max
 *
 * Response:
 * {
 *   "success": true,
 *   "data": [
 *     { "price": 0.45, "timestamp": 1703721600000 },
 *     { "price": 0.42, "timestamp": 1703718000000 }
 *   ],
 *   "interval": "max",
 *   "cachedUntil": 1703722200000
 * }
 */

const fetch = require('node-fetch');
const { getOpinionApiKey } = require('../../../lib/keychain');

// Opinion.Trade OpenAPI configuration
const OPINION_API_BASE = 'https://proxy.opinion.trade:8443/openapi';

// Valid intervals and their cache TTLs (in seconds)
const INTERVAL_CONFIG = {
  '1m': { cache: 60 },      // 1 minute cache for 1m interval
  '1h': { cache: 300 },     // 5 minutes cache for 1h interval
  '1d': { cache: 3600 },    // 1 hour cache for 1d interval
  '1w': { cache: 3600 },    // 1 hour cache for 1w interval
  'max': { cache: 3600 }    // 1 hour cache for max interval
};

const DEFAULT_INTERVAL = 'max';

/**
 * Fetch token price history from Opinion.Trade OpenAPI
 * @param {string} tokenId - ERC-1155 token ID
 * @param {string} interval - Time interval (1m, 1h, 1d, 1w, max)
 * @param {string} apiKey - Opinion API key
 * @returns {Promise<Array>} Array of price data points
 */
async function fetchPriceHistory(tokenId, interval, apiKey) {
  const url = `${OPINION_API_BASE}/token/price-history?token_id=${encodeURIComponent(tokenId)}&interval=${interval}`;

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'apikey': apiKey,
      'Accept': 'application/json'
    }
  });

  if (!response.ok) {
    throw new Error(`Opinion API error: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();

  // Check Opinion API response format (errno instead of code)
  if (data.errno !== undefined && data.errno !== 0) {
    throw new Error(`Opinion API returned error: ${data.errmsg || data.errno}`);
  }

  // Opinion API returns { result: { history: [{ t: timestamp, p: "price" }, ...] } }
  const history = data.result?.history;
  return Array.isArray(history) ? history : [];
}

/**
 * Vercel serverless function handler
 */
module.exports = async (req, res) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Only allow GET requests
  if (req.method !== 'GET') {
    return res.status(405).json({
      success: false,
      error: 'Method not allowed. Use GET.'
    });
  }

  const { tokenId, interval: rawInterval } = req.query;

  // Validate tokenId parameter
  if (!tokenId) {
    return res.status(400).json({
      success: false,
      error: 'Missing tokenId parameter'
    });
  }

  // Validate tokenId format (should be a large number string)
  if (!/^\d+$/.test(tokenId) || tokenId.length < 10) {
    return res.status(400).json({
      success: false,
      error: 'Invalid tokenId format. Must be a numeric string.'
    });
  }

  // Validate and normalize interval
  const interval = rawInterval && INTERVAL_CONFIG[rawInterval] ? rawInterval : DEFAULT_INTERVAL;
  const cacheMaxAge = INTERVAL_CONFIG[interval].cache;

  // Get API key from environment variable or macOS Keychain
  const apiKey = await getOpinionApiKey();
  if (!apiKey) {
    console.error('API key not found in environment variable or Keychain');
    return res.status(500).json({
      success: false,
      error: 'Server configuration error'
    });
  }

  try {
    // Fetch price history from Opinion API
    const priceHistory = await fetchPriceHistory(tokenId, interval, apiKey);

    // Set cache headers
    res.setHeader('Cache-Control', `public, s-maxage=${cacheMaxAge}, stale-while-revalidate=${cacheMaxAge * 2}`);
    res.setHeader('CDN-Cache-Control', `public, s-maxage=${cacheMaxAge}`);
    res.setHeader('Vercel-CDN-Cache-Control', `public, s-maxage=${cacheMaxAge}`);

    // Transform data to consistent format
    // Opinion API returns: [{ t: timestamp_seconds, p: "price" }, ...]
    // We convert to: [{ price: number, timestamp: milliseconds }, ...]
    const formattedData = Array.isArray(priceHistory)
      ? priceHistory.map(item => ({
          price: parseFloat(item.p),
          timestamp: item.t * 1000  // Convert seconds to milliseconds
        }))
      : [];

    // Return success response
    return res.status(200).json({
      success: true,
      data: formattedData,
      interval,
      cachedUntil: Date.now() + (cacheMaxAge * 1000)
    });

  } catch (error) {
    console.error('Error fetching price history:', error);

    // Return error response
    return res.status(500).json({
      success: false,
      error: 'Failed to fetch price history',
      message: error.message
    });
  }
};
