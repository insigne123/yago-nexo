import { Compass } from "lucide-react";
import { Link } from "react-router";
import { PageHeader } from "../components/PageHeader";
import { EmptyState } from "../components/ui/EmptyState";

export default function NotFoundPage() {
  return (
    <>
      <PageHeader title="Página no encontrada" />
      <EmptyState
        icon={<Compass className="size-7" />}
        title="La dirección no corresponde a ninguna sección de la Consola"
        action={
          <Link to="/" className="text-sm font-medium text-accent hover:underline">
            Volver al inicio
          </Link>
        }
      />
    </>
  );
}
