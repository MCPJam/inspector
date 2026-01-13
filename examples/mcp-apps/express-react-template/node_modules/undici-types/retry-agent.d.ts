import Dispatcher from 'undici-types/dispatcher'
import RetryHandler from 'undici-types/retry-handler'

export default RetryAgent

declare class RetryAgent extends Dispatcher {
  constructor(dispatcher: Dispatcher, options?: RetryHandler.RetryOptions)
}
