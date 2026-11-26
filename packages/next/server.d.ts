import type { AsyncLocalStorage as NodeAsyncLocalStorage } from 'async_hooks'

declare global {
  var AsyncLocalStorage: typeof NodeAsyncLocalStorage
}

export { NextFetchEvent } from './dist/server/web/spec-extension/fetch-event.js'
export { NextRequest } from './dist/server/web/spec-extension/request.js'
export { NextResponse } from './dist/server/web/spec-extension/response.js'
export {
  NextMiddleware,
  MiddlewareConfig,
  NextProxy,
  ProxyConfig,
} from './dist/server/web/types.js'
export { userAgentFromString } from './dist/server/web/spec-extension/user-agent.js'
export { userAgent } from './dist/server/web/spec-extension/user-agent.js'
export { URLPattern } from './dist/compiled/@edge-runtime/primitives/url.js'
export { ImageResponse } from './dist/server/web/spec-extension/image-response.js'
export type { ImageResponseOptions } from './dist/compiled/@vercel/og/types.js'
export { after } from './dist/server/after.js'
export { connection } from './dist/server/request/connection.js'
