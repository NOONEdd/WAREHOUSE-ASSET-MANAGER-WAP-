// Entry point for `npm run owner -- <command>` (after `npm run build`).
import { runOwnerCli } from './owner.js'

process.exitCode = await runOwnerCli(process.argv.slice(2), process.env, {
  out: (line) => {
    console.log(line)
  },
  err: (line) => {
    console.error(line)
  }
})
