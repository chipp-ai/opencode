export * as SessionInput from "./session-input"

import { Schema } from "effect"
import { optional } from "./schema"
import { Prompt } from "./prompt"
import { DateTimeUtcFromMillis, NonNegativeInt } from "./schema"
import { SessionDelivery } from "./session-delivery"
import { SessionID } from "./session-id"
import { SessionMessage } from "./session-message"

export const Delivery = SessionDelivery.Delivery
export type Delivery = SessionDelivery.Delivery

export interface Admitted extends Schema.Schema.Type<typeof Admitted> {}
export const Admitted = Schema.Struct({
  admittedSeq: NonNegativeInt,
  id: SessionMessage.ID,
  sessionID: SessionID,
  prompt: Prompt,
  delivery: Delivery,
  timeCreated: DateTimeUtcFromMillis,
  promotedSeq: NonNegativeInt.pipe(optional),
  withdrawnSeq: NonNegativeInt.pipe(optional),
  /**
   * Idempotency key for a prompt delivered by an external system, unique per Session. A retried delivery with the
   * same key and fingerprint resolves to this row; the same key with a different fingerprint is a conflict.
   */
  commandId: Schema.String.pipe(optional),
  inputFingerprint: Schema.String.pipe(optional),
}).annotate({ identifier: "SessionInput.Admitted" })
