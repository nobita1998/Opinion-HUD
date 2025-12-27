/**
 * Opinion HUD - Token Price API
 *
 * Fetches the latest price for a given token ID from Opinion.Trade OpenAPI
 *
 * Endpoint: /api/token/:tokenId
 * Method: GET
 * Cache: 60 seconds (1 minute)
 *
 * Example:
 * GET /api/token/68227038457866748595233145251243944054564947305383894629176574093714476769147
 *
 * Response:
 * {
 *   "success": true,
 *   "data": {
 *     "tokenId": "682270...",
 *     "price": 0.15,
 *     "lastUpdated": 1703123456
 *   }
 * }
 */

const fetch = require('node-fetch');
const { getOpinionApiKey } = require('../../lib/keychain');

// Opinion.Trade OpenAPI configuration
const OPINION_API_BASE = 'https://proxy.opinion.trade:8443/openapi';
const CACHE_MAX_AGE = 60; // 1 minute in seconds

/**
 * Fetch token price from Opinion.Trade OpenAPI
 * @param {string} tokenId - ERC-1155 token ID
 * @param {string} apiKey - Opinion API key
 * @returns {Promise<object>} Token price data
 */
async function fetchTokenPrice(tokenId, apiKey) {
  const url = `${OPINION_API_BASE}/token/latest-price?token_id=${encodeURIComponent(tokenId)}`;

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

  // Check Opinion API response format
  if (data.code !== undefined && data.code !== 0) {
    throw new Error(`Opinion API returned error code ${data.code}: ${data.msg}`);
  }

  // Return the actual result (or the whole data if no wrapper)
  return data.result || data;
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

  const { tokenId } = req.query;

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
    // Fetch token price from Opinion API
    const priceData = await fetchTokenPrice(tokenId, apiKey);

    // Set cache headers (1 minute)
    res.setHeader('Cache-Control', `public, s-maxage=${CACHE_MAX_AGE}, stale-while-revalidate=${CACHE_MAX_AGE * 2}`);
    res.setHeader('CDN-Cache-Control', `public, s-maxage=${CACHE_MAX_AGE}`);
    res.setHeader('Vercel-CDN-Cache-Control', `public, s-maxage=${CACHE_MAX_AGE}`);

    // Transform to compatible format (array with price and timestamp)
    const compatibleData = [
      {
        price: priceData.price,
        timestamp: priceData.timestamp
      }
    ];

    // Return success response
    return res.status(200).json({
      success: true,
      data: compatibleData,
      cachedUntil: Date.now() + (CACHE_MAX_AGE * 1000)
    });

  } catch (error) {
    console.error('Error fetching token price:', error);

    // Return error response
    return res.status(500).json({
      success: false,
      error: 'Failed to fetch token price',
      message: error.message
    });
  }
};
