import { useQuery } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import {
  Alert,
  Button,
  Card,
  EmptyState,
  PageTitle,
  SelectField,
  Spinner,
  TextField,
} from "../../components/ui";
import { deleteShift, fetchShifts, saveShift } from "../../lib/api";
import { formatDate, formatTime, fromDatetimeLocal, toDatetimeLocal } from "../../lib/format";
import { keys, useDirectory } from "../../lib/queries";
import { friendlyError, useSupabase } from "../../lib/supabase";
import type { OncallShiftRow } from "../../lib/types";
import { useRunAction } from "../../lib/useAction";
import { useNow } from "../../lib/useNow";

const LEVELS: Array<{ level: 1 | 2 | 3; label: string }> = [
  { level: 1, label: "Nivel 1 · primer contacto y acuse" },
  { level: 2, label: "Nivel 2 · técnico de turno" },
  { level: 3, label: "Nivel 3 · seguridad y supervisión" },
];

function startOfWeek(date: Date): Date {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  const day = (d.getDay() + 6) % 7; // lunes = 0
  d.setDate(d.getDate() - day);
  return d;
}

function addDays(date: Date, days: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

interface FormState {
  id?: string;
  userId: string;
  level: string;
  start: string;
  end: string;
  notes: string;
}

function emptyForm(weekStart: Date): FormState {
  const start = new Date(weekStart);
  start.setHours(9, 0, 0, 0);
  return {
    userId: "",
    level: "1",
    start: toDatetimeLocal(start),
    end: toDatetimeLocal(addDays(start, 7)),
    notes: "",
  };
}

/** Calendario de turnos: cadena de escalamiento nivel 1 -> 2 -> 3. */
export function OnCallPage() {
  const supabase = useSupabase();
  const now = useNow(60_000);
  const { data: people = [] } = useDirectory();
  const staff = people.filter((p) => p.is_staff);
  const [weekStart, setWeekStart] = useState(() => startOfWeek(new Date()));
  const weekEnd = addDays(weekStart, 7);
  const shiftsKey = keys.shifts(weekStart.toISOString());
  const shifts = useQuery({ queryKey: shiftsKey, queryFn: () => fetchShifts(supabase, weekStart, weekEnd) });
  const action = useRunAction([["shifts"]]);
  const [form, setForm] = useState<FormState>(() => emptyForm(weekStart));

  const nameOf = (userId: string) =>
    people.find((p) => p.user_id === userId)?.display_name ?? "Persona sin membresía";
  const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
  const rows = shifts.data ?? [];
  const current = LEVELS.map(({ level }) => ({
    level,
    people: rows
      .filter((s) => s.level === level && new Date(s.starts_at) <= now && new Date(s.ends_at) > now)
      .map((s) => nameOf(s.user_id)),
  }));

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    const startsAt = fromDatetimeLocal(form.start);
    const endsAt = fromDatetimeLocal(form.end);
    if (!form.userId || !startsAt || !endsAt) return;
    const ok = await action.run(
      () =>
        saveShift(
          supabase,
          {
            user_id: form.userId,
            level: Number(form.level),
            starts_at: startsAt,
            ends_at: endsAt,
            notes: form.notes.trim() || null,
          },
          form.id,
        ),
      form.id ? "Turno actualizado." : "Turno agregado.",
    );
    if (ok) setForm(emptyForm(weekStart));
  }

  function edit(shift: OncallShiftRow) {
    setForm({
      id: shift.id,
      userId: shift.user_id,
      level: String(shift.level),
      start: toDatetimeLocal(shift.starts_at),
      end: toDatetimeLocal(shift.ends_at),
      notes: shift.notes ?? "",
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <PageTitle description="Si nadie cubre un nivel, los avisos van a los supervisores. Los S1 sin acuse escalan cada 10 minutos.">
        Turnos
      </PageTitle>
      <Card title="De turno ahora">
        <ul className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-3">
          {current.map((c) => (
            <li key={c.level} className="rounded-md bg-slate-50 p-2">
              <div className="font-semibold">{LEVELS[c.level - 1]?.label}</div>
              <div>{c.people.length ? c.people.join(", ") : "Sin turno (avisa a supervisión)"}</div>
            </li>
          ))}
        </ul>
      </Card>

      <Card
        title={`Semana del ${formatDate(weekStart)} al ${formatDate(addDays(weekStart, 6))}`}
        actions={
          <div className="flex gap-2">
            <Button variant="secundario" onClick={() => setWeekStart(addDays(weekStart, -7))}>
              Semana anterior
            </Button>
            <Button variant="secundario" onClick={() => setWeekStart(startOfWeek(new Date()))}>
              Hoy
            </Button>
            <Button variant="secundario" onClick={() => setWeekStart(addDays(weekStart, 7))}>
              Semana siguiente
            </Button>
          </div>
        }
      >
        {shifts.isLoading ? <Spinner label="Cargando turnos" /> : null}
        {shifts.error ? <Alert>{friendlyError(shifts.error)}</Alert> : null}
        {!shifts.isLoading && rows.length === 0 ? <EmptyState>No hay turnos esta semana.</EmptyState> : null}
        {rows.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <caption className="sr-only">Turnos por día y nivel</caption>
              <thead className="text-left text-xs font-semibold uppercase text-slate-600">
                <tr>
                  <th scope="col" className="px-2 py-1">
                    Día
                  </th>
                  {LEVELS.map((l) => (
                    <th key={l.level} scope="col" className="px-2 py-1">
                      Nivel {l.level}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {days.map((day) => {
                  const dayEnd = addDays(day, 1);
                  return (
                    <tr key={day.toISOString()} className="align-top">
                      <th scope="row" className="whitespace-nowrap px-2 py-2 text-left font-medium">
                        {new Intl.DateTimeFormat("es-CL", {
                          weekday: "long",
                          day: "2-digit",
                          month: "2-digit",
                        }).format(day)}
                      </th>
                      {LEVELS.map(({ level }) => (
                        <td key={level} className="px-2 py-2">
                          {rows
                            .filter(
                              (s) =>
                                s.level === level &&
                                new Date(s.starts_at) < dayEnd &&
                                new Date(s.ends_at) > day,
                            )
                            .map((s) => (
                              <div key={s.id} className="mb-1 rounded bg-blue-50 px-2 py-1">
                                <div className="font-medium">{nameOf(s.user_id)}</div>
                                <div className="text-xs text-slate-600">
                                  {formatDate(s.starts_at)} {formatTime(s.starts_at)} –{" "}
                                  {formatDate(s.ends_at)} {formatTime(s.ends_at)}
                                </div>
                                <div className="flex gap-1">
                                  <Button
                                    variant="fantasma"
                                    className="px-1 py-0 text-xs"
                                    onClick={() => edit(s)}
                                  >
                                    Editar
                                  </Button>
                                  <Button
                                    variant="fantasma"
                                    className="px-1 py-0 text-xs text-red-700"
                                    onClick={() => {
                                      if (window.confirm(`¿Eliminar el turno de ${nameOf(s.user_id)}?`)) {
                                        void action.run(
                                          () => deleteShift(supabase, s.id),
                                          "Turno eliminado.",
                                        );
                                      }
                                    }}
                                  >
                                    Eliminar
                                  </Button>
                                </div>
                              </div>
                            ))}
                        </td>
                      ))}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : null}
      </Card>

      <Card title={form.id ? "Editar turno" : "Agregar turno"}>
        <form onSubmit={onSubmit} className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <SelectField
            label="Persona"
            value={form.userId}
            onChange={(e) => setForm({ ...form, userId: e.target.value })}
            required
          >
            <option value="">Seleccione…</option>
            {staff.map((p) => (
              <option key={`${p.user_id}-${p.org_id}`} value={p.user_id}>
                {p.display_name}
              </option>
            ))}
          </SelectField>
          <SelectField
            label="Nivel"
            value={form.level}
            onChange={(e) => setForm({ ...form, level: e.target.value })}
          >
            {LEVELS.map((l) => (
              <option key={l.level} value={l.level}>
                {l.label}
              </option>
            ))}
          </SelectField>
          <TextField
            label="Inicio"
            type="datetime-local"
            value={form.start}
            onChange={(e) => setForm({ ...form, start: e.target.value })}
            required
          />
          <TextField
            label="Término"
            type="datetime-local"
            value={form.end}
            onChange={(e) => setForm({ ...form, end: e.target.value })}
            required
          />
          <div className="sm:col-span-2">
            <TextField
              label="Notas"
              value={form.notes}
              onChange={(e) => setForm({ ...form, notes: e.target.value })}
              maxLength={500}
            />
          </div>
          <div className="flex gap-2 sm:col-span-2">
            <Button type="submit" disabled={action.busy || !form.userId}>
              {form.id ? "Guardar cambios" : "Agregar turno"}
            </Button>
            {form.id ? (
              <Button variant="secundario" onClick={() => setForm(emptyForm(weekStart))}>
                Cancelar
              </Button>
            ) : null}
          </div>
        </form>
        <div className="mt-2">
          {action.error ? <Alert>{action.error}</Alert> : null}
          {action.ok ? <Alert tone="exito">{action.ok}</Alert> : null}
        </div>
      </Card>
    </div>
  );
}
