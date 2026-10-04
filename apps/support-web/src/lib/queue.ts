// Orden de la bandeja de Yago.
import { nextDue } from "./sla";
import type { Severity, TicketWithClocks } from "./types";

export type SortKey = "vencimiento" | "severidad" | "recepcion";

const SEVERITY_RANK: Record<Severity, number> = { S1: 1, S2: 2, S3: 3, S4: 4 };

export function sortQueue(tickets: TicketWithClocks[], sort: SortKey): TicketWithClocks[] {
  const copy = [...tickets];
  if (sort === "severidad") {
    return copy.sort(
      (a, b) =>
        SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || a.created_at.localeCompare(b.created_at),
    );
  }
  if (sort === "recepcion") return copy.sort((a, b) => b.created_at.localeCompare(a.created_at));
  // Por vencimiento: primero el plazo en curso más próximo; los que no tienen plazos corriendo, al final.
  return copy.sort((a, b) => {
    const da = nextDue(a.clocks);
    const db = nextDue(b.clocks);
    if (da && db) return da.localeCompare(db);
    if (da) return -1;
    if (db) return 1;
    return SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
  });
}
