/**
 * Health check endpoint
 */
module.exports = async (req, res) => {
  const hasApiKey = !!process.env.OPINION_KEY;

  return res.status(200).json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    region: process.env.VERCEL_REGION || 'unknown',
    hasApiKey: hasApiKey,
    apiKeyPrefix: hasApiKey ? process.env.OPINION_KEY.substring(0, 4) + '...' : null
  });
};
