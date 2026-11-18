// Offline TradeSmart broker for testing strategy code without an account or network
// (`tradesmart/testing`). Import it explicitly; `import "tradesmart"` never loads it.
export { OfflineBroker, type OfflineBrokerOptions } from "./broker.js";
export { drills, type Drill } from "./drills.js";
export type { OfflineOrder, OfflineRequest } from "./state.js";
