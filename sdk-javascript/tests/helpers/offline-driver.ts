// TEST ONLY: the live-order driver wired to the offline broker, for the Python harness's end-to-end
// test of the driver seam (sdk-python/tests/unit/test_live_driver_javascript.py). It is the same
// program as tests/live_orders/driver.ts (the real `runProgram`: the nonce and opt-in refusal, the
// handshake, the protocol loop and the wire capture), with one difference: the client is built on
// the offline broker's in-memory dispatcher instead of the real service, so nothing here can reach
// a network. No socket is opened, no login is read, no real credential exists. The account id the
// handshake reports is TRADESMART_LIVE_ORDER_ACCOUNT of the injected (fake) environment, so the
// harness's account match passes.
//
// Run as `node tests/helpers/offline-driver.ts` (Node's native type stripping) against the BUILT
// SDK (`../../dist`): the harness refuses to start it when dist is older than src.
//
// Optional test controls (environment of this program only): OFFLINE_DRIVER_PLACE sets how new
// orders are booked (`open`, `pending`, `reject`); OFFLINE_DRIVER_DRILL arms one failure for the
// next call of an endpoint, as `Endpoint:drill` (`PlaceOrder:reject`, `PlaceOrder:timeoutAfterSend`,
// `CancelOrder:serverError`).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TradeSmart } from "../../src/index.js";
import type { OfflineDispatcher } from "../../src/testing/rest.js";
import type { BrokerState } from "../../src/testing/state.js";
import {
  WireCapture,
  captureDispatcher,
  envSecrets,
  runProgram,
  type Built,
  type Env,
} from "../live_orders/driver.ts";

const DIST = "../../dist";
const OPTION = "NIFTY27NOV27C24000";

async function buildOffline(env: Env): Promise<Built> {
  const clientId = (env["TRADESMART_LIVE_ORDER_ACCOUNT"] ?? "").trim();
  if (clientId === "") throw new Error("TRADESMART_LIVE_ORDER_ACCOUNT is not set");
  const sdk = (await import(`${DIST}/index.js`)) as typeof import("../../src/index.js");
  const auth = (await import(`${DIST}/auth.js`)) as typeof import("../../src/auth.js");
  const rest = (await import(
    `${DIST}/testing/rest.js`
  )) as typeof import("../../src/testing/rest.js");
  const stateModule = (await import(
    `${DIST}/testing/state.js`
  )) as typeof import("../../src/testing/state.js");
  const drills = (await import(
    `${DIST}/testing/drills.js`
  )) as typeof import("../../src/testing/drills.js");

  const state: BrokerState = new stateModule.BrokerState(clientId);
  state.addInstrument("NFO", "2003", OPTION, {
    lotSize: 75,
    tickSize: "0.05",
    instrument: "OPTIDX",
    expiry: { date: "2027-11-25" },
    strike: 24000,
    optionType: "CE",
    underlying: "NIFTY",
    extra: { frzqty: 1801 },
  });
  state.addInstrument("NSE", "3045", "ITC-EQ", {});
  const place = (env["OFFLINE_DRIVER_PLACE"] ?? "").trim();
  if (place !== "") state.defaultPlace = place;
  const armed = (env["OFFLINE_DRIVER_DRILL"] ?? "").trim();
  if (armed !== "") {
    const [endpoint = "", name = ""] = armed.split(":");
    const make = (drills.drills as Record<string, (...args: unknown[]) => unknown>)[name];
    if (make === undefined) throw new Error(`unknown drill ${name}`);
    state.failNext(endpoint, make("RMS:Margin Exceeds") as never);
  }

  const dir = mkdtempSync(path.join(tmpdir(), "tradesmart-offline-driver-"));
  const capture = new WireCapture();
  const dispatcher: OfflineDispatcher = new rest.OfflineDispatcher(state);
  const issued = new Date();
  const client: TradeSmart = new sdk.TradeSmart(clientId, {
    accessToken: auth.AccessToken.fromParts(
      "offline-driver-token-0001",
      issued,
      new Date(issued.getTime() + 24 * 3_600_000),
    ),
    config: rest.offlineConfig("ws://127.0.0.1:9/", { instrumentsDir: dir, maxRetries: 0 }),
    httpDispatcher: captureDispatcher(dispatcher, capture),
  });
  return {
    client,
    capture,
    version: sdk.VERSION,
    environment: (env["TRADESMART_ENV"] ?? "").trim().toLowerCase() || "production",
    secrets: [...envSecrets(env), "offline-driver-token-0001"],
    close: async () => {
      await client.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const entry = process.argv[1];
if (entry !== undefined && path.resolve(entry) === path.resolve(import.meta.filename)) {
  process.exitCode = await runProgram(
    process.env,
    { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr },
    buildOffline,
  );
}
