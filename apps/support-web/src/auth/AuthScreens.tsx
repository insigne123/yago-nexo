import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { z } from "zod";
import { Alert, Button, Spinner, TextField } from "../components/ui";
import { friendlyError, useRuntimeConfig, useSupabase } from "../lib/supabase";
import { useAuth } from "./session";

function AuthFrame({ title, children }: { title: string; children: ReactNode }) {
  const config = useRuntimeConfig();
  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-10">
      <div className="w-full max-w-md rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
        <p className="text-xs font-semibold uppercase tracking-wide text-blue-800">
          Mesa de soporte Nexo · <span className="text-slate-600">{config.environmentLabel}</span>
        </p>
        <h1 className="mt-1 mb-4 text-xl font-bold text-slate-900">{title}</h1>
        {children}
      </div>
    </main>
  );
}

const loginSchema = z.object({
  email: z.email({ error: "Ingrese un correo válido" }),
  password: z.string().min(8, "La contraseña tiene al menos 8 caracteres"),
});

export function LoginPage() {
  const supabase = useSupabase();
  const { error: authError } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    const parsed = loginSchema.safeParse({ email: email.trim(), password });
    if (!parsed.success) {
      setErrors(Object.fromEntries(parsed.error.issues.map((i) => [String(i.path[0]), i.message])));
      return;
    }
    setErrors({});
    setError(null);
    setBusy(true);
    const { error: signInError } = await supabase.auth.signInWithPassword(parsed.data);
    setBusy(false);
    if (signInError) {
      setError(
        /invalid login credentials/i.test(signInError.message)
          ? "Correo o contraseña incorrectos."
          : friendlyError(signInError),
      );
    }
  }

  return (
    <AuthFrame title="Ingresar">
      <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
        {error || authError ? <Alert>{error ?? authError}</Alert> : null}
        <TextField
          label="Correo electrónico"
          type="email"
          autoComplete="username"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          error={errors["email"]}
          required
        />
        <TextField
          label="Contraseña"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          error={errors["password"]}
          required
        />
        <Button type="submit" disabled={busy}>
          {busy ? "Ingresando…" : "Ingresar"}
        </Button>
        <p className="text-xs text-slate-600">
          El acceso exige un segundo factor (aplicación de autenticación TOTP). Si no tiene cuenta, pídala a
          Yago.
        </p>
      </form>
    </AuthFrame>
  );
}

const codeSchema = z.string().regex(/^\d{6}$/, "El código tiene 6 dígitos");

function CodeForm({
  onVerify,
  submitLabel,
}: {
  onVerify: (code: string) => Promise<string | null>;
  submitLabel: string;
}) {
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    const parsed = codeSchema.safeParse(code.trim());
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Código inválido");
      return;
    }
    setBusy(true);
    const result = await onVerify(parsed.data);
    setBusy(false);
    setError(result);
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
      <TextField
        label="Código de 6 dígitos"
        inputMode="numeric"
        autoComplete="one-time-code"
        pattern="[0-9]{6}"
        maxLength={6}
        value={code}
        onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
        error={error}
        required
      />
      <Button type="submit" disabled={busy}>
        {busy ? "Verificando…" : submitLabel}
      </Button>
    </form>
  );
}

function SignOutLink() {
  const { signOut } = useAuth();
  return (
    <Button variant="fantasma" className="mt-4 w-full" onClick={() => void signOut()}>
      Cerrar sesión
    </Button>
  );
}

interface Enrollment {
  factorId: string;
  qr: string;
  secret: string;
}

