import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260922225329_little_darkstar",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`workflow_run\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text,
          \`directory\` text NOT NULL,
          \`name\` text NOT NULL,
          \`status\` text NOT NULL,
          \`journal\` text NOT NULL,
          \`result\` text,
          \`error\` text,
          \`resume_of\` text,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
    })
  },
} satisfies DatabaseMigration.Migration
