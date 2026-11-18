// `UserDetails` (sdk-behaviour.md §2.3), mirroring sdk-python/src/tradesmart/endpoints/user.py.
import type { CallSpec } from "../lib/call.js";
import { parseUserDetails, type UserDetails } from "../models/generated/user.js";
import { objectDecoder, readSpec } from "./base.js";

/** The `UserDetails` call: `uid` only. */
export function userDetailsCall(uid: string, signal?: AbortSignal): CallSpec<UserDetails> {
  return readSpec({
    endpoint: "UserDetails",
    payload: [["uid", uid]],
    decode: objectDecoder(parseUserDetails, "UserDetails"),
    signal,
  });
}
