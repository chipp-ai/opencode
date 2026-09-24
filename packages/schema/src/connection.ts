export * as Connection from "./connection"

import { Schema } from "effect"
import { Credential } from "./credential"
import { IntegrationID } from "./integration-id"

export interface CredentialInfo extends Schema.Schema.Type<typeof CredentialInfo> {}
export const CredentialInfo = Schema.Struct({
  type: Schema.Literal("credential"),
  id: Credential.ID,
  label: Schema.String,
}).annotate({ identifier: "Connection.CredentialInfo" })

export interface EnvInfo extends Schema.Schema.Type<typeof EnvInfo> {}
export const EnvInfo = Schema.Struct({
  type: Schema.Literal("env"),
  name: Schema.String,
}).annotate({ identifier: "Connection.EnvInfo" })

/** A key the V1 provider auth store saved (`auth.json`), read live rather than copied into V2 credentials. */
export interface LegacyInfo extends Schema.Schema.Type<typeof LegacyInfo> {}
export const LegacyInfo = Schema.Struct({
  type: Schema.Literal("legacy"),
  integrationID: IntegrationID,
}).annotate({ identifier: "Connection.LegacyInfo" })

export const Info = Schema.Union([CredentialInfo, EnvInfo, LegacyInfo])
  .pipe(Schema.toTaggedUnion("type"))
  .annotate({ identifier: "Connection.Info" })
export type Info = typeof Info.Type
