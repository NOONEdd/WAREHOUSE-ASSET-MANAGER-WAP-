// Entry point for `npm run db:migrate -- <command>` (after `npm run build`).
import { runMigrateCli } from './migrate.js'

process.exitCode = await runMigrateCli(process.argv.slice(2), process.env, {
  out: (line) => {
    console.log(line)
  },
  err: (line) => {
    console.error(line)
  }
})
