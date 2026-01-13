import Dispatcher from'undici-types/dispatcher'
import { setGlobalDispatcher, getGlobalDispatcher } from 'undici-types/global-dispatcher'
import { setGlobalOrigin, getGlobalOrigin } from 'undici-types/global-origin'
import Pool from'undici-types/pool'
import { RedirectHandler, DecoratorHandler } from 'undici-types/handlers'

import BalancedPool from 'undici-types/balanced-pool'
import Client from'undici-types/client'
import buildConnector from'undici-types/connector'
import errors from'undici-types/errors'
import Agent from'undici-types/agent'
import MockClient from'undici-types/mock-client'
import MockPool from'undici-types/mock-pool'
import MockAgent from'undici-types/mock-agent'
import mockErrors from'undici-types/mock-errors'
import ProxyAgent from'undici-types/proxy-agent'
import EnvHttpProxyAgent from 'undici-types/env-http-proxy-agent'
import RetryHandler from'undici-types/retry-handler'
import RetryAgent from'undici-types/retry-agent'
import { request, pipeline, stream, connect, upgrade } from 'undici-types/api'
import interceptors from 'undici-types/interceptors'

export * from 'undici-types/util'
export * from 'undici-types/cookies'
export * from 'undici-types/eventsource'
export * from 'undici-types/fetch'
export * from 'undici-types/file'
export * from 'undici-types/filereader'
export * from 'undici-types/formdata'
export * from 'undici-types/diagnostics-channel'
export * from 'undici-types/websocket'
export * from 'undici-types/content-type'
export * from 'undici-types/cache'
export { Interceptable } from 'undici-types/mock-interceptor'

export { Dispatcher, BalancedPool, Pool, Client, buildConnector, errors, Agent, request, stream, pipeline, connect, upgrade, setGlobalDispatcher, getGlobalDispatcher, setGlobalOrigin, getGlobalOrigin, interceptors, MockClient, MockPool, MockAgent, mockErrors, ProxyAgent, EnvHttpProxyAgent, RedirectHandler, DecoratorHandler, RetryHandler, RetryAgent }
export default Undici

declare namespace Undici {
  var Dispatcher: typeof import('undici-types/dispatcher').default
  var Pool: typeof import('undici-types/pool').default;
  var RedirectHandler: typeof import ('undici-types/handlers').RedirectHandler
  var DecoratorHandler: typeof import ('undici-types/handlers').DecoratorHandler
  var RetryHandler: typeof import ('undici-types/retry-handler').default
  var createRedirectInterceptor: typeof import ('undici-types/interceptors').default.createRedirectInterceptor
  var BalancedPool: typeof import('undici-types/balanced-pool').default;
  var Client: typeof import('undici-types/client').default;
  var buildConnector: typeof import('undici-types/connector').default;
  var errors: typeof import('undici-types/errors').default;
  var Agent: typeof import('undici-types/agent').default;
  var setGlobalDispatcher: typeof import('undici-types/global-dispatcher').setGlobalDispatcher;
  var getGlobalDispatcher: typeof import('undici-types/global-dispatcher').getGlobalDispatcher;
  var request: typeof import('undici-types/api').request;
  var stream: typeof import('undici-types/api').stream;
  var pipeline: typeof import('undici-types/api').pipeline;
  var connect: typeof import('undici-types/api').connect;
  var upgrade: typeof import('undici-types/api').upgrade;
  var MockClient: typeof import('undici-types/mock-client').default;
  var MockPool: typeof import('undici-types/mock-pool').default;
  var MockAgent: typeof import('undici-types/mock-agent').default;
  var mockErrors: typeof import('undici-types/mock-errors').default;
  var fetch: typeof import('undici-types/fetch').fetch;
  var Headers: typeof import('undici-types/fetch').Headers;
  var Response: typeof import('undici-types/fetch').Response;
  var Request: typeof import('undici-types/fetch').Request;
  var FormData: typeof import('undici-types/formdata').FormData;
  var File: typeof import('undici-types/file').File;
  var FileReader: typeof import('undici-types/filereader').FileReader;
  var caches: typeof import('undici-types/cache').caches;
  var interceptors: typeof import('undici-types/interceptors').default;
}
