// Entry point for `npm run owner -- <command>` (after `npm run build`).
import { installFatalErrorHandlers, safeErrorLine } from '../logPrivacy.js'
import { runOwnerCli } from './owner.js'

// An unexpected error is reported as its summary only, never as the whole object (finding NF-1).
installFatalErrorHandlers({
  on: (event, listener) => process.on(event, listener),
  write: (line) => process.stderr.write(`${line}\n`),
  exit: (code) => process.exit(code)
})

try {
  process.exitCode = await runOwnerCli(process.argv.slice(2), process.env, {
    out: (line) => {
      console.log(line)
    },
    err: (line) => {
      console.error(line)
    }
  })
} catch (err) {
  console.error(safeErrorLine('the owner command failed unexpectedly', err))
  process.exitCode = 1
}
