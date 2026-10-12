// `cloudflare:workers` dist entry: the shim module on its own.
export {
  DurableObject,
  env,
  RpcTarget,
  waitUntil,
  WebSocketPair,
  WorkerEntrypoint,
} from "./workers-shim.ts";
