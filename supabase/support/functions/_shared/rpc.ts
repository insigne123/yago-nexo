// Interfaz mínima de cliente RPC (la cumple SupabaseClient y la imitan las pruebas).

export interface RpcError {
  message: string;
  code?: string;
}

export interface RpcResult<T> {
  data: T | null;
  error: RpcError | null;
}

export interface RpcClient {
  rpc<T = unknown>(fn: string, args?: Record<string, unknown>): PromiseLike<RpcResult<T>>;
}

/** Ejecuta una RPC y lanza un error legible si falla. */
export async function callRpc<T>(client: RpcClient, fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await client.rpc<T>(fn, args);
  if (error) throw new Error(`${fn}: ${error.message}`);
  return data as T;
}
