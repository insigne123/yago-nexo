/** Almacén de avisos (toasts) usable desde componentes y desde el manejo global de errores. */

export type ToastVariant = "success" | "error" | "info" | "warning";

export interface ToastItem {
  id: number;
  title: string;
  description?: string;
  variant: ToastVariant;
}

const DURATION_MS: Record<ToastVariant, number> = { success: 5000, info: 6000, warning: 8000, error: 9000 };

let items: readonly ToastItem[] = [];
let nextId = 1;
const listeners = new Set<() => void>();
const recent = new Map<string, number>();

function emit(): void {
  for (const listener of listeners) listener();
}

export const toastStore = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  getSnapshot(): readonly ToastItem[] {
    return items;
  },
  push(input: Omit<ToastItem, "id">): number {
    // Evita repetir el mismo aviso (por ejemplo varias consultas con el mismo 403).
    const key = `${input.variant}|${input.title}|${input.description ?? ""}`;
    const now = Date.now();
    const last = recent.get(key);
    if (last !== undefined && now - last < 4000) return -1;
    recent.set(key, now);
    const id = nextId++;
    items = [...items, { ...input, id }].slice(-5);
    emit();
    if (typeof window !== "undefined") {
      window.setTimeout(() => toastStore.dismiss(id), DURATION_MS[input.variant]);
    }
    return id;
  },
  dismiss(id: number): void {
    const next = items.filter((t) => t.id !== id);
    if (next.length !== items.length) {
      items = next;
      emit();
    }
  },
  clear(): void {
    items = [];
    recent.clear();
    emit();
  },
};

export const toast = {
  success: (title: string, description?: string) =>
    toastStore.push({ title, description, variant: "success" }),
  error: (title: string, description?: string) => toastStore.push({ title, description, variant: "error" }),
  info: (title: string, description?: string) => toastStore.push({ title, description, variant: "info" }),
  warning: (title: string, description?: string) =>
    toastStore.push({ title, description, variant: "warning" }),
};
