// A real `TradeSmart` talking to the offline broker's in-memory dispatcher through the live-order
// driver's wire capture (tests/live_orders/driver.ts). `OfflineBroker` keeps its dispatcher
// private, so this builds the two parts the broker is made of (`BrokerState` and
// `OfflineDispatcher`) and wraps the dispatcher; `state` is the broker's own state object
// (`state.requests` is what `OfflineBroker.requests` returns). Nothing leaves the process: no
// socket is opened (REST is in memory, the stream URL below is never connected).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AccessToken } from "../../src/auth.js";
import { TradeSmart } from "../../src/client.js";
import type { ClientConfigInit } from "../../src/config.js";
import { OfflineDispatcher, offlineConfig } from "../../src/testing/rest.js";
import { BrokerState } from "../../src/testing/state.js";
import { WireCapture, captureDispatcher } from "../live_orders/driver.js";

export const SYNTHETIC_TOKEN = "synthetic-offline-token-0001";

export interface OfflineWire {
  readonly state: BrokerState;
  readonly client: TradeSmart;
  readonly capture: WireCapture;
  close(): Promise<void>;
}

export function offlineWire(config: ClientConfigInit = {}, clientId = "OFFLINE01"): OfflineWire {
  const state = new BrokerState(clientId);
  const capture = new WireCapture();
  const dir = mkdtempSync(path.join(tmpdir(), "tradesmart-driver-test-"));
  const issued = new Date();
  const client = new TradeSmart(clientId, {
    accessToken: AccessToken.fromParts(
      SYNTHETIC_TOKEN,
      issued,
      new Date(issued.getTime() + 24 * 3_600_000),
    ),
    appKey: "offline-app-key",
    secretKey: "offline-secret-key",
    config: offlineConfig("ws://127.0.0.1:9/", { instrumentsDir: dir, maxRetries: 0, ...config }),
    httpDispatcher: captureDispatcher(new OfflineDispatcher(state), capture),
  });
  return {
    state,
    client,
    capture,
    close: async () => {
      await client.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
