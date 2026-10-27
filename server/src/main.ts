// Process entry point: `npm start` (after `npm run build`). Configuration
// comes only from environment variables; see server/README.md.
import { ConfigError } from './config.js'
import { DatabaseNotReadyError } from './db/safety.js'
import { startServer } from './server.js'

try {
  const server = await startServer(process.env)
  const shutdown = (signal: NodeJS.Signals): void => {
    server.app.log.info({ signal }, 'shutting down')
    server.close().catch((err: unknown) => {
      server.app.log.error({ err }, 'shutdown failed')
      process.exitCode = 1
    })
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
} catch (err) {
  process.exitCode = 1
  if (err instanceof ConfigError || err instanceof DatabaseNotReadyError) console.error(err.message)
  else console.error('The server failed to start:', err)
}
