// Type-only ambient declaration for the `cloudflare:sockets` platform module.
// Dev-time only: nothing imports this file, so it never ships in the deployed
// bundle (the runner embeds `worker.ts` plus `src/`).
declare module "cloudflare:sockets" {
  interface SocketAddress {
    hostname: string;
    port: number;
  }

  interface SocketOptions {
    secureTransport?: "off" | "on" | "starttls";
    allowHalfOpen?: boolean;
  }

  interface Socket {
    readonly readable: ReadableStream<Uint8Array>;
    readonly writable: WritableStream<Uint8Array>;
    close: () => Promise<void>;
    startTls: (options?: { expectedServerHostname?: string }) => Socket;
  }

  function connect(address: SocketAddress, options?: SocketOptions): Socket;
}
