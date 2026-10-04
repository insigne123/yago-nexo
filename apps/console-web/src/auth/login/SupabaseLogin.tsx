import { KeyRound, LogIn, ShieldCheck, Smartphone } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Button } from "../../components/ui/Button";
import { Field, Input, Select } from "../../components/ui/Input";
import type { SupabaseAuthProvider, TotpEnrollment } from "../supabase";
import type { AuthSnapshot } from "../types";

const CODE = /^\d{6}$/;

function PasswordStep({ provider, error }: { provider: SupabaseAuthProvider; error?: string }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [local, setLocal] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!email.includes("@") || password.length === 0) {
      setLocal("Ingrese su correo y su contraseña.");
      return;
    }
    setLocal(null);
    setBusy(true);
    try {
      await provider.signIn(email.trim(), password);
    } finally {
      setBusy(false);
    }
  };

  const message = local ?? error;
  return (
    <form onSubmit={(e) => void submit(e)} noValidate className="space-y-4" data-testid="supabase-login">
      <Field id="login-email" label="Correo">
        {(control) => (
          <Input
            {...control}
            type="email"
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            data-testid="login-email"
          />
        )}
      </Field>
      <Field id="login-password" label="Contraseña">
        {(control) => (
          <Input
            {...control}
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            data-testid="login-password"
          />
        )}
      </Field>
      {message && (
        <p role="alert" className="rounded-md bg-bad-soft px-3 py-2 text-sm text-bad">
          {message}
        </p>
      )}
      <Button
        type="submit"
        variant="primary"
        className="w-full"
        loading={busy}
        icon={<LogIn className="size-4" aria-hidden="true" />}
        data-testid="btn-login"
      >
        Ingresar
      </Button>
    </form>
  );
}

function ChallengeStep({
  provider,
  snapshot,
}: {
  provider: SupabaseAuthProvider;
  snapshot: Extract<AuthSnapshot, { status: "mfa_challenge" }>;
}) {
  const [factorId, setFactorId] = useState(snapshot.factors[0]?.id ?? "");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [local, setLocal] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!CODE.test(code)) {
      setLocal("El código tiene 6 dígitos.");
      return;
    }
    setLocal(null);
    setBusy(true);
    try {
      await provider.verifyTotp(factorId, code);
    } finally {
      setBusy(false);
      setCode("");
    }
  };

  const message = local ?? snapshot.error;
  return (
    <form onSubmit={(e) => void submit(e)} noValidate className="space-y-4" data-testid="mfa-challenge">
      <p className="flex items-start gap-2 text-sm text-fg-muted">
        <Smartphone className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        Ingrese el código de 6 dígitos de su aplicación autenticadora
        {snapshot.email ? ` para ${snapshot.email}` : ""}.
      </p>
      {snapshot.factors.length > 1 && (
        <Field id="mfa-factor" label="Factor">
          {(control) => (
            <Select {...control} value={factorId} onChange={(e) => setFactorId(e.target.value)}>
              {snapshot.factors.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.friendlyName ?? f.id}
                </option>
              ))}
            </Select>
          )}
        </Field>
      )}
      <Field id="mfa-code" label="Código de verificación" error={message}>
        {(control) => (
          <Input
            {...control}
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
            className="font-mono tracking-[0.4em]"
            data-testid="mfa-code"
          />
        )}
      </Field>
      <div className="flex gap-2">
        <Button onClick={() => void provider.logout()}>Cancelar</Button>
        <Button
          type="submit"
          variant="primary"
          className="flex-1"
          loading={busy}
          icon={<ShieldCheck className="size-4" aria-hidden="true" />}
          data-testid="btn-verify-mfa"
        >
          Verificar
        </Button>
      </div>
    </form>
  );
}

