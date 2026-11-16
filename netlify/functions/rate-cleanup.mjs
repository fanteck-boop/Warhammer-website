// Scheduled daily (00:00 UTC): deletes rate-limit blobs from previous days, so hashed
// visitor keys and their salt are gone within 24 hours even if nobody visits the site.
import { getStore } from '@netlify/blobs';
import { purgeStaleRateLimits } from './_lib/guard.mjs';

export default async () => {
  const removed = await purgeStaleRateLimits(getStore({ name: 'rate-limits', consistency: 'strong' }), ['chat', 'rules']);
  console.log('rate-cleanup: removed', removed);
};

export const config = { schedule: '@daily' };