/** Primer ingreso: enrolamiento obligatorio de un factor TOTP. */
export function MfaEnrollPage() {
  const supabase = useSupabase();
  const { refresh } = useAuth();
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null);
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void (async () => {
      try {
        // Se eliminan enrolamientos TOTP a medio terminar antes de empezar uno nuevo.
        const { data: factors } = await supabase.auth.mfa.listFactors();
        for (const factor of factors?.all ?? []) {
          if (factor.factor_type === "totp" && factor.status === "unverified") {
            await supabase.auth.mfa.unenroll({ factorId: factor.id });
          }
        }
        const { data, error: enrollError } = await supabase.auth.mfa.enroll({
          factorType: "totp",
          friendlyName: `Mesa de soporte Nexo ${new Date().toISOString().slice(0, 16)}`,
          issuer: "Yago Nexo",
        });
        if (enrollError) throw enrollError;
        const raw = data.totp.qr_code;
        const qr = raw.startsWith("data:") ? raw : `data:image/svg+xml;utf-8,${encodeURIComponent(raw)}`;
        setEnrollment({ factorId: data.id, qr, secret: data.totp.secret });
      } catch (err) {
        setError(friendlyError(err));
      }
    })();
  }, [supabase]);

  async function verify(code: string): Promise<string | null> {
    if (!enrollment) return "El enrolamiento no está listo";
    const { error: verifyError } = await supabase.auth.mfa.challengeAndVerify({
      factorId: enrollment.factorId,
      code,
    });
    if (verifyError)
      return "El código no es válido o expiró. Revise la hora del teléfono e intente de nuevo.";
    await refresh();
    return null;
  }

  return (
    <AuthFrame title="Configurar el segundo factor">
      <ol className="mb-4 list-decimal space-y-1 pl-5 text-sm text-slate-700">
        <li>
          Abra su aplicación de autenticación (por ejemplo, Google Authenticator, Microsoft Authenticator o
          FreeOTP).
        </li>
        <li>Escanee el código QR o ingrese la clave manualmente.</li>
        <li>Escriba el código de 6 dígitos que muestra la aplicación.</li>
      </ol>
      {error ? <Alert>{error}</Alert> : null}
      {!enrollment && !error ? <Spinner label="Preparando el código QR" /> : null}
      {enrollment ? (
        <div className="flex flex-col gap-4">
          <img
            src={enrollment.qr}
            alt="Código QR para registrar la Mesa de soporte Nexo en su aplicación de autenticación"
            className="mx-auto h-48 w-48"
          />
          <div>
            <p className="text-xs text-slate-600">Clave para ingreso manual:</p>
            <code className="block break-all rounded bg-slate-100 px-2 py-1 text-sm">
              {enrollment.secret}
            </code>
          </div>
          <CodeForm onVerify={verify} submitLabel="Activar y entrar" />
        </div>
      ) : null}
      <SignOutLink />
    </AuthFrame>
  );
}

/** Ingresos siguientes: desafío TOTP. */
export function MfaChallengePage() {
  const supabase = useSupabase();
  const { factorId, refresh } = useAuth();

  async function verify(code: string): Promise<string | null> {
    if (!factorId) return "No hay un segundo factor registrado";
    const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId, code });
    if (error) return "El código no es válido o expiró.";
    await refresh();
    return null;
  }

  return (
    <AuthFrame title="Verificación en dos pasos">
      <p className="mb-4 text-sm text-slate-700">
        Ingrese el código de 6 dígitos de su aplicación de autenticación.
      </p>
      <CodeForm onVerify={verify} submitLabel="Verificar" />
      <SignOutLink />
    </AuthFrame>
  );
}

export function NoAccessPage() {
  return (
    <AuthFrame title="Sin acceso a la mesa de soporte">
      <p className="text-sm text-slate-700">
        Su cuenta está activa, pero no pertenece a ninguna organización de la Mesa de soporte Nexo. Pida a su
        contraparte o a Yago que la habilite.
      </p>
      <SignOutLink />
    </AuthFrame>
  );
}

export function LoadingScreen() {
  return (
    <main className="flex min-h-screen items-center justify-center">
      <Spinner label="Cargando la mesa de soporte" />
    </main>
  );
}