function EnrollStep({
  provider,
  snapshot,
}: {
  provider: SupabaseAuthProvider;
  snapshot: Extract<AuthSnapshot, { status: "mfa_enroll" }>;
}) {
  const [enrollment, setEnrollment] = useState<TotpEnrollment | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      setEnrollment(await provider.startEnrollment());
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo iniciar el enrolamiento.");
    } finally {
      setBusy(false);
    }
  };

  const confirm = async (event: FormEvent) => {
    event.preventDefault();
    if (!enrollment) return;
    if (!CODE.test(code)) {
      setError("El código tiene 6 dígitos.");
      return;
    }
    setBusy(true);
    const failure = await provider.confirmEnrollment(enrollment.factorId, code);
    setBusy(false);
    if (failure) {
      setError(failure);
      setCode("");
    }
  };

  return (
    <div className="space-y-4" data-testid="mfa-enroll">
      <p className="text-sm text-fg">
        Esta Consola exige un segundo factor. Configure una aplicación autenticadora (por ejemplo Google
        Authenticator, Microsoft Authenticator o FreeOTP){snapshot.email ? ` para ${snapshot.email}` : ""}.
      </p>
      {!enrollment ? (
        <>
          {error && (
            <p role="alert" className="rounded-md bg-bad-soft px-3 py-2 text-sm text-bad">
              {error}
            </p>
          )}
          <div className="flex gap-2">
            <Button onClick={() => void provider.logout()}>Cancelar</Button>
            <Button
              variant="primary"
              className="flex-1"
              loading={busy}
              icon={<KeyRound className="size-4" aria-hidden="true" />}
              onClick={() => void start()}
              data-testid="btn-start-enroll"
            >
              Configurar el segundo factor
            </Button>
          </div>
        </>
      ) : (
        <form onSubmit={(e) => void confirm(e)} noValidate className="space-y-4">
          <ol className="list-decimal space-y-1 pl-5 text-sm text-fg-muted">
            <li>Escanee el código QR con la aplicación.</li>
            <li>Si no puede escanearlo, ingrese la clave manualmente.</li>
            <li>Escriba el código de 6 dígitos que muestra la aplicación.</li>
          </ol>
          <img
            src={enrollment.qrCode}
            alt="Código QR para configurar la aplicación autenticadora"
            className="mx-auto size-48 rounded-md bg-white p-2"
            data-testid="mfa-qr"
          />
          <Field id="mfa-secret" label="Clave para ingreso manual">
            {(control) => (
              <Input
                {...control}
                readOnly
                value={enrollment.secret}
                className="font-mono text-xs"
                onFocus={(e) => e.currentTarget.select()}
              />
            )}
          </Field>
          <Field id="mfa-enroll-code" label="Código de verificación" error={error ?? undefined}>
            {(control) => (
              <Input
                {...control}
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                className="font-mono tracking-[0.4em]"
                data-testid="mfa-enroll-code"
              />
            )}
          </Field>
          <div className="flex gap-2">
            <Button onClick={() => void provider.logout()}>Cancelar</Button>
            <Button
              type="submit"
              variant="primary"
              className="flex-1"
              loading={busy}
              icon={<ShieldCheck className="size-4" aria-hidden="true" />}
              data-testid="btn-confirm-enroll"
            >
              Activar y entrar
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}

/** Ingreso de la demo: correo y contraseña, más desafío TOTP o enrolamiento si corresponde. */
export function SupabaseLogin({
  provider,
  snapshot,
}: {
  provider: SupabaseAuthProvider;
  snapshot: AuthSnapshot;
}) {
  return (
    <div className="mx-auto max-w-md rounded-lg border border-line bg-surface p-6 shadow-xs">
      <h2 className="mb-4 text-base font-semibold text-fg">
        {snapshot.status === "mfa_challenge"
          ? "Verificación en dos pasos"
          : snapshot.status === "mfa_enroll"
            ? "Configure su segundo factor"
            : "Iniciar sesión"}
      </h2>
      {snapshot.status === "mfa_challenge" ? (
        <ChallengeStep provider={provider} snapshot={snapshot} />
      ) : snapshot.status === "mfa_enroll" ? (
        <EnrollStep provider={provider} snapshot={snapshot} />
      ) : (
        <PasswordStep
          provider={provider}
          error={snapshot.status === "anonymous" ? snapshot.error : undefined}
        />
      )}
    </div>
  );
}
