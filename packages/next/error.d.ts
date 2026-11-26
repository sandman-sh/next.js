// Default export is Pages Router only
import Error from './dist/api/error.js'
export * from './dist/api/error.js'
export default Error

export { catchError } from './dist/api/error.js'
export type { ErrorInfo } from './dist/api/error.js'
