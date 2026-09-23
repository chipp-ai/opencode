import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260923161657_session_input_withdrawn",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`session_input\` ADD \`withdrawn_seq\` integer;`)
    })
  },
} satisfies DatabaseMigration.Migration
