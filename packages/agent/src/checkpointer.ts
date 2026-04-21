import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { resolve4 } from "node:dns/promises";

// WSL2 has no IPv6 routes. Try to resolve the hostname to an IPv4 address so
// the pg client doesn't attempt an IPv6 connection. If resolve4 fails (host
// has no A record — e.g. Supabase direct connections are IPv6-only on new
// projects), fall back and let pg fail with a clear error. In that case set
// DATABASE_URL to the Supabase Session-mode pooler URL (port 5432 on
// aws-0-*.pooler.supabase.com), which has IPv4 support.
async function toIPv4ConnString(connStr: string): Promise<string> {
  try {
    const url = new URL(connStr);
    const [ipv4] = await resolve4(url.hostname);
    url.hostname = ipv4;
    return url.toString();
  } catch {
    return connStr;
  }
}

let _saver: PostgresSaver | null = null;

export async function getCheckpointer() {
  if (!_saver) {
    const connStr = await toIPv4ConnString(process.env.DATABASE_URL!);
    _saver = PostgresSaver.fromConnString(connStr);
    await _saver.setup();
  }
  return _saver;
}
