import { useMutation, useQuery, useQueryClient, type QueryKey } from "@tanstack/react-query";
import { useEffect } from "react";
import * as api from "./api";
import { useSupabase } from "./supabase";

export const keys = {
  tickets: (includeClosed: boolean) => ["tickets", { includeClosed }] as const,
  ticket: (id: string) => ["ticket", id] as const,
  events: (id: string) => ["ticket-events", id] as const,
  directory: ["directory"] as const,
  organizations: ["organizations"] as const,
  notifications: (userId: string) => ["notifications", userId] as const,
  shifts: (from: string) => ["shifts", from] as const,
  incidents: ["incidents"] as const,
  patches: ["patches"] as const,
  rcas: ["rcas"] as const,
  reports: ["reports"] as const,
};

export function useTickets(includeClosed: boolean) {
  const supabase = useSupabase();
  return useQuery({
    queryKey: keys.tickets(includeClosed),
    queryFn: () => api.fetchTickets(supabase, { includeClosed }),
  });
}

export function useTicket(id: string) {
  const supabase = useSupabase();
  return useQuery({ queryKey: keys.ticket(id), queryFn: () => api.fetchTicket(supabase, id) });
}

export function useTicketEvents(id: string) {
  const supabase = useSupabase();
  return useQuery({ queryKey: keys.events(id), queryFn: () => api.fetchTicketEvents(supabase, id) });
}

export function useDirectory(enabled = true) {
  const supabase = useSupabase();
  return useQuery({
    queryKey: keys.directory,
    queryFn: () => api.fetchDirectory(supabase),
    staleTime: 5 * 60_000,
    enabled,
  });
}

export function useOrganizations(enabled = true) {
  const supabase = useSupabase();
  return useQuery({
    queryKey: keys.organizations,
    queryFn: () => api.fetchOrganizations(supabase),
    staleTime: 5 * 60_000,
    enabled,
  });
}

export function useMyNotifications(userId: string) {
  const supabase = useSupabase();
  return useQuery({
    queryKey: keys.notifications(userId),
    queryFn: () => api.fetchMyNotifications(supabase, userId),
  });
}

/** Mutación genérica que invalida consultas al terminar. */
export function useAction<TArgs, TResult = unknown>(
  fn: (args: TArgs) => Promise<TResult>,
  invalidate: (args: TArgs) => QueryKey[],
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: async (_data, args) => {
      await Promise.all(invalidate(args).map((queryKey) => queryClient.invalidateQueries({ queryKey })));
    },
  });
}

/** Claves a refrescar cuando cambia un ticket. */
export function ticketKeys(ticketId: string): QueryKey[] {
  return [keys.ticket(ticketId), keys.events(ticketId), ["tickets"]];
}

const REALTIME_TABLES: Array<{ table: string; keys: QueryKey[] }> = [
  { table: "nexo_sd_tickets", keys: [["tickets"], ["ticket"]] },
  { table: "nexo_sd_ticket_events", keys: [["ticket-events"]] },
  { table: "nexo_sd_sla_clocks", keys: [["tickets"], ["ticket"]] },
  { table: "nexo_sd_clock_pauses", keys: [["ticket"], ["tickets"]] },
  { table: "nexo_sd_remote_access_requests", keys: [["ticket"]] },
  { table: "nexo_sd_notifications", keys: [["notifications"]] },
  { table: "nexo_sd_security_incidents", keys: [["incidents"]] },
];

/**
 * Suscripción a Supabase Realtime (postgres_changes): cualquier cambio visible para la
 * persona (la RLS se aplica en el servidor) refresca las listas afectadas.
 */
export function useRealtimeRefresh(enabled: boolean): void {
  const supabase = useSupabase();
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!enabled) return;
    const pending = new Set<string>();
    let timer: number | undefined;
    const flush = () => {
      for (const key of pending)
        void queryClient.invalidateQueries({ queryKey: JSON.parse(key) as QueryKey });
      pending.clear();
      timer = undefined;
    };
    const channel = supabase.channel("nexo-sd-cambios");
    for (const entry of REALTIME_TABLES) {
      channel.on("postgres_changes", { event: "*", schema: "public", table: entry.table }, () => {
        for (const key of entry.keys) pending.add(JSON.stringify(key));
        if (timer === undefined) timer = window.setTimeout(flush, 400);
      });
    }
    channel.subscribe();
    return () => {
      if (timer !== undefined) window.clearTimeout(timer);
      void supabase.removeChannel(channel);
    };
  }, [enabled, supabase, queryClient]);
}
