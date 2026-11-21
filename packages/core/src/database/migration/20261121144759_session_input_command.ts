import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261121144759_session_input_command",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`session_input\` ADD \`command_id\` text;`)
      yield* tx.run(`ALTER TABLE \`session_input\` ADD \`input_fingerprint\` text;`)
      yield* tx.run(
        `CREATE UNIQUE INDEX \`session_input_session_command_idx\` ON \`session_input\` (\`session_id\`,\`command_id\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
