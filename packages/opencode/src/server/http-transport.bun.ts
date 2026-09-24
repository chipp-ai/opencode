import type { Server, ServerWebSocket, WebSocketHandler } from "bun"
import { Context, Effect, Fiber, Latch, Layer, Option, Scope, Stream } from "effect"
import {
  HttpBody,
  HttpEffect,
  HttpServer,
  HttpServerError,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http"
import { Socket } from "effect/unstable/socket"
import { ListenerServer } from "./listener-server"

// Serves the Effect HTTP app with `Bun.serve` instead of `NodeHttpServer`.
// Bun's `node:http` shim (1.3.x) never reports a client abort or half-close on
// a streaming response, so SSE request fibers and their sockets stayed alive
// forever. `Bun.serve` fires `request.signal` and cancels the response body
// stream, which interrupts the request and stream fibers.

// Idle keep-alive connections are reaped after this long. In-flight requests
// opt out (see `fetch` below) so long-running handlers and quiet SSE streams are
// never cut off; the timeout is restored once the response body finishes.
const IDLE_TIMEOUT_SECONDS = 30

type SocketData = { readonly socket: WebSocketAdapter }
type BunServer = Server<SocketData>
type Pending = { readonly resolve: (response: Response | undefined) => void; readonly finish: () => void }

export function layer(opts: { port: number; hostname: string }) {
  return Layer.effectContext(
    Effect.gen(function* () {
      const server = yield* make(opts)
      return Context.make(HttpServer.HttpServer, server.http).pipe(
        Context.add(
          ListenerServer.Service,
          ListenerServer.Service.of({ closeAll: Effect.promise(() => server.bun.stop(true)) }),
        ),
      )
    }),
  )
}

const make = Effect.fnUntraced(function* (opts: { port: number; hostname: string }) {
  const scope = yield* Effect.scope
  const bun = yield* Effect.try({
    try: () =>
      Bun.serve<SocketData>({
        hostname: opts.hostname,
        port: opts.port,
        idleTimeout: IDLE_TIMEOUT_SECONDS,
        fetch: notReady,
        websocket,
      }),
    catch: (cause) => new HttpServerError.ServeError({ cause }),
  })
  // Always stop with `closeActiveConnections`. A graceful `stop()` keeps idle
  // keep-alive sockets serving requests, and on Bun 1.3.14 a later `stop(true)`
  // never settles while a graceful stop is pending. The serve scope below drains
  // and interrupts requests before this runs.
  yield* Scope.addFinalizer(
    scope,
    Effect.promise(() => bun.stop(true)).pipe(Effect.timeoutOrElse({ duration: "1 second", orElse: () => Effect.void })),
  )

  return {
    bun,
    http: HttpServer.make({
      address: { _tag: "TcpAddress", hostname: bun.hostname ?? opts.hostname, port: bun.port ?? opts.port },
      serve: Effect.fnUntraced(function* (httpApp, middleware) {
        const parent = yield* Effect.fiber
        const serveScope = yield* Effect.scope
        const requestScope = Scope.forkUnsafe(serveScope, "parallel")
        const active = new Set<Request>()
        const drained = Latch.makeUnsafe(true)
        // Finalizers run in reverse, so in-flight requests get this graceful
        // window before `requestScope` interrupts them, matching NodeHttpServer.
        yield* Scope.addFinalizer(
          serveScope,
          Effect.sync(() => bun.reload({ fetch: notReady, websocket })).pipe(
            Effect.andThen(drained.await),
            Effect.timeoutOrElse({ duration: "1 second", orElse: () => Effect.void }),
          ),
        )
        const pending = new WeakMap<object, Pending>()
        const handled = HttpEffect.toHandled(
          httpApp,
          (request, response) =>
            Effect.withFiber((fiber) => {
              const entry = pending.get(request.source)
              if (!entry) return Effect.void
              pending.delete(request.source)
              entry.resolve(toWebResponse(request, response, fiber.context, requestScope, entry.finish))
              return Effect.void
            }),
          middleware,
        )

        bun.reload({
          websocket,
          fetch(source, server) {
            server.timeout(source, 0)
            active.add(source)
            drained.closeUnsafe()
            const finish = (restoreIdleTimeout: boolean) => {
              if (!active.delete(source)) return
              if (restoreIdleTimeout) server.timeout(source, IDLE_TIMEOUT_SECONDS)
              if (active.size === 0) drained.openUnsafe()
            }
            return new Promise<Response | undefined>((resolve) => {
              pending.set(source, { resolve, finish: () => finish(true) })
              const settle = (response: Response | undefined) => {
                if (!pending.delete(source)) return
                resolve(response)
                finish(response !== undefined)
              }
              const services = new Map(parent.context.mapUnsafe)
              services.set(HttpServerRequest.HttpServerRequest.key, serverRequest(source, server, () => settle(undefined)))
              const fiber = Fiber.runIn(
                Effect.runForkWith(Context.makeUnsafe<HttpServerRequest.HttpServerRequest>(services))(handled),
                requestScope,
              )
              // Normally the response handler above settles the request. This only
              // fires if the fiber ended first, e.g. interrupted before it started.
              fiber.addObserver(() => settle(new Response(undefined, { status: 503 })))
              source.signal.addEventListener(
                "abort",
                () => {
                  fiber.interruptUnsafe(parent.id, HttpServerError.ClientAbort.annotation)
                  // A body stream that Bun never started pulling never runs its
                  // completion hook, so release the request here too.
                  finish(false)
                },
                { once: true },
              )
            })
          },
        })
      }),
    }),
  }
})

// `reload` replaces every handler, so each call passes these again.
const websocket: WebSocketHandler<SocketData> = {
  open: (ws) => ws.data.socket.attach(ws),
  message: (ws, message) => ws.data.socket.receive(message),
  close: (ws, code, reason) => ws.data.socket.closed(code, reason),
}

function notReady() {
  return new Response("server not ready", { status: 503 })
}

function toWebResponse(
  request: HttpServerRequest.HttpServerRequest,
  response: HttpServerResponse.HttpServerResponse,
  context: Context.Context<never>,
  scope: Scope.Scope,
  done: () => void,
) {
  // HEAD skips the body, so keep the request scope owned by the request fiber
  // instead of transferring it to a stream that is never consumed.
  if (request.method === "HEAD") {
    done()
    return HttpServerResponse.toWeb(response, { withoutBody: true })
  }
  const transferred = HttpEffect.scopeTransferToStream(response)
  const body = transferred.body
  if (body._tag !== "Stream") {
    done()
    return HttpServerResponse.toWeb(transferred)
  }
  // The body runs on its own fiber once Bun pulls it. Tie that fiber to the
  // listener scope so shutdown interrupts open streams.
  const stream = Stream.unwrap(
    Effect.withFiber((fiber) => {
      Fiber.runIn(fiber, scope)
      return Effect.succeed(body.stream)
    }),
  ).pipe(Stream.ensuring(Effect.sync(done)))
  return HttpServerResponse.toWeb(
    HttpServerResponse.setBody(transferred, HttpBody.stream(stream, body.contentType, body.contentLength)),
    { context },
  )
}

function serverRequest(
  source: Request,
  server: BunServer,
  onUpgrade: () => void,
): HttpServerRequest.HttpServerRequest {
  const base = HttpServerRequest.fromWeb(source).modify({
    remoteAddress: Option.fromNullishOr(server.requestIP(source)?.address),
  })
  return withUpgrade(base, source, server, onUpgrade)
}

// `HttpServerRequest.fromWeb` cannot upgrade, so route `upgrade` to Bun's native
// WebSocket upgrade and keep every other member. `modify` is re-wrapped because
// router prefixes and middleware can replace the request before a WebSocket
// route reads it.
function withUpgrade(
  base: HttpServerRequest.HttpServerRequest,
  source: Request,
  server: BunServer,
  onUpgrade: () => void,
): HttpServerRequest.HttpServerRequest {
  const request: HttpServerRequest.HttpServerRequest = new Proxy(base, {
    get(target, prop) {
      if (prop === "upgrade") return upgrade
      if (prop === "modify")
        return (options: Parameters<HttpServerRequest.HttpServerRequest["modify"]>[0]) =>
          withUpgrade(target.modify(options), source, server, onUpgrade)
      return Reflect.get(target, prop, target)
    },
  })
  const upgrade = Effect.suspend(() => {
    const socket = new WebSocketAdapter()
    if (!server.upgrade(source, { data: { socket } }))
      return Effect.fail(
        new HttpServerError.HttpServerError({
          reason: new HttpServerError.RequestParseError({ request, description: "Not an upgradeable ServerRequest" }),
        }),
      )
    // Resolve Bun's fetch promise now; the route keeps running for the life of
    // the socket and its eventual response is ignored.
    onUpgrade()
    return Socket.fromWebSocket(
      // Socket.fromWebSocket only uses the EventTarget, send, close, and
      // readyState members of the WebSocket interface, which the adapter provides.
      Effect.acquireRelease(Effect.succeed(socket as unknown as globalThis.WebSocket), (ws) =>
        Effect.sync(() => ws.close()),
      ),
    )
  })
  return request
}

// Bridges Bun's callback-based ServerWebSocket to the EventTarget WebSocket
// surface `Socket.fromWebSocket` consumes. Frames that arrive before the route
// starts reading are buffered instead of dropped.
class WebSocketAdapter extends EventTarget {
  readyState = 0
  #native: ServerWebSocket<SocketData> | undefined
  #buffer: Array<string | Uint8Array> | undefined = []
  #closeEvent: CloseEvent | undefined

  attach(native: ServerWebSocket<SocketData>) {
    this.#native = native
    this.readyState = 1
    this.dispatchEvent(new Event("open"))
  }

  receive(message: string | Buffer) {
    const data = typeof message === "string" ? message : new Uint8Array(message)
    if (this.#buffer) {
      this.#buffer.push(data)
      return
    }
    this.dispatchEvent(new MessageEvent("message", { data }))
  }

  closed(code: number, reason: string) {
    this.readyState = 3
    this.#closeEvent = new CloseEvent("close", { code, reason, wasClean: code === 1000 })
    this.dispatchEvent(this.#closeEvent)
  }

  override addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions,
  ) {
    super.addEventListener(type, listener, options)
    // The peer can disconnect before the route starts reading. Replay the close
    // to late listeners, otherwise `Socket.fromWebSocket` waits for an "open"
    // that already happened and fails with an open timeout.
    if (type === "close" && this.#closeEvent && listener) {
      if (typeof listener === "function") listener.call(this, this.#closeEvent)
      if (typeof listener !== "function") listener.handleEvent(this.#closeEvent)
      return
    }
    if (type !== "message" || !this.#buffer) return
    const buffered = this.#buffer
    this.#buffer = undefined
    buffered.forEach((data) => this.dispatchEvent(new MessageEvent("message", { data })))
  }

  send(data: string | Uint8Array) {
    this.#native?.send(data)
  }

  close(code?: number, reason?: string) {
    this.#native?.close(code, reason)
  }
}

export * as HttpTransport from "./http-transport.bun"
