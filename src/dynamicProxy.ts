import { Server as ProxyChainServer } from "proxy-chain";

export interface ProxySettings {
  server: string;
  username?: string;
  password?: string;
}

export class DynamicProxy {
  private upstream: ProxySettings | null = null;
  private server: ProxyChainServer;
  private _url!: string;
  private _port!: number;
  private constructor(server: ProxyChainServer) {
    this.server = server;
  }

  static async start(port?: number): Promise<DynamicProxy> {
    let instance: DynamicProxy; // declared for closure capture
    const server: ProxyChainServer = new ProxyChainServer({
      port: port || 0,
      prepareRequestFunction: async (): Promise<any> => {
        if (!instance.upstream) return {};
        let url: string = instance.upstream.server.startsWith("http")
          ? instance.upstream.server
          : `http://${instance.upstream.server}`;
        if (instance.upstream.username && instance.upstream.password) {
          try {
            const u = new URL(url);
            u.username = instance.upstream.username;
            u.password = instance.upstream.password;
            url = u.toString();
          } catch {}
        }
        return { upstreamProxyUrl: url } as any;
      },
    });
    instance = new DynamicProxy(server);
    await server.listen();
    const address = server.server.address();
    const resolvedPort = typeof address === "object" && address ? (address as any).port : port || 8000;
    instance._port = resolvedPort;
    instance._url = `http://127.0.0.1:${resolvedPort}`;
    return instance;
  }

  get url(): string { return this._url; }
  get port(): number { return this._port; }

  async setUpstream(proxy: ProxySettings | null): Promise<void> {
    this.upstream = proxy;
  }

  currentUpstream(): ProxySettings | null {
    return this.upstream;
  }

  async close(): Promise<void> {
    try { await this.server.close(true); } catch {}
  }
}

export async function startDynamicProxy(port?: number): Promise<DynamicProxy> {
  return DynamicProxy.start(port);
}
