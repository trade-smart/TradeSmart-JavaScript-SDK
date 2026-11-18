// GENERATED from specifications/models.json by scripts/gen-models.ts — do not edit
import { T, parseModel, type ModelSpec, type ParseContext, type Secret } from "../base.js";

/** Result of `GenAcsTok`. Token values are masked in `repr`/`str`/`raw`. */
export interface AccessToken {
  /** Wire key `access_token`. */
  readonly accessToken: Secret;
  /** Wire key `susertoken`. */
  readonly susertoken: Secret | null;
  /** Wire key `refresh_token`. */
  readonly refreshToken: Secret | null;
  /** Wire key `expires_in`. */
  readonly expiresIn: string | null;
  /** Wire key `uid`. */
  readonly userId: string | null;
  /** Wire key `actid`. */
  readonly accountId: string | null;
  /** Wire key `uname`. */
  readonly uname: string | null;
  /** Wire key `issued_at`. */
  readonly issuedAt: Date;
  /** Wire key `expires_at`. */
  readonly expiresAt: Date;
  /** The wire object as received (shallow copy, redacted, frozen). */
  readonly raw: Readonly<Record<string, unknown>>;
  /** Wire keys this model does not name, with their values. */
  readonly extra: Readonly<Record<string, unknown>>;
}

/** Field specification of `AccessToken`. */
export const AccessTokenSpec: ModelSpec = {
  name: "AccessToken",
  fields: [
    { name: "accessToken", wire: "access_token", type: T.secret, required: true, nullable: false },
    { name: "susertoken", wire: "susertoken", type: T.secret },
    { name: "refreshToken", wire: "refresh_token", type: T.secret },
    { name: "expiresIn", wire: "expires_in", type: T.str },
    { name: "userId", wire: "uid", type: T.str },
    { name: "accountId", wire: "actid", type: T.str },
    { name: "uname", wire: "uname", type: T.str },
    { name: "issuedAt", wire: "issued_at", type: T.datetime, required: true, nullable: false },
    { name: "expiresAt", wire: "expires_at", type: T.datetime, required: true, nullable: false },
  ],
};

/** Parse one `AccessToken` wire record. */
export function parseAccessToken(wire: unknown, ctx?: ParseContext): AccessToken {
  return parseModel(AccessTokenSpec, wire, ctx) as AccessToken;
}
