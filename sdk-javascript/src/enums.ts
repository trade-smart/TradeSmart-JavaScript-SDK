// Wire enums and their request-side lookup (sdk-behaviour.md §7.3). The constants are generated
// from specifications/models.json into src/models/generated/enums.ts.
import { fieldError } from "./errors.js";
import { ENUM_LOOKUP } from "./models/generated/enums.js";

export {
  Buildup,
  Exchange,
  GttAlertType,
  GttValidity,
  OrderStatus,
  OrderType,
  Product,
  StreamState,
  TransactionType,
  Validity,
} from "./models/generated/enums.js";

/** Name of a wire enum (one sent to the server). */
export type EnumName = keyof typeof ENUM_LOOKUP;

/**
 * Resolve a request value of a wire enum to its wire code: the wire code or one of the listed
 * words, in any case, trimmed (`"CNC"`, `"cnc"` and `"C"` all give `"C"`). Anything else throws
 * with `loc [field]` (the wire key) and never echoes the value.
 */
export function resolveEnum(name: EnumName, input: unknown, field: string): string {
  if (typeof input === "string") {
    const table: Readonly<Record<string, string>> = ENUM_LOOKUP[name];
    const key = input.trim().toUpperCase();
    if (Object.hasOwn(table, key)) {
      const wire = table[key];
      if (wire !== undefined) return wire;
    }
  }
  throw fieldError(field, "enum", `expected one of the ${name} values`);
}
