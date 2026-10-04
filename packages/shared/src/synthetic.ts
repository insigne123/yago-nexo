/**
 * Datos sintéticos para pruebas y demostraciones (BT-056). Nunca se usan datos productivos.
 * Generador determinista por semilla para que las pruebas sean reproducibles.
 */

export function rutDv(body: number): string {
  let sum = 0;
  let mul = 2;
  for (let n = body; n > 0; n = Math.floor(n / 10)) {
    sum += (n % 10) * mul;
    mul = mul === 7 ? 2 : mul + 1;
  }
  const r = 11 - (sum % 11);
  return r === 11 ? "0" : r === 10 ? "K" : String(r);
}

export function formatRut(body: number): string {
  const s = String(body).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${s}-${rutDv(body)}`;
}

export function isValidRut(rut: string): boolean {
  const clean = rut.replace(/\./g, "").toUpperCase();
  const m = /^(\d{1,8})-([\dK])$/.exec(clean);
  if (!m) return false;
  return rutDv(Number(m[1])) === m[2];
}

/** PRNG mulberry32: rápido, determinista y suficiente para datos de prueba. */
export function seededRandom(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let x = Math.imul(t ^ (t >>> 15), 1 | t);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

const NOMBRES = ["Ana", "Luis", "Carla", "Pedro", "Valentina", "Diego", "Camila", "Matías", "Fernanda", "Tomás"];
const APELLIDOS = ["Rojas", "Muñoz", "Soto", "Contreras", "Silva", "Pérez", "Vargas", "Fuentes", "Torres", "Reyes"];
const EMPRESAS = ["Telecom Andina", "Red Austral", "Fibra Pacífico", "Enlace Norte", "Conecta Sur", "Satelital Chile"];
const SERVICIOS = ["Telefonía fija", "Telefonía móvil", "Internet", "Televisión de pago", "Transmisión de datos"];
const REGIONES = ["Arica y Parinacota", "Antofagasta", "Coquimbo", "Valparaíso", "Metropolitana", "Biobío", "Los Lagos", "Magallanes"];

export interface SyntheticPerson {
  rut: string;
  nombre: string;
  email: string;
  telefono: string;
}

export interface SyntheticConcession {
  id: string;
  empresa: string;
  rutEmpresa: string;
  servicio: string;
  region: string;
  estado: "vigente" | "en_tramite" | "caducada";
  fechaOtorgamiento: string;
}

export class SyntheticData {
  private readonly rnd: () => number;
  constructor(seed = 42) {
    this.rnd = seededRandom(seed);
  }

  private pick<T>(list: readonly T[]): T {
    return list[Math.floor(this.rnd() * list.length)]!;
  }

  private int(min: number, max: number): number {
    return min + Math.floor(this.rnd() * (max - min + 1));
  }

  person(): SyntheticPerson {
    const nombre = `${this.pick(NOMBRES)} ${this.pick(APELLIDOS)}`;
    const body = this.int(5_000_000, 25_000_000);
    const user = nombre.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, ".");
    return {
      rut: formatRut(body),
      nombre,
      email: `${user}@ejemplo.invalid`,
      telefono: `+569${this.int(10_000_000, 99_999_999)}`,
    };
  }

  concession(index: number): SyntheticConcession {
    const year = this.int(2005, 2025);
    const month = String(this.int(1, 12)).padStart(2, "0");
    const day = String(this.int(1, 28)).padStart(2, "0");
    const estados = ["vigente", "vigente", "vigente", "en_tramite", "caducada"] as const;
    return {
      id: `CON-${String(index).padStart(6, "0")}`,
      empresa: this.pick(EMPRESAS),
      rutEmpresa: formatRut(this.int(76_000_000, 77_999_999)),
      servicio: this.pick(SERVICIOS),
      region: this.pick(REGIONES),
      estado: this.pick(estados),
      fechaOtorgamiento: `${year}-${month}-${day}`,
    };
  }

  concessions(count: number): SyntheticConcession[] {
    return Array.from({ length: count }, (_, i) => this.concession(i + 1));
  }
}
