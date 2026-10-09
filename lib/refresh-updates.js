// Detached helper: run one update check and write the cache. Usage: node refresh-updates.js <cache-file>
import { collectUpdates, writeCache, cacheFilePath } from "./updates.js";

const file = process.argv[2] || cacheFilePath();
const items = await collectUpdates().catch(() => null);
if (items) writeCache(file, { checkedAt: Date.now(), items });
process.exit(0);
