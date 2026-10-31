// Process entry point: `npm start` (after `npm run build`). Configuration
// comes only from environment variables; see server/README.md.
import { ConfigError } from './config.js'
import { DatabaseNotReadyError } from './db/safety.js'
import { installFatalErrorHandlers, safeErrorLine, safeErrorSummary } from './logPrivacy.js'
import { startServer } from './server.js'

// Node's default handlers print a whole error object, a database error's row values included (finding NF-1).
installFatalErrorHandlers({
  on: (event, listener) => process.on(event, listener),
  write: (line) => process.stderr.write(`${line}\n`),
  exit: (code) => process.exit(code)
})

try {
  const server = await startServer(process.env)
  const shutdown = (signal: NodeJS.Signals): void => {
    server.app.log.info({ signal }, 'shutting down')
    server.close().catch((err: unknown) => {
      server.app.log.error({ err: safeErrorSummary(err) }, 'shutdown failed')
      process.exitCode = 1
    })
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
} catch (err) {
  process.exitCode = 1
  if (err instanceof ConfigError || err instanceof DatabaseNotReadyError) console.error(err.message)
  else console.error(safeErrorLine('the server failed to start', err))
}
